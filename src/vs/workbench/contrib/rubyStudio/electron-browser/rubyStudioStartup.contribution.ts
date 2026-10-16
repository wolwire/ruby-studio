/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { IWorkspaceContextService, WorkbenchState } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INativeWorkbenchEnvironmentService } from '../../../services/environment/electron-browser/environmentService.js';
import { ILifecycleService, StartupKind } from '../../../services/lifecycle/common/lifecycle.js';
import { IOnboardingService } from '../../welcomeOnboarding/common/onboardingService.js';

/** Show project entry actions on app startup, including restored project windows. */
class RubyStudioStartupContribution implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.rubyStudio.startup';
	constructor(
		@INativeWorkbenchEnvironmentService environment: INativeWorkbenchEnvironmentService,
		@ILifecycleService lifecycle: ILifecycleService,
		@IWorkspaceContextService workspace: IWorkspaceContextService,
		@IOnboardingService onboarding: IOnboardingService,
	) {
		if (!environment.skipWelcome && !environment.extensionTestsLocationURI
			&& lifecycle.startupKind !== StartupKind.ReloadedWindow
			&& (environment.window.isInitialStartup || workspace.getWorkbenchState() === WorkbenchState.EMPTY)) {
			onboarding.show();
		}
	}
}

registerWorkbenchContribution2(RubyStudioStartupContribution.ID, RubyStudioStartupContribution, WorkbenchPhase.AfterRestored);
