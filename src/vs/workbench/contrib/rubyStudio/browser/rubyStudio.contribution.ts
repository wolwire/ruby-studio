/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IActionViewItemService } from '../../../../platform/actions/browser/actionViewItemService.js';
import { Action2, registerAction2, MenuId, MenuRegistry } from '../../../../platform/actions/common/actions.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { TitleBarLeadingActionsGroup } from '../../../browser/parts/titlebar/titlebarActions.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { RubyStudioTitlebarViewItem } from './rubyStudioTitlebar.js';
import { RubyStudioOnboarding } from './rubyStudioOnboarding.js';
import { RubyStudioProjectWizard } from './rubyStudioProjectWizard.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize2 } from '../../../../nls.js';
import { IOnboardingService } from '../../welcomeOnboarding/common/onboardingService.js';

registerSingleton(IOnboardingService, RubyStudioOnboarding, InstantiationType.Delayed);

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerDefaultConfigurations([{
	overrides: {
		'window.titleBarStyle': 'custom',
		'window.menuBarVisibility': 'classic',
		'window.commandCenter': false,
		'telemetry.telemetryLevel': 'off',
		'chat.disableAIFeatures': true,
		'workbench.welcomePage.experimentalOnboarding': false,
		'workbench.startupEditor': 'none',
	},
}]);

/**
 * Contributes Ruby run controls through the native titlebar menu and view-item lifecycle.
 */
class RubyStudioTitlebarContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.rubyStudio.titlebar';

	constructor(
		@IActionViewItemService actionViewItemService: IActionViewItemService,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();

		this._register(actionViewItemService.register(MenuId.TitleBar, 'rubyStudio.pickConfiguration', (action, options) => {
			return instantiationService.createInstance(RubyStudioTitlebarViewItem, action, options);
		}));

		// A real extension command also gives the native overflow menu a useful fallback.
		this._register(MenuRegistry.appendMenuItem(MenuId.TitleBar, {
			command: {
				id: 'rubyStudio.pickConfiguration',
				title: localize('rubyStudio.runConfiguration', "Ruby Studio Run Configuration"),
				icon: Codicon.ruby,
			},
			group: TitleBarLeadingActionsGroup,
			order: -2000,
		}));
	}
}

registerWorkbenchContribution2(RubyStudioTitlebarContribution.ID, RubyStudioTitlebarContribution, WorkbenchPhase.AfterRestored);

registerAction2(class extends Action2 {
	constructor() { super({ id: 'rubyStudio.createProject', title: localize2('newRubyProject', "New Ruby Project"), f1: true }); }
	run(accessor: ServicesAccessor): Promise<void> { return accessor.get(IInstantiationService).createInstance(RubyStudioProjectWizard).show(); }
});
registerAction2(class extends Action2 {
	constructor() { super({ id: 'rubyStudio.welcome', title: localize2('rubyWelcome', "Ruby Studio Welcome"), f1: true }); }
	run(accessor: ServicesAccessor): void { accessor.get(IOnboardingService).show(); }
});
