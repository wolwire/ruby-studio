/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { RuntimeService } from './runtime';
import { ProjectEnvironmentService } from './projectEnvironment';
import { registerExecution } from './execution';
import { registerDebugging } from './debug';
import { registerLanguage } from './language';
import { registerTesting } from './testing';
import { registerRails } from './rails';
import { registerDependencies } from './dependencies';
import { registerHttp } from './http';
import { registerDatabase } from './database';
import { registerSettings } from './settings';

/** Activates the original Ruby tooling that is bundled with the application. */
export function activate(context: vscode.ExtensionContext): void {
	const runtime = new RuntimeService(context);
	const environments = new ProjectEnvironmentService(context, runtime);
	context.subscriptions.push(environments);
	context.subscriptions.push(runtime, vscode.commands.registerCommand('rubyStudio.selectInterpreter', () => runtime.select()));
	context.subscriptions.push(...registerSettings(context, runtime), ...registerDebugging(context, runtime), ...registerExecution(context, runtime), ...registerLanguage(context, runtime, environments), ...registerTesting(context, runtime), ...registerRails(context, runtime), ...registerDependencies(context, runtime, environments), ...registerHttp(), ...registerDatabase(context));
}
