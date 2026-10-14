/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type * as vscode from 'vscode';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

const execute = promisify(execFile);
const probe = 'require "json"; require "rbconfig"; puts "RUBY_STUDIO_RUNTIME=" + JSON.generate({ruby: RbConfig.ruby, version: RUBY_DESCRIPTION, env: ENV.to_h.select { |k,v| k =~ /\\A(PATH|GEM_.*|RUBY.*|BUNDLE_.*|RBENV_.*|ASDF_.*|MISE_.*|rvm_.*|LD_LIBRARY_PATH|DYLD_LIBRARY_PATH)\\z/ }})';

/** An interpreter and the environment in which it was actually validated. */
export interface RuntimeInfo {
	ruby: string;
	cwd: string;
	env: NodeJS.ProcessEnv;
	version: string;
	manager: string;
}

/** Explicit inputs keep interpreter resolution testable without an extension host. */
export interface RuntimeResolutionOptions {
	cwd: string;
	configuredPath?: string;
	env?: NodeJS.ProcessEnv;
	trusted: boolean;
}

/** Load gem entry points with the selected Ruby, even if PATH contains shell wrappers. */
export function normalizeRubyArguments(args: string[]): string[] {
	if (args[0] !== '-S' || !args[1]) { return args; }
	const tool = args[1];
	if (tool === 'gem') { return ['-rrubygems/gem_runner', '-e', 'Gem::GemRunner.new.run(ARGV)', '--', ...args.slice(2)]; }
	const tools: Record<string, string> = { bundle: 'bundler', bundler: 'bundler', rake: 'rake', irb: 'irb', rails: 'railties', rspec: 'rspec-core' };
	if ((tool === 'bundle' || tool === 'bundler') && args[2] === 'exec' && args[3]) {
		// Activate the bundle in the selected interpreter. Re-executing a Ruby
		// shell wrapper makes Bundler's absolute RUBYOPT path break on spaces.
		const setup = path.join(__dirname, '..', 'ruby', 'bundler_setup.rb');
		if (/^ruby(?:\d+(?:\.\d+)*)?(?:\.exe)?$/.test(path.basename(args[3]))) { return ['-r', setup, ...normalizeRubyArguments(args.slice(4))]; }
		if (tools[args[3]]) { return ['-r', setup, ...normalizeRubyArguments(['-S', args[3], ...args.slice(4)])]; }
	}
	const gem = tools[tool];
	return gem ? ['-rrubygems', '-e', 'load Gem.bin_path(ARGV.shift, ARGV.shift)', '--', gem, tool, ...args.slice(2)] : args;
}

/** Expand supported editor variables without invoking a shell. */
export function expandRuntimeValue(value: string, cwd: string, env: NodeJS.ProcessEnv, file?: string): string {
	return value.replace(/\$\{workspaceFolder\}/g, cwd)
		.replace(/\$\{file\}/g, file || '')
		.replace(/\$\{env:([^}]+)\}/g, (_match, key: string) => env[key] || '')
		.replace(/^~(?=[/\\]|$)/, os.homedir());
}

/** Locate a command without shell evaluation or project hooks. */
export async function findExecutable(command: string, env: NodeJS.ProcessEnv, cwd: string): Promise<string | undefined> {
	const candidates = path.isAbsolute(command) || command.includes('/') || command.includes('\\')
		? [path.resolve(cwd, command)]
		: (env.PATH || '').split(path.delimiter).filter(Boolean).map(directory => path.join(directory, command));
	for (const candidate of candidates) {
		for (const suffix of process.platform === 'win32' ? ['', '.exe', '.cmd', '.bat'] : ['']) {
			try {
				const target = candidate + suffix;
				await fs.access(target, process.platform === 'win32' ? fs.constants.F_OK : fs.constants.X_OK);
				if ((await fs.stat(target)).isFile()) { return target; }
			} catch { /* Try the next candidate. */ }
		}
	}
	return undefined;
}

async function readOptional(filename: string): Promise<string> {
	try { return await fs.readFile(filename, 'utf8'); } catch { return ''; }
}

async function validate(executable: string, prefix: string[], cwd: string, env: NodeJS.ProcessEnv, manager: string, selected?: string): Promise<RuntimeInfo> {
	const { stdout } = await execute(executable, [...prefix, '-e', probe], { cwd, env, timeout: 20000, maxBuffer: 1024 * 1024, windowsHide: true });
	const payload = stdout.split(/\r?\n/).findLast(line => line.startsWith('RUBY_STUDIO_RUNTIME='));
	if (!payload) { throw new Error('The selected command did not identify a Ruby interpreter.'); }
	const result = JSON.parse(payload.slice('RUBY_STUDIO_RUNTIME='.length)) as { ruby: string; version: string; env: Record<string, string> };
	if (typeof result.ruby !== 'string' || !result.version?.startsWith('ruby ') || !result.env || typeof result.env !== 'object') {
		throw new Error('The Ruby interpreter returned an invalid environment.');
	}
	const ruby = selected || result.ruby;
	const resolvedEnv = { ...env, ...result.env };
	resolvedEnv.PATH = [path.dirname(ruby), resolvedEnv.PATH].filter(Boolean).join(path.delimiter);
	return { ruby, cwd, env: resolvedEnv, version: result.version, manager };
}

/** Resolve a project SDK only after trust; no workspace Ruby is evaluated while untrusted. */
export async function resolveRuntime(options: RuntimeResolutionOptions): Promise<RuntimeInfo> {
	if (!options.trusted) { throw new Error('Trust this workspace before running Ruby or a version manager.'); }
	const cwd = await fs.realpath(options.cwd);
	if (!(await fs.stat(cwd)).isDirectory()) { throw new Error('The Ruby working directory must be a folder.'); }
	const env = { ...(options.env || process.env) };
	if (options.configuredPath?.trim()) {
		const configured = expandRuntimeValue(options.configuredPath.trim(), cwd, env);
		const executable = await findExecutable(configured, env, cwd);
		if (!executable) { throw new Error(`Ruby interpreter not found: ${configured}`); }
		return validate(executable, [], cwd, env, 'selected', executable);
	}
	const [rubyVersion, toolVersions, miseConfig, hiddenMiseConfig] = await Promise.all([
		readOptional(path.join(cwd, '.ruby-version')), readOptional(path.join(cwd, '.tool-versions')),
		readOptional(path.join(cwd, 'mise.toml')), readOptional(path.join(cwd, '.mise.toml'))
	]);
	const version = rubyVersion.trim() || toolVersions.match(/^ruby\s+(?<version>\S+)/m)?.groups?.version || '';
	const hasMise = /\bruby\s*=/.test(miseConfig + hiddenMiseConfig);
	const managerPaths = [path.join(os.homedir(), '.local/bin'), path.join(os.homedir(), '.rbenv/bin'), path.join(os.homedir(), '.asdf/bin'), path.join(os.homedir(), '.rvm/bin')];
	const searchEnv = { ...env, PATH: [env.PATH, ...managerPaths].filter(Boolean).join(path.delimiter) };
	const managers: [string, string[], boolean][] = [
		['mise', ['exec', '--', 'ruby'], hasMise],
		['asdf', ['exec', 'ruby'], /^ruby\s/m.test(toolVersions)],
		['rbenv', ['exec', 'ruby'], Boolean(rubyVersion.trim())],
		['chruby-exec', [version, '--', 'ruby'], Boolean(version)],
		['rvm-auto-ruby', [], Boolean(version)],
		['mise', ['exec', '--', 'ruby'], Boolean(version)]
	];
	for (const [name, args, relevant] of managers) {
		if (!relevant) { continue; }
		const manager = await findExecutable(name, searchEnv, cwd);
		if (manager) {
			try { return await validate(manager, args, cwd, searchEnv, name); }
			catch (error) { throw new Error(`The ${name} Ruby environment could not start. ${error instanceof Error ? error.message : String(error)}`); }
		}
	}
	for (const candidate of [env.RUBY_STUDIO_RUBY, 'ruby'].filter((value): value is string => Boolean(value))) {
		const executable = await findExecutable(candidate, env, cwd);
		if (executable) { return validate(executable, [], cwd, env, candidate === env.RUBY_STUDIO_RUBY ? 'bundled' : 'environment', executable); }
	}
	throw new Error('No Ruby interpreter was found. Use Select Ruby Interpreter to choose one.');
}

/** Workspace-aware SDK selection, terminal and native task integration. */
export class RuntimeService implements vscode.Disposable {
	private readonly disposables: vscode.Disposable[] = [];
	private readonly cache = new Map<string, Promise<RuntimeInfo>>();
	private readonly status: vscode.StatusBarItem;

	constructor(_context?: vscode.ExtensionContext) {
		const api: typeof vscode = require('vscode');
		this.status = api.window.createStatusBarItem(api.StatusBarAlignment.Left, 90);
		this.disposables.push(this.status);
		this.status.command = 'rubyStudio.selectInterpreter';
		this.status.text = '$(ruby) Ruby';
		this.status.tooltip = api.l10n.t('Select Ruby Interpreter');
		this.status.show();
		this.disposables.push(api.workspace.onDidChangeConfiguration(event => {
			if (event.affectsConfiguration('rubyStudio.interpreterPath')) { this.cache.clear(); }
		}));
		this.disposables.push(api.workspace.onDidSaveTextDocument(document => {
			if (['.ruby-version', '.tool-versions', 'mise.toml', '.mise.toml', 'Gemfile', 'Gemfile.lock'].includes(path.basename(document.uri.fsPath))) { this.cache.clear(); }
		}));
	}

	/** Resolve the active folder or ask explicitly in a multi-root workspace. */
	async folder(folder?: vscode.WorkspaceFolder): Promise<vscode.WorkspaceFolder | undefined> {
		const api: typeof vscode = require('vscode');
		if (folder) { return folder; }
		const active = api.window.activeTextEditor?.document.uri;
		const current = active && api.workspace.getWorkspaceFolder(active);
		if (current) { return current; }
		const folders = api.workspace.workspaceFolders || [];
		if (folders.length === 1) { return folders[0]; }
		if (folders.length > 1) { return api.window.showWorkspaceFolderPick({ placeHolder: api.l10n.t('Choose the Ruby project') }); }
		return undefined;
	}

	async get(folder?: vscode.WorkspaceFolder): Promise<RuntimeInfo> {
		const api: typeof vscode = require('vscode');
		if (!api.workspace.isTrusted) { throw new Error(api.l10n.t('Trust this workspace before running Ruby.')); }
		const selected = await this.folder(folder);
		if (!selected && (api.workspace.workspaceFolders?.length || 0) > 1) { throw new Error(api.l10n.t('No Ruby project was selected.')); }
		const activeFile = api.window.activeTextEditor?.document.uri;
		const cwd = selected?.uri.fsPath || (activeFile?.scheme === 'file' ? path.dirname(activeFile.fsPath) : os.homedir());
		const configuredPath = api.workspace.getConfiguration('rubyStudio', selected?.uri).get<string>('interpreterPath', '');
		const key = `${cwd}\0${configuredPath}`;
		let pending = this.cache.get(key);
		if (!pending) {
			pending = resolveRuntime({ cwd, configuredPath, trusted: true });
			this.cache.set(key, pending);
			pending.catch(() => this.cache.delete(key));
		}
		const result = await pending;
		this.status.text = `$(ruby) ${result.version.split(' ').slice(0, 2).join(' ')}`;
		this.status.tooltip = `${result.ruby}\n${result.manager}\n${result.cwd}`;
		return result;
	}

	async select(): Promise<void> {
		const api: typeof vscode = require('vscode');
		const folder = await this.folder();
		if (!folder) { await api.window.showInformationMessage(api.l10n.t('Open a project folder before selecting its Ruby interpreter.')); return; }
		const current = api.workspace.getConfiguration('rubyStudio', folder.uri).get<string>('interpreterPath', '');
		const selected = await api.window.showInputBox({ title: api.l10n.t('Ruby Interpreter for {0}', folder.name), prompt: api.l10n.t('Enter a Ruby executable path, or leave blank for project version managers and automatic detection.'), value: current });
		if (selected === undefined) { return; }
		if (api.workspace.isTrusted && selected.trim()) { await resolveRuntime({ cwd: folder.uri.fsPath, configuredPath: selected, trusted: true }); }
		await api.workspace.getConfiguration('rubyStudio', folder.uri).update('interpreterPath', selected.trim(), api.ConfigurationTarget.WorkspaceFolder);
		this.cache.clear();
		if (api.workspace.isTrusted) { await this.get(folder); }
	}

	async terminal(name: string, args: string[], folder?: vscode.WorkspaceFolder): Promise<vscode.Terminal> {
		const api: typeof vscode = require('vscode');
		const sdk = await this.get(folder);
		const terminal = api.window.createTerminal({ name, shellPath: sdk.ruby, shellArgs: normalizeRubyArguments(args), cwd: sdk.cwd, env: sdk.env, iconPath: new api.ThemeIcon('ruby') });
		terminal.show();
		return terminal;
	}

	async task(name: string, executable: string, args: string[], folder?: vscode.WorkspaceFolder, options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<vscode.TaskExecution> {
		const api: typeof vscode = require('vscode');
		const selected = await this.folder(folder);
		if (!selected && (api.workspace.workspaceFolders?.length || 0) > 1) { throw new Error(api.l10n.t('No Ruby project was selected.')); }
		const sdk = await this.get(selected);
		const cwd = options.cwd || sdk.cwd;
		if (!(await fs.stat(cwd)).isDirectory()) { throw new Error(api.l10n.t('The task working directory does not exist.')); }
		const env = Object.fromEntries(Object.entries({ ...sdk.env, ...options.env }).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
		const command = executable === 'ruby' ? sdk.ruby : await findExecutable(executable, env, cwd);
		if (!command) { throw new Error(api.l10n.t('Executable not found: {0}', executable)); }
		const rubyArgs = executable === 'ruby' || executable === sdk.ruby ? normalizeRubyArguments(args) : args;
		const task = new api.Task({ type: 'rubyStudio', command: name }, selected || api.TaskScope.Global, name, 'Ruby Studio', new api.ProcessExecution(command, rubyArgs, { cwd, env }), ['$rubyStudioRuntime']);
		task.presentationOptions = { reveal: api.TaskRevealKind.Always, panel: api.TaskPanelKind.Dedicated, clear: true };
		return api.tasks.executeTask(task);
	}

	dispose(): void { this.disposables.splice(0).forEach(disposable => disposable.dispose()); this.cache.clear(); }
}
