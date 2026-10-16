/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import './media/rubyStudioProjects.css';
import { $, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { IButton } from '../../../../base/browser/ui/button/button.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IDialogService, IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { createWorkbenchDialogOptions } from '../../../browser/parts/dialogs/dialog.js';
import { IJSONEditingService } from '../../../services/configuration/common/jsonEditing.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { IHostService } from '../../../services/host/browser/host.js';
interface ProjectDraft { name: string; parent: string; interpreter: string }
interface Validation { destination?: string; existing?: 'empty' | 'nonempty' | 'rails'; error?: string }
interface Candidates { parent: string; interpreters: string[] }
interface CreatedProject { destination: string; created: boolean; openExisting: boolean }

/** Native single-form project wizard; the extension owns Ruby and filesystem validation. */
export class RubyStudioProjectWizard {
	private showing = false;
	constructor(
		@ICommandService private readonly commands: ICommandService,
		@ILayoutService private readonly layout: ILayoutService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@IHostService private readonly host: IHostService,
		@IFileDialogService private readonly files: IFileDialogService,
		@IDialogService private readonly dialogs: IDialogService,
		@IFileService private readonly fileService: IFileService,
		@IJSONEditingService private readonly json: IJSONEditingService,
		@ITextFileService private readonly textFiles: ITextFileService,
		@INotificationService private readonly notifications: INotificationService,
	) { }
	private async execute<T>(command: string, ...args: (ProjectDraft | string)[]): Promise<T> {
		const result = await this.commands.executeCommand<T>(command, ...args);
		if (!result) { throw new Error(localize('projectServiceUnavailable', "The Ruby Project Service Is Unavailable. Reload the Window and Try Again.")); }
		return result;
	}
	async show(): Promise<void> {
		if (this.showing) { return; } this.showing = true;
		try {
			const candidates = await this.execute<Candidates>('rubyStudio.projectCandidates');
			const draft: ProjectDraft = { name: 'untitled', parent: candidates.parent, interpreter: candidates.interpreters[0] || '' };
			let suffix = 0;
			while (await this.fileService.exists(URI.joinPath(URI.file(draft.parent), draft.name))) { draft.name = `untitled${++suffix}`; }
			while (await this.form(draft, candidates)) {
				try {
					const validation = await this.execute<Validation>('rubyStudio.validateProject', draft);
					if (validation.error) { throw new Error(localize('projectValidation', "Project settings: {0}", validation.error)); }
					let decision: 'create' | 'open' | 'reject' = 'reject';
					if (validation.existing === 'nonempty' || validation.existing === 'rails') {
						const response = await this.dialogs.prompt<'create' | 'open'>({ type: 'question', message: localize('existingProject', "The Destination Already Contains Files"), detail: validation.destination, buttons: [
							{ label: localize('openExisting', "Open Existing"), run: () => 'open' },
							...(validation.existing === 'rails' ? [] : [{ label: localize('createHere', "Create Here"), run: (): 'create' => 'create' }])
						], cancelButton: true });
						if (!response.result) { continue; } decision = response.result;
					}
					const result = await this.execute<CreatedProject>('rubyStudio.createEmptyProject', draft, decision);
					const root = URI.file(result.destination);
					if (!result.openExisting) {
						const settingsFolder = URI.joinPath(root, '.vscode');
						if (this.textFiles.isDirty(URI.joinPath(settingsFolder, 'settings.json'))) { throw new Error(localize('dirtyProjectSettings', "Save the Existing Project Settings Before Creating Here.")); }
						await this.fileService.createFolder(settingsFolder);
						await this.json.write(URI.joinPath(settingsFolder, 'settings.json'), [
							{ path: ['rubyStudio.interpreterPath'], value: draft.interpreter },
							{ path: ['rubyStudio.testRoots'], value: ['features', 'spec', 'test'] }
						], true);
					}
					await this.host.openWindow([{ folderUri: root }]); return;
				} catch (error) { await this.dialogs.error(localize('projectCreationFailed', "Could Not Create or Open Project"), error instanceof Error ? error.message : String(error)); }
			}
		} catch (error) { this.notifications.error(error); } finally { this.showing = false; }
	}
	private async form(draft: ProjectDraft, candidates: Candidates): Promise<boolean> {
		const store = new DisposableStore(); let create: IButton | undefined; let active = true; let revision = 0; let timer: ReturnType<typeof setTimeout> | undefined;
		let error: HTMLElement; let preview: HTMLElement; let templateRequested = false; let cancelButton: IButton | undefined;
		const validate = async () => {
			const current = ++revision; if (create) { create.enabled = false; }
			try { const result = await this.execute<Validation>('rubyStudio.validateProject', { ...draft }); if (!active || current !== revision) { return; } preview.textContent = result.destination || ''; error.textContent = result.error ? localize('projectFieldError', "{0}", result.error) : ''; if (create) { create.enabled = !result.error; } }
			catch { if (active) { error.textContent = localize('validationFailed', "Project Validation Failed. Try Again."); } }
		};
		const schedule = () => { revision++; if (create) { create.enabled = false; } if (timer) { clearTimeout(timer); } timer = setTimeout(() => { void validate(); }, 150); };
		const dialog = store.add(new Dialog(this.layout.activeContainer, localize('newProject', "New Project"), [localize('createProject', "Create"), localize('cancel', "Cancel")], createWorkbenchDialogOptions({
			type: 'none', cancelId: 1, extraClasses: ['ruby-studio-project-dialog'],
			buttonOptions: [{ styleButton: button => { create = button; button.enabled = false; void validate(); } }, { styleButton: button => cancelButton = button }],
			renderBody: container => {
				const body = container.appendChild($('.ruby-project-form'));
				const type = body.appendChild($('div.ruby-project-types')); const heading = type.appendChild($('strong')); heading.textContent = localize('rubyProjects', "Ruby");
				const selected = type.appendChild($('div.selected')); selected.textContent = localize('emptyProject', "Empty Project");
				const template = type.appendChild($('button')); template.textContent = localize('otherTemplates', "Gem / Rails Templates…");
				store.add(addDisposableListener(template, EventType.CLICK, () => { templateRequested = true; cancelButton?.element.click(); }));
				const fields = body.appendChild($('.ruby-project-fields'));
				const field = (label: string, value: string, update: (value: string) => void) => {
					const row = fields.appendChild($('label.ruby-project-row')); row.appendChild($('span')).textContent = label;
					const input = row.appendChild($('input')) as HTMLInputElement; input.type = 'text'; input.value = value;
					store.add(addDisposableListener(input, EventType.INPUT, () => { update(input.value); schedule(); })); return { row, input };
				};
				field(localize('projectName', "Name"), draft.name, value => draft.name = value);
				const location = field(localize('projectLocation', "Location"), draft.parent, value => draft.parent = value);
				const browse = location.row.appendChild($('button')); browse.textContent = localize('browse', "Browse…");
				store.add(addDisposableListener(browse, EventType.CLICK, () => { void (async () => { const folders = await this.files.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, title: localize('chooseParent', "Choose Parent Directory") }); if (active && folders?.[0]?.scheme === 'file') { location.input.value = draft.parent = folders[0].fsPath; schedule(); } })().catch(error => this.notifications.error(error)); }));
				preview = fields.appendChild($('div.ruby-project-preview'));
				const sdk = fields.appendChild($('label.ruby-project-row')); sdk.appendChild($('span')).textContent = localize('rubySDK', "Ruby SDK");
				const select = sdk.appendChild($('select')) as HTMLSelectElement;
				const fill = () => { select.replaceChildren(); const empty = document.createElement('option'); empty.value = ''; empty.textContent = localize('selectSDK', "Select Ruby SDK"); select.appendChild(empty); for (const candidate of new Set([...candidates.interpreters, draft.interpreter].filter(Boolean))) { const option = document.createElement('option'); option.value = candidate; option.textContent = candidate; select.appendChild(option); } select.value = draft.interpreter; }; fill();
				store.add(addDisposableListener(select, EventType.CHANGE, () => { draft.interpreter = select.value; schedule(); }));
				const controls = fields.appendChild($('div.ruby-project-controls'));
				const addButton = (text: string, operation: () => Promise<void>) => { const button = controls.appendChild($('button')); button.textContent = text; store.add(addDisposableListener(button, EventType.CLICK, () => { void operation().catch(error => this.notifications.error(error)); })); };
				addButton(localize('addSDK', "Add SDK…"), async () => { const files = await this.files.showOpenDialog({ canSelectFiles: true, canSelectFolders: false, canSelectMany: false, title: localize('selectRuby', "Select Ruby Executable") }); if (active && files?.[0]?.scheme === 'file') { draft.interpreter = files[0].fsPath; fill(); schedule(); } });
				addButton(localize('refresh', "Refresh"), async () => { const refreshed = await this.execute<Candidates>('rubyStudio.projectCandidates'); if (active) { candidates.interpreters = refreshed.interpreters; fill(); schedule(); } });
				addButton(localize('installRuby', "Install Ruby…"), async () => { await this.commands.executeCommand('rubyStudio.installRuby'); });
				error = fields.appendChild($('div.ruby-project-error')); error.setAttribute('role', 'status'); error.setAttribute('aria-live', 'polite');
			}
		}, this.keybindings, this.layout, this.host)));
		try {
			const showing = dialog.show();
			const result = await showing;
			if (templateRequested) { void this.commands.executeCommand('rubyStudio.createTemplateProject'); }
			return result.button === 0 && !templateRequested;
		} finally { active = false; if (timer) { clearTimeout(timer); } store.dispose(); }
	}
}
