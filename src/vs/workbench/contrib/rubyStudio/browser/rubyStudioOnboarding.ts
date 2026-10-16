/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import './media/rubyStudioProjects.css';
import { $, addDisposableListener, EventType } from '../../../../base/browser/dom.js';
import { Dialog } from '../../../../base/browser/ui/dialog/dialog.js';
import { IButton } from '../../../../base/browser/ui/button/button.js';
import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { ILayoutService } from '../../../../platform/layout/browser/layoutService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkspacesService, isRecentFolder } from '../../../../platform/workspaces/common/workspaces.js';
import { createWorkbenchDialogOptions } from '../../../browser/parts/dialogs/dialog.js';
import { IHostService } from '../../../services/host/browser/host.js';
import { IOnboardingService } from '../../welcomeOnboarding/common/onboardingService.js';

/** Native welcome actions and recent projects use the workbench's window lifecycle. */
export class RubyStudioOnboarding extends Disposable implements IOnboardingService {
	declare readonly _serviceBrand: undefined;
	private readonly dismissed = this._register(new Emitter<void>());
	readonly onDidDismiss = this.dismissed.event;
	private showing = false;
	constructor(
		@ICommandService private readonly commands: ICommandService,
		@ILayoutService private readonly layout: ILayoutService,
		@IKeybindingService private readonly keybindings: IKeybindingService,
		@IHostService private readonly host: IHostService,
		@IWorkspacesService private readonly workspaces: IWorkspacesService,
		@IWorkspaceContextService private readonly workspace: IWorkspaceContextService,
		@INotificationService private readonly notifications: INotificationService,
	) { super(); }
	show(): void { void this.open().catch(error => this.notifications.error(error)); }
	private async open(): Promise<void> {
		if (this.showing) { return; } this.showing = true;
		try {
			do {
				const recents = (await this.workspaces.getRecentlyOpened()).workspaces.slice(0, 8);
				const store = new DisposableStore(); let recentIndex = -1; let close: IButton | undefined;
				const dialog = store.add(new Dialog(this.layout.activeContainer, localize('welcome', "Welcome to Ruby Studio"), [localize('newProject', "New Project"), localize('open', "Open…"), localize('close', "Close")], createWorkbenchDialogOptions({
					type: 'none', cancelId: 2, extraClasses: ['ruby-studio-welcome-dialog'], buttonOptions: [undefined, undefined, { styleButton: button => close = button }],
					renderBody: container => {
						const body = container.appendChild($('.ruby-project-welcome'));
						body.appendChild($('p')).textContent = localize('welcomeDetail', "Open a Ruby project or create an empty project with your Ruby SDK.");
						if (recents.length) {
							body.appendChild($('h3')).textContent = localize('recentProjects', "Recent Projects");
							for (const [index, recent] of recents.entries()) {
								const uri = isRecentFolder(recent) ? recent.folderUri : recent.workspace.configPath;
								const button = body.appendChild($('button.recent-project')); button.textContent = recent.label || uri.fsPath || uri.toString();
								store.add(addDisposableListener(button, EventType.CLICK, () => { recentIndex = index; close?.element.click(); }));
							}
						}
					}
				}, this.keybindings, this.layout, this.host)));
				let button: number;
				try { ({ button } = await dialog.show()); } finally { store.dispose(); }
				if (recentIndex >= 0) { const recent = recents[recentIndex]; await this.host.openWindow([isRecentFolder(recent) ? { folderUri: recent.folderUri } : { workspaceUri: recent.workspace.configPath }], { remoteAuthority: recent.remoteAuthority }); return; }
				if (button === 0) { await this.commands.executeCommand('rubyStudio.createProject'); }
				else if (button === 1) { await this.commands.executeCommand('workbench.action.files.openFolder'); }
				else { return; }
			} while (this.workspace.getWorkbenchState() === WorkbenchState.EMPTY);
		} finally { this.showing = false; this.dismissed.fire(); }
	}
}
