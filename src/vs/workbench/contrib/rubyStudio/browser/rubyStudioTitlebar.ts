/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/rubyStudioTitlebar.css';
import { $, addDisposableListener, append, EventType, getWindow } from '../../../../base/browser/dom.js';
import { StandardKeyboardEvent } from '../../../../base/browser/keyboardEvent.js';
import { BaseActionViewItem, IBaseActionViewItemOptions } from '../../../../base/browser/ui/actionbar/actionViewItems.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IAction } from '../../../../base/common/actions.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toErrorMessage } from '../../../../base/common/errorMessage.js';
import { KeyCode } from '../../../../base/common/keyCodes.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { isCodeEditor, isDiffEditor } from '../../../../editor/browser/editorBrowser.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { ILabelService, Verbosity } from '../../../../platform/label/common/label.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../platform/workspace/common/workspaceTrust.js';
import { EditorResourceAccessor, SideBySideEditor } from '../../../common/editor.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

interface IRubyStudioControl {
	readonly command: string;
	readonly label: string;
	readonly button: HTMLButtonElement;
	readonly caption: HTMLElement | undefined;
	readonly executesCode: boolean;
}

/**
 * Renders an original Ruby Studio toolbar inside the existing workbench titlebar.
 * The titlebar owns this view item and disposes it when its menu is rebuilt.
 */
export class RubyStudioTitlebarViewItem extends BaseActionViewItem {

	private readonly controls: IRubyStudioControl[] = [];
	private readonly pendingCommands = new Set<string>();
	private readonly editorListeners = this._register(new DisposableStore());
	private projectLabel: HTMLElement | undefined;
	private configurationControl: IRubyStudioControl | undefined;
	private interpreterControl: IRubyStudioControl | undefined;
	private focusable = false;
	private disposed = false;

	constructor(
		action: IAction,
		options: IBaseActionViewItemOptions,
		@ICommandService private readonly commandService: ICommandService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IEditorService private readonly editorService: IEditorService,
		@IHoverService private readonly hoverService: IHoverService,
		@ILabelService private readonly labelService: ILabelService,
		@INotificationService private readonly notificationService: INotificationService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly workspaceTrustService: IWorkspaceTrustManagementService,
	) {
		super(undefined, action, options);

		this._register(this.configurationService.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('rubyStudio.interpreterPath') || event.affectsConfiguration('rubyStudio.runConfiguration')) {
				this.updateControls();
			}
		}));
		this._register(this.contextKeyService.onDidChangeContext(event => {
			if (event.affectsSome(new Set(['rubyStudio.isRunning', 'rubyStudio.isTesting']))) {
				this.updateControls();
			}
		}));
		this._register(this.editorService.onDidActiveEditorChange(() => this.onEditorChange()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceName(() => this.updateControls()));
		this._register(this.workspaceContextService.onDidChangeWorkbenchState(() => this.updateControls()));
		this._register(this.workspaceContextService.onDidChangeWorkspaceFolders(() => this.updateControls()));
		this._register(this.workspaceTrustService.onDidChangeTrust(() => this.updateControls()));
		this._register(this.labelService.onDidChangeFormatters(() => this.updateControls()));
	}

	override render(container: HTMLElement): void {
		// This composite supplies its own button listeners rather than running the parent action.
		this.element = container;
		container.classList.add('ruby-studio-titlebar');
		container.setAttribute('role', 'group');
		container.setAttribute('aria-label', localize('rubyStudio.runControls', "Ruby Studio Run Controls"));

		const identity = append(container, $('.ruby-studio-identity'));
		const logo = append(identity, $('span.ruby-studio-logo'));
		logo.classList.add(...ThemeIcon.asClassNameArray(Codicon.ruby));
		logo.setAttribute('aria-hidden', 'true');
		append(identity, $('span.ruby-studio-wordmark')).textContent = localize('rubyStudio.name', "Ruby Studio");
		this.projectLabel = append(identity, $('span.ruby-studio-project'));
		this._register(this.hoverService.setupDelayedHover(identity, () => ({
			content: this.getProjectHover(),
			position: { hoverPosition: HoverPosition.BELOW },
		})));

		this.configurationControl = this.createControl(container, 'rubyStudio.pickConfiguration', localize('rubyStudio.pickConfiguration', "Run Configuration"), Codicon.chevronDown, 'configuration', true);
		const execution = append(container, $('.ruby-studio-execution'));
		this.createControl(execution, 'rubyStudio.runSelected', localize('rubyStudio.runSelected', "Run Selected Configuration or Current File"), Codicon.play, 'run', false, true);
		this.createControl(execution, 'rubyStudio.debugSelected', localize('rubyStudio.debugSelected', "Debug Selected Configuration or Current File"), Codicon.debugAlt, 'debug', false, true);
		this.createControl(execution, 'rubyStudio.runTests', localize('rubyStudio.runTests', "Run Tests"), Codicon.beaker, 'tests', false, true);
		this.createControl(execution, 'rubyStudio.stop', localize('rubyStudio.stop', "Stop"), Codicon.debugStop, 'stop');
		this.createControl(container, 'rubyStudio.railsConsole', localize('rubyStudio.railsConsole', "Rails Console"), Codicon.terminal, 'console', false, true);
		this.interpreterControl = this.createControl(container, 'rubyStudio.selectInterpreter', localize('rubyStudio.selectInterpreter', "Select Ruby SDK"), Codicon.ruby, 'interpreter', true);

		this._register(addDisposableListener(container, EventType.KEY_DOWN, event => this.onKeyDown(event)));
		this._register(addDisposableListener(container, EventType.KEY_UP, event => {
			const key = new StandardKeyboardEvent(event);
			if (key.equals(KeyCode.Enter) || key.equals(KeyCode.Space)) {
				// Native buttons handle activation; do not also trigger the parent action bar.
				key.stopPropagation();
			}
		}));
		this.onEditorChange();
	}

	/** Creates an accessible native button bound to a real Ruby Studio extension command. */
	private createControl(parent: HTMLElement, command: string, label: string, icon: ThemeIcon, kind: string, showCaption = false, executesCode = false): IRubyStudioControl {
		const button = append(parent, $('button.ruby-studio-control')) as HTMLButtonElement;
		button.type = 'button';
		button.tabIndex = -1;
		button.classList.add(`ruby-studio-${kind}`);
		button.setAttribute('data-command', command);
		button.setAttribute('aria-label', label);
		const iconElement = append(button, $('span.ruby-studio-control-icon'));
		iconElement.classList.add(...ThemeIcon.asClassNameArray(icon));
		iconElement.setAttribute('aria-hidden', 'true');
		const caption = showCaption ? append(button, $('span.ruby-studio-control-caption')) : undefined;
		const control = { command, label, button, caption, executesCode };
		this.controls.push(control);
		this._register(addDisposableListener(button, EventType.CLICK, event => {
			event.stopPropagation();
			void this.execute(control);
		}));
		this._register(addDisposableListener(button, EventType.FOCUS, () => {
			for (const other of this.controls) {
				other.button.tabIndex = other === control ? 0 : -1;
			}
		}));
		this._register(this.hoverService.setupDelayedHover(button, () => ({
			content: this.getControlHover(control),
			position: { hoverPosition: HoverPosition.BELOW },
		})));
		return control;
	}

	/** Keeps current-file enablement in sync with changes to the editor or its language. */
	private onEditorChange(): void {
		this.editorListeners.clear();
		const control = this.editorService.activeTextEditorControl;
		const editor = isDiffEditor(control) ? control.getModifiedEditor() : isCodeEditor(control) ? control : undefined;
		if (editor) {
			this.editorListeners.add(editor.onDidChangeModelLanguage(() => this.updateControls()));
		}
		this.updateControls();
	}

	/** Reads application state without inventing an SDK version or running-process status. */
	private updateControls(): void {
		if (!this.element || this.disposed) {
			return;
		}

		const workspace = this.workspaceContextService.getWorkspace();
		const hasProject = this.workspaceContextService.getWorkbenchState() !== WorkbenchState.EMPTY;
		if (this.projectLabel) {
			this.projectLabel.textContent = hasProject ? this.labelService.getWorkspaceLabel(workspace, { verbose: Verbosity.SHORT }) : localize('rubyStudio.noProject', "No Project");
		}

		const uri = EditorResourceAccessor.getOriginalUri(this.editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY });
		const configuration = this.configurationService.getValue<string>('rubyStudio.runConfiguration', { resource: uri })?.trim();
		if (this.configurationControl?.caption) {
			this.configurationControl.caption.textContent = configuration || localize('rubyStudio.currentFile', "Current File");
			this.configurationControl.button.setAttribute('aria-label', localize('rubyStudio.configurationAria', "Run Configuration: {0}", this.configurationControl.caption.textContent));
		}
		const interpreter = this.configurationService.getValue<string>('rubyStudio.interpreterPath', { resource: EditorResourceAccessor.getOriginalUri(this.editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY }) })?.trim();
		if (this.interpreterControl?.caption) {
			const name = interpreter?.split(/[\\/]/).filter(Boolean).at(-1);
			this.interpreterControl.caption.textContent = name ? localize('rubyStudio.sdkName', "SDK: {0}", name) : localize('rubyStudio.selectSdk', "Select SDK");
			this.interpreterControl.button.setAttribute('aria-label', interpreter ? localize('rubyStudio.sdkAria', "Select Ruby SDK: {0}", interpreter) : this.interpreterControl.label);
		}

		const isRuby = this.editorService.activeTextEditorLanguageId === 'ruby' || !!uri?.path.toLowerCase().endsWith('.rb');
		const running = this.contextKeyService.getContextKeyValue<boolean>('rubyStudio.isRunning') === true || this.contextKeyService.getContextKeyValue<boolean>('rubyStudio.isTesting') === true;
		const launching = ['rubyStudio.runSelected', 'rubyStudio.debugSelected', 'rubyStudio.runTests'].some(command => this.pendingCommands.has(command));
		const trusted = this.workspaceTrustService.isWorkspaceTrusted();
		for (const control of this.controls) {
			let enabled = !this.pendingCommands.has(control.command);
			if (control.command === 'rubyStudio.stop') {
				enabled &&= running;
			} else if (control.command === 'rubyStudio.runSelected' || control.command === 'rubyStudio.debugSelected') {
				enabled &&= (isRuby || !!configuration) && trusted && !running && !launching;
			} else if (control.command === 'rubyStudio.runTests') {
				enabled &&= hasProject && trusted && !running && !launching;
			} else if (control.command === 'rubyStudio.railsConsole') {
				enabled &&= hasProject && trusted;
			}
			control.button.disabled = !enabled;
			control.button.setAttribute('aria-busy', String(this.pendingCommands.has(control.command)));
		}
		this.element.classList.toggle('ruby-studio-running', running);
		this.setFocusable(this.focusable);
	}

	private getProjectHover(): string {
		if (this.workspaceContextService.getWorkbenchState() === WorkbenchState.EMPTY) {
			return localize('rubyStudio.emptyProjectHover', "Ruby Studio — No Project Open");
		}
		return localize('rubyStudio.projectHover', "Ruby Studio — {0}", this.labelService.getWorkspaceLabel(this.workspaceContextService.getWorkspace(), { verbose: Verbosity.LONG }));
	}

	private getControlHover(control: IRubyStudioControl): string {
		if (control.executesCode && !this.workspaceTrustService.isWorkspaceTrusted()) {
			return localize('rubyStudio.trustWorkspace', "{0} — Trust the Workspace to Run Ruby Code", control.label);
		}
		if (control === this.interpreterControl) {
			const interpreter = this.configurationService.getValue<string>('rubyStudio.interpreterPath', { resource: EditorResourceAccessor.getOriginalUri(this.editorService.activeEditor, { supportSideBySide: SideBySideEditor.PRIMARY }) })?.trim();
			return interpreter ? localize('rubyStudio.interpreterHover', "Select Ruby SDK — {0}", interpreter) : control.label;
		}
		if (control === this.configurationControl) {
			return localize('rubyStudio.configurationHover', "Run Configuration — {0}", control.caption?.textContent || localize('rubyStudio.currentFile', "Current File"));
		}
		return control.label;
	}

	/** Runs through the command service so built-in extension activation and errors are handled. */
	private async execute(control: IRubyStudioControl): Promise<void> {
		if (control.button.disabled || this.pendingCommands.has(control.command)) {
			return;
		}
		this.pendingCommands.add(control.command);
		this.updateControls();
		try {
			await this.commandService.executeCommand(control.command);
		} catch (error) {
			if (!this.disposed) {
				this.notificationService.error(localize('rubyStudio.commandError', "{0}: {1}", control.label, toErrorMessage(error)));
			}
		} finally {
			this.pendingCommands.delete(control.command);
			this.updateControls();
		}
	}

	/** Keeps arrow navigation within the composite until the native action-bar boundary. */
	private onKeyDown(event: KeyboardEvent): void {
		const key = new StandardKeyboardEvent(event);
		if (key.equals(KeyCode.Enter) || key.equals(KeyCode.Space)) {
			key.stopPropagation();
			return;
		}
		const buttons = this.controls.filter(control => !control.button.disabled).map(control => control.button);
		const index = buttons.findIndex(button => button === getWindow(button).document.activeElement);
		let target: HTMLButtonElement | undefined;
		if (key.equals(KeyCode.RightArrow)) {
			target = buttons[index + 1];
		} else if (key.equals(KeyCode.LeftArrow)) {
			target = buttons[index - 1];
		} else if (key.equals(KeyCode.Home)) {
			target = buttons[0];
		} else if (key.equals(KeyCode.End)) {
			target = buttons.at(-1);
		}
		if (target) {
			key.preventDefault();
			key.stopPropagation();
			target.focus();
		}
	}

	override focus(fromRight = false): void {
		const buttons = this.controls.filter(control => !control.button.disabled).map(control => control.button);
		const target = fromRight ? buttons.at(-1) : buttons[0];
		target?.focus();
	}

	override blur(): void {
		for (const control of this.controls) {
			control.button.tabIndex = -1;
			control.button.blur();
		}
	}

	override setFocusable(focusable: boolean): void {
		this.focusable = focusable;
		const focused = this.controls.find(control => !control.button.disabled && control.button === getWindow(control.button).document.activeElement);
		const target = focusable ? focused || this.controls.find(control => !control.button.disabled) : undefined;
		for (const control of this.controls) {
			control.button.tabIndex = control === target ? 0 : -1;
		}
	}

	override dispose(): void {
		this.disposed = true;
		super.dispose();
	}
}
