/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IOnboardingService } from '../../welcomeOnboarding/common/onboardingService.js';

/** Offers Ruby project entry points through the native workbench quick picker. */
export class RubyStudioOnboarding extends Disposable implements IOnboardingService {
	declare readonly _serviceBrand: undefined;
	private readonly dismissed = this._register(new Emitter<void>());
	readonly onDidDismiss = this.dismissed.event;
	private showing = false;

	constructor(
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@ICommandService private readonly commandService: ICommandService,
	) { super(); }

	show(): void { void this.open(); }

	private async open(): Promise<void> {
		if (this.showing) { return; }
		this.showing = true;
		try {
			const selected = await this.quickInputService.pick([
				{ label: localize('rubyStudio.newProject', "New Ruby Project"), command: 'rubyStudio.createProject' },
				{ label: localize('rubyStudio.openProject', "Open Project Folder"), command: 'workbench.action.files.openFolder' },
				{ label: localize('rubyStudio.selectInterpreter', "Select Ruby Interpreter"), command: 'rubyStudio.selectInterpreter' },
			], { title: localize('rubyStudio.welcome', "Welcome to Ruby Studio"), placeHolder: localize('rubyStudio.chooseProject', "Choose a Project to Start Coding") });
			if (selected) { await this.commandService.executeCommand(selected.command); }
		} finally { this.showing = false; this.dismissed.fire(); }
	}
}
