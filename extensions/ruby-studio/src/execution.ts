/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { RuntimeService, RuntimeInfo, expandRuntimeValue, normalizeRubyArguments } from './runtime';

/** A saved, user-selected Ruby task configuration. */
export interface RubyRunConfiguration {
	name: string;
	type: 'ruby' | 'rails' | 'rake' | 'rspec';
	script?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	bundle?: boolean;
}

/** Process arguments stay arrays all the way into VS Code ProcessExecution. */
export interface RunPlan { name: string; executable: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; script?: string }

/** Validate a configuration document without executing its contents. */
export function parseRunConfigurations(text: string): RubyRunConfiguration[] {
	const parsed = JSON.parse(text) as { configurations?: RubyRunConfiguration[] } | RubyRunConfiguration[];
	const configurations = Array.isArray(parsed) ? parsed : parsed?.configurations;
	if (!Array.isArray(configurations)) { throw new Error('Expected a configurations array in .ruby-studio/run-configurations.json.'); }
	const names = new Set<string>();
	for (const configuration of configurations) {
		if (!configuration || typeof configuration.name !== 'string' || !configuration.name.trim() || !['ruby', 'rails', 'rake', 'rspec'].includes(configuration.type)) {
			throw new Error('Each run configuration needs a name and a ruby, rails, rake or rspec type.');
		}
		if (names.has(configuration.name)) { throw new Error(`Duplicate run configuration: ${configuration.name}`); }
		names.add(configuration.name);
		if (configuration.args !== undefined && (!Array.isArray(configuration.args) || configuration.args.some(argument => typeof argument !== 'string'))) { throw new Error('Run arguments must be an array of strings.'); }
		if (configuration.env !== undefined && (typeof configuration.env !== 'object' || configuration.env === null || Array.isArray(configuration.env) || Object.entries(configuration.env).some(([key, value]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== 'string'))) { throw new Error('Run environment variables must be string values with valid names.'); }
		if (configuration.cwd !== undefined && typeof configuration.cwd !== 'string') { throw new Error('The working directory must be a string.'); }
		if (configuration.script !== undefined && typeof configuration.script !== 'string') { throw new Error('The script must be a string.'); }
		if (configuration.bundle !== undefined && typeof configuration.bundle !== 'boolean') { throw new Error('The bundle option must be true or false.'); }
	}
	return configurations;
}

/** Resolve SDK, cwd, environment and tool arguments before starting a task. */
export async function buildRunPlan(configuration: RubyRunConfiguration, sdk: RuntimeInfo, activeFile?: string): Promise<RunPlan> {
	parseRunConfigurations(JSON.stringify([configuration]));
	const expand = (value: string) => expandRuntimeValue(value, sdk.cwd, sdk.env, activeFile);
	const cwd = path.resolve(sdk.cwd, expand(configuration.cwd || sdk.cwd));
	if (!(await fs.stat(cwd)).isDirectory()) { throw new Error('The run working directory does not exist.'); }
	const env = { ...sdk.env, ...Object.fromEntries(Object.entries(configuration.env || {}).map(([key, value]) => [key, expand(value)])) };
	const args = (configuration.args || []).map(expand);
	let rubyArgs: string[];
	let script: string | undefined;
	if (configuration.type === 'ruby') {
		script = path.resolve(cwd, expand(configuration.script || activeFile || ''));
		if (!configuration.script && !activeFile) { throw new Error('Select a Ruby script to run.'); }
		if (!(await fs.stat(script)).isFile()) { throw new Error('The Ruby script does not exist.'); }
		rubyArgs = [script, ...args];
	} else if (configuration.type === 'rails') {
		const bin = path.resolve(cwd, expand(configuration.script || 'bin/rails'));
		try { if (!(await fs.stat(bin)).isFile()) { throw new Error('Not a file'); } rubyArgs = [bin, ...args]; }
		catch { if (configuration.script) { throw new Error('The Rails entry script does not exist.'); } rubyArgs = ['-S', 'rails', ...args]; }
	} else {
		rubyArgs = ['-S', configuration.type, ...(configuration.script ? [expand(configuration.script)] : []), ...args];
	}
	rubyArgs = normalizeRubyArguments(rubyArgs);
	if (configuration.bundle) {
		try { await fs.access(path.join(cwd, 'Gemfile')); } catch { throw new Error('Bundler was selected, but this working directory has no Gemfile.'); }
		rubyArgs = normalizeRubyArguments(['-S', 'bundle', 'exec', sdk.ruby, ...rubyArgs]);
	}
	return { name: configuration.name, executable: sdk.ruby, args: rubyArgs, cwd, env, script };
}

/** Register the save/validate/SDK/cwd/runner pipeline and its native UI commands. */
export function registerExecution(_context: vscode.ExtensionContext, runtime: RuntimeService): vscode.Disposable[] {
	const api: typeof vscode = require('vscode');
	const disposables: vscode.Disposable[] = [];
	const output = api.window.createOutputChannel('Ruby Studio');
	disposables.push(output);
	const tasks = new Set<vscode.TaskExecution>();
	const debugSessions = new Map<string, vscode.DebugSession>();
	const updateRunning = () => { void api.commands.executeCommand('setContext', 'rubyStudio.isRunning', tasks.size > 0 || debugSessions.size > 0); };
	disposables.push(api.tasks.onDidStartTask(event => { if (event.execution.task.definition.type === 'rubyStudio') { tasks.add(event.execution); updateRunning(); } }));
	disposables.push(api.tasks.onDidEndTask(event => { tasks.delete(event.execution); updateRunning(); }));
	disposables.push(api.debug.onDidStartDebugSession(session => { if (session.type === 'rubyStudio') { debugSessions.set(session.id, session); updateRunning(); } }));
	disposables.push(api.debug.onDidTerminateDebugSession(session => { debugSessions.delete(session.id); updateRunning(); }));
	updateRunning();
	const register = (name: string, action: (...args: string[]) => Promise<void>) => {
		disposables.push(api.commands.registerCommand(name, async (...args: string[]) => {
			try { await action(...args); }
			catch (error) { const message = error instanceof Error ? error.message : String(error); output.appendLine(message); await api.window.showErrorMessage(api.l10n.t('Ruby Studio: {0}', message)); }
		}));
	};
	const save = async () => {
		if (!api.workspace.isTrusted) { throw new Error(api.l10n.t('Trust this workspace before running Ruby.')); }
		if (!await api.workspace.saveAll(false)) { throw new Error(api.l10n.t('Save all files before running.')); }
	};
	const current = async () => {
		const document = api.window.activeTextEditor?.document;
		if (!document || document.languageId !== 'ruby') { throw new Error(api.l10n.t('Open a Ruby file first.')); }
		if (document.isUntitled && !await document.save()) { throw new Error(api.l10n.t('Save the Ruby file before running.')); }
		await save();
		if (document.uri.scheme !== 'file') { throw new Error(api.l10n.t('Run requires a local Ruby file.')); }
		const folder = api.workspace.getWorkspaceFolder(document.uri);
		const sdk = await runtime.get(folder);
		const plan = await buildRunPlan({ name: path.basename(document.uri.fsPath), type: 'ruby', script: document.uri.fsPath }, sdk);
		return { folder, sdk, plan };
	};
	const configurationFile = async (folder: vscode.WorkspaceFolder): Promise<vscode.Uri> => {
		const uri = api.Uri.joinPath(folder.uri, '.ruby-studio', 'run-configurations.json');
		try { await fs.access(uri.fsPath); }
		catch {
			await fs.mkdir(path.dirname(uri.fsPath), { recursive: true });
			await fs.writeFile(uri.fsPath, JSON.stringify({ version: 1, configurations: [{ name: 'Main', type: 'ruby', script: 'main.rb', args: [], env: {}, cwd: '${workspaceFolder}', bundle: false }] }, null, '\t') + '\n', { flag: 'wx' });
		}
		return uri;
	};
	const choose = async (requested?: string): Promise<{ folder: vscode.WorkspaceFolder; configuration: RubyRunConfiguration } | undefined> => {
		const folder = await runtime.folder();
		if (!folder) { throw new Error(api.l10n.t('Open a project folder first.')); }
		const uri = await configurationFile(folder);
		const configurations = parseRunConfigurations(await fs.readFile(uri.fsPath, 'utf8'));
		const selectedName = requested === '' ? undefined : requested || api.workspace.getConfiguration('rubyStudio', folder.uri).get<string>('runConfiguration');
		let configuration = selectedName && configurations.find(item => item.name === selectedName);
		if (!configuration) {
			const edit = { label: api.l10n.t('Edit Run Configurations…'), description: '.ruby-studio/run-configurations.json' };
			const selected = await api.window.showQuickPick([...configurations.map(item => ({ label: item.name, description: item.type })), edit], { title: api.l10n.t('Ruby Run Configuration') });
			if (!selected) { return undefined; }
			if (selected === edit) { await api.commands.executeCommand('rubyStudio.editRunConfigurations'); return undefined; }
			configuration = configurations.find(item => item.name === selected.label);
		}
		if (!configuration) { return undefined; }
		await api.workspace.getConfiguration('rubyStudio', folder.uri).update('runConfiguration', configuration.name, api.ConfigurationTarget.WorkspaceFolder);
		return { folder, configuration };
	};
	const runCurrent = async () => { const { folder, plan } = await current(); await runtime.task(plan.name, plan.executable, plan.args, folder, plan); };
	const debugPlan = async (folder: vscode.WorkspaceFolder | undefined, plan: RunPlan) => {
		if (!plan.script) { throw new Error(api.l10n.t('Choose a Ruby script configuration to debug.')); }
		const index = plan.args.indexOf(plan.script);
		if (!await api.debug.startDebugging(folder, { type: 'rubyStudio', request: 'launch', name: plan.name, script: plan.script, args: plan.args.slice(index + 1), rubyArgs: plan.args.slice(0, index), cwd: plan.cwd, env: plan.env, stopOnEntry: false })) { throw new Error(api.l10n.t('The Ruby debugger could not start.')); }
	};
	const debugCurrent = async () => {
		const { folder, plan } = await current();
		await debugPlan(folder, plan);
	};
	const runConfiguration = async (name?: string, debug = false) => {
		await save(); const selected = await choose(name); if (!selected) { return; }
		const sdk = await runtime.get(selected.folder);
		const active = api.window.activeTextEditor?.document.uri;
		const plan = await buildRunPlan(selected.configuration, sdk, active?.scheme === 'file' ? active.fsPath : undefined);
		if (debug) { await debugPlan(selected.folder, plan); } else { await runtime.task(plan.name, plan.executable, plan.args, selected.folder, plan); }
	};
	const selectedAction = async (debug: boolean) => {
		const folder = await runtime.folder();
		const name = folder && api.workspace.getConfiguration('rubyStudio', folder.uri).get<string>('runConfiguration');
		if (name) { await runConfiguration(name, debug); } else if (debug) { await debugCurrent(); } else { await runCurrent(); }
	};
	register('rubyStudio.runCurrent', runCurrent);
	register('rubyStudio.debugCurrent', debugCurrent);
	register('rubyStudio.runSelected', async () => selectedAction(false));
	register('rubyStudio.debugSelected', async () => selectedAction(true));
	register('rubyStudio.pickConfiguration', async () => { await choose(''); });
	register('rubyStudio.runConfiguration', async (name?: string) => runConfiguration(name));
	register('rubyStudio.stop', async () => { await api.commands.executeCommand('rubyStudio.cancelTests'); tasks.forEach(task => task.terminate()); await Promise.all([...debugSessions.values()].map(session => api.debug.stopDebugging(session))); });
	register('rubyStudio.openConsole', async () => { await save(); await runtime.terminal(api.l10n.t('Ruby Console'), ['-S', 'irb']); });
	register('rubyStudio.manageGems', async () => {
		const action = await api.window.showQuickPick([api.l10n.t('List Installed Gems'), api.l10n.t('Install a Gem'), api.l10n.t('Bundle Install'), api.l10n.t('Bundle Check')], { title: api.l10n.t('Manage Ruby Gems') });
		if (!action) { return; }
		await save();
		let args: string[];
		if (action === api.l10n.t('List Installed Gems')) { args = ['-S', 'gem', 'list']; }
		else if (action === api.l10n.t('Install a Gem')) { const name = await api.window.showInputBox({ title: api.l10n.t('Gem Name'), validateInput: value => /^[A-Za-z0-9_-]+$/.test(value) ? undefined : api.l10n.t('Enter a gem name.') }); if (!name) { return; } args = ['-S', 'gem', 'install', name]; }
		else { args = ['-S', 'bundle', action === api.l10n.t('Bundle Install') ? 'install' : 'check']; }
		const sdk = await runtime.get(); await runtime.task(action, sdk.ruby, args);
	});
	register('rubyStudio.runRake', async () => { await save(); const task = await api.window.showInputBox({ title: api.l10n.t('Rake Task'), prompt: api.l10n.t('Enter a task name, or leave blank to list tasks.') }); if (task === undefined) { return; } const sdk = await runtime.get(); await runtime.task(api.l10n.t('Rake'), sdk.ruby, ['-S', 'rake', ...(task ? [task] : ['-T'])]); });
	return disposables;
}
