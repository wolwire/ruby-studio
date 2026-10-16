/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes, createHash } from 'node:crypto';
import { RuntimeService, resolveRuntime, findExecutable } from './runtime';
import { parseRunConfigurations, RubyRunConfiguration } from './execution';
import { settingFields, SettingValue, validateSettingsDraft } from './settingsModel';

const execute = promisify(execFile);
type Scope = 'user' | 'workspace' | 'project';
interface SettingsMessage {
	command: 'ready' | 'scope' | 'apply' | 'cancel' | 'browse' | 'validate' | 'gems' | 'allSettings' | 'runConfigurations';
	scope?: Scope; draft?: Record<string, SettingValue>; interpreter?: string; close?: boolean; configurations?: RubyRunConfiguration[]; selected?: string;
}

/** Dedicated native editor windows keep configuration and project ownership in the original workbench. */
export function registerSettings(context: vscode.ExtensionContext, runtime: RuntimeService): vscode.Disposable[] {
	const panels = new Map<string, vscode.WebviewPanel>();
	const disposables: vscode.Disposable[] = [{ dispose: () => { for (const panel of panels.values()) { panel.dispose(); } panels.clear(); } }];
	const open = async (mode: 'settings' | 'runs', section = 'appearance') => {
		const folder = await runtime.folder();
		const key = `${mode}:${folder?.uri.toString() || 'user'}`;
		const existing = panels.get(key);
		if (existing) { existing.reveal(); await existing.webview.postMessage({ command: 'section', section }); return; }
		const panel = vscode.window.createWebviewPanel(`rubyStudio.${mode}`, mode === 'runs' ? vscode.l10n.t('Run/Debug Configurations') : vscode.l10n.t('Ruby Studio Settings'), vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')] });
		panels.set(key, panel);
		let scope: Scope = folder ? 'project' : 'user';
		let busy = false;
		let disposed = false;
		let revision = 0;
		let original: Record<string, SettingValue | undefined> = {};
		let runHash = '';
		const listeners: vscode.Disposable[] = [];
		const cwd = folder?.uri.fsPath || os.homedir();
		const runFile = path.join(cwd, '.ruby-studio', 'run-configurations.json');
		const configuration = (key: string) => { const index = key.indexOf('.'); const language = settingFields.find(field => field.key === key)?.language; return { config: vscode.workspace.getConfiguration(key.slice(0, index), language ? { uri: folder?.uri, languageId: language } : folder?.uri), name: key.slice(index + 1), language }; };
		const explicit = (key: string) => {
			const { config, name, language } = configuration(key);
			const inspected = config.inspect<SettingValue>(name);
			if (language) { return scope === 'project' ? inspected?.workspaceFolderLanguageValue : scope === 'workspace' ? inspected?.workspaceLanguageValue : inspected?.globalLanguageValue; }
			return scope === 'project' ? inspected?.workspaceFolderValue : scope === 'workspace' ? inspected?.workspaceValue : inspected?.globalValue;
		};
		const inherited = (key: string): SettingValue => {
			const { config, name, language } = configuration(key); const inspected = config.inspect<SettingValue>(name);
			if (language) { return (scope === 'project' ? inspected?.workspaceLanguageValue : undefined) ?? (scope !== 'user' ? inspected?.globalLanguageValue : undefined) ?? inspected?.defaultLanguageValue ?? inspected?.defaultValue ?? ''; }
			return (scope === 'project' ? inspected?.workspaceValue : undefined) ?? (scope !== 'user' ? inspected?.globalValue : undefined) ?? inspected?.defaultValue ?? '';
		};
		const target = () => scope === 'project' ? vscode.ConfigurationTarget.WorkspaceFolder : scope === 'workspace' ? vscode.ConfigurationTarget.Workspace : vscode.ConfigurationTarget.Global;
		const post = (message: object) => disposed ? Promise.resolve(false) : panel.webview.postMessage(message);
		const readRuns = async () => { try { return await fs.readFile(runFile, 'utf8'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') { return ''; } throw error; } };
		const initialize = async (preserveRevision = false) => {
			original = Object.fromEntries(settingFields.map(field => [field.key, explicit(field.key)]));
			const values = Object.fromEntries(settingFields.map(field => [field.key, original[field.key] ?? inherited(field.key)]));
			let configurations: RubyRunConfiguration[] = [];
			if (mode === 'runs') { const text = await readRuns(); runHash = createHash('sha256').update(text).digest('hex'); configurations = text ? parseRunConfigurations(text) : []; }
			const candidates = new Set([String(values['rubyStudio.interpreterPath'] || ''), process.env.RUBY_STUDIO_RUBY || '', await findExecutable('ruby', process.env, cwd) || '']);
			for (const directory of [path.join(os.homedir(), '.rbenv/versions'), path.join(os.homedir(), '.asdf/installs/ruby'), path.join(os.homedir(), '.rubies')]) {
				try { for (const name of (await fs.readdir(directory)).slice(0, 50)) { const candidate = path.join(directory, name, 'bin/ruby'); try { await fs.access(candidate, fs.constants.X_OK); candidates.add(candidate); } catch { /* Not an interpreter. */ } } } catch { /* Optional version manager. */ }
			}
			const labels = Object.fromEntries(['Settings', 'Appearance', 'Editor', 'Ruby SDK and Gems', 'Ruby Language', 'Run/Debug Configurations', 'User', 'Workspace', 'Project', 'Search Settings', 'Apply', 'OK', 'Cancel', 'Browse', 'Validate', 'Refresh Gems', 'Automatic Detection', 'All Editor Settings', 'Use Inherited Value', 'Add', 'Duplicate', 'Remove', 'Name', 'Type', 'Script', 'Arguments (JSON Array)', 'Environment (JSON Object)', 'Working Directory', 'Use Bundler', 'Select Configuration', 'No Project Open', 'Unsaved Changes', 'Saved', 'Validation Failed', 'Local Ruby Interpreter', 'Interpreter Version and Gems'].map(label => [label, vscode.l10n.t(label)]));
			await post({ command: 'state', mode, section, scope, scopes: folder ? ['project', 'workspace', 'user'] : ['user'], project: folder?.name, revision: preserveRevision ? (revision ||= 1) : ++revision, fields: settingFields.map(field => ({ ...field, label: vscode.l10n.t(field.label) })), values, inherited: Object.fromEntries(settingFields.map(field => [field.key, inherited(field.key)])), explicit: original, candidates: [...candidates].filter(Boolean), configurations, selected: vscode.workspace.getConfiguration('rubyStudio', folder?.uri).get<string>('runConfiguration', ''), labels });
		};
		const handle = async (message: SettingsMessage) => {
			if (!message || typeof message.command !== 'string' || busy) { return; }
			busy = true;
			try {
				switch (message.command) {
					case 'ready': await initialize(true); break;
					case 'scope': if (message.scope && ['user', ...(folder ? ['project', 'workspace'] : [])].includes(message.scope)) { scope = message.scope; await initialize(); } break;
					case 'cancel': panel.dispose(); break;
					case 'browse': {
						const files = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: vscode.l10n.t('Select Ruby Executable') });
						if (files?.[0]?.scheme === 'file') { await post({ command: 'interpreter', value: files[0].fsPath }); } break;
					}
					case 'validate': case 'gems': {
						if (typeof message.interpreter !== 'string') { throw new Error(vscode.l10n.t('Choose a Ruby executable.')); }
						const sdk = await resolveRuntime({ cwd, configuredPath: message.interpreter, trusted: vscode.workspace.isTrusted });
						let gems: { name: string; version: string }[] | undefined;
						if (message.command === 'gems') {
							const result = await execute(sdk.ruby, ['-rrubygems', '-rjson', '-e', 'puts JSON.generate(Gem::Specification.to_a.sort_by { |s| [s.name, s.version] }.map { |s| {name:s.name,version:s.version.to_s} })'], { cwd, env: sdk.env, timeout: 20000, maxBuffer: 4 * 1024 * 1024 });
							gems = JSON.parse(result.stdout);
						}
						await post({ command: 'validated', version: sdk.version, ruby: sdk.ruby, manager: sdk.manager, gems }); break;
					}
					case 'apply': {
						if (mode === 'runs') {
							if (!folder) { throw new Error(vscode.l10n.t('Open a project before editing run configurations.')); }
							const configurations = parseRunConfigurations(JSON.stringify({ configurations: message.configurations }));
							if (message.selected && !configurations.some(item => item.name === message.selected)) { throw new Error(vscode.l10n.t('Select an existing run configuration.')); }
							if (vscode.workspace.textDocuments.some(document => document.uri.fsPath === runFile && document.isDirty)) { throw new Error(vscode.l10n.t('Save the open run configuration document first.')); }
							const text = await readRuns();
							if (createHash('sha256').update(text).digest('hex') !== runHash) { throw new Error(vscode.l10n.t('Run configurations changed outside this window. Close and reopen to reload them.')); }
							const temporary = runFile + '.' + randomBytes(8).toString('hex');
							await fs.mkdir(path.dirname(runFile), { recursive: true });
							try { await fs.writeFile(temporary, JSON.stringify({ version: 1, configurations }, null, '\t') + '\n', { flag: 'wx' }); await fs.rename(temporary, runFile); } finally { await fs.rm(temporary, { force: true }); }
							await vscode.workspace.getConfiguration('rubyStudio', folder.uri).update('runConfiguration', message.selected || '', vscode.ConfigurationTarget.WorkspaceFolder);
						} else {
							const draft = message.draft || {}; validateSettingsDraft(draft);
							for (const key of Object.keys(draft)) { if (explicit(key) !== original[key]) { throw new Error(vscode.l10n.t('Settings changed outside this window. Close and reopen to reload them.')); } }
							if ('rubyStudio.interpreterPath' in draft) { await resolveRuntime({ cwd, configuredPath: String(draft['rubyStudio.interpreterPath'] ?? inherited('rubyStudio.interpreterPath')), trusted: vscode.workspace.isTrusted }); }
							for (const [key, value] of Object.entries(draft)) { const { config, name, language } = configuration(key); await config.update(name, value === null ? undefined : value, target(), !!language); }
							if ('rubyStudio.interpreterPath' in draft && vscode.workspace.isTrusted) { await runtime.get(folder); }
						}
						if (message.close) { panel.dispose(); } else { await initialize(); await post({ command: 'saved' }); } break;
					}
					case 'allSettings': await vscode.commands.executeCommand('workbench.action.openSettings2'); await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'); break;
					case 'runConfigurations': await open('runs'); break;
				}
			} catch (error) { await post({ command: 'error', message: error instanceof Error ? error.message : String(error) }); }
			finally { busy = false; await post({ command: 'idle' }); }
		};
		let queue = Promise.resolve();
		listeners.push(panel.webview.onDidReceiveMessage((message: SettingsMessage) => { queue = queue.then(() => handle(message)); }));
		listeners.push(panel.onDidDispose(() => { disposed = true; panels.delete(key); listeners.splice(0).forEach(listener => listener.dispose()); }));
		const nonce = randomBytes(16).toString('hex');
		const script = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'settings.js'));
		const styles = panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'media', 'settings.css'));
		// Move only after this panel becomes the active editor, so the user's source
		// editor cannot be accidentally detached while the webview is opening.
		await new Promise<void>(resolve => {
			const active = () => { const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input; return input instanceof vscode.TabInputWebview && input.viewType.includes(`rubyStudio.${mode}`); };
			if (active()) { resolve(); return; }
			const listener = vscode.window.tabGroups.onDidChangeTabs(() => { if (active()) { clearTimeout(timer); listener.dispose(); resolve(); } });
			const timer = setTimeout(() => { listener.dispose(); resolve(); }, 5000);
		});
		const active = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
		if (active instanceof vscode.TabInputWebview && active.viewType.includes(`rubyStudio.${mode}`)) { await vscode.commands.executeCommand('workbench.action.moveEditorToNewWindow'); }
		// Moving recreates the webview in the destination renderer. Load its HTML
		// after ownership transfers so startup content/messages cannot be lost.
		if (!disposed) { panel.webview.html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${panel.webview.cspSource}; script-src 'nonce-${nonce}'"><link rel="stylesheet" href="${styles}"></head><body><div id="app"></div><script nonce="${nonce}" src="${script}"></script></body></html>`; }
	};
	disposables.push(vscode.commands.registerCommand('rubyStudio.openSettings', () => open('settings')), vscode.commands.registerCommand('rubyStudio.openInterpreterSettings', () => open('settings', 'sdk')), vscode.commands.registerCommand('rubyStudio.editRunConfigurations', () => open('runs')));
	return disposables;
}
