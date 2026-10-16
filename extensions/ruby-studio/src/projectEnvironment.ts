/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as vscode from 'vscode';
import * as path from 'node:path';
import * as os from 'node:os';
import * as fs from 'node:fs';
import { ProjectCoordinator, ProjectEnvironment } from './projectModel';
import { resolveDependencies } from './dependencyResolver';
import { RuntimeService, resolveRuntime } from './runtime';
import { ProjectDraft, validateProject, createProjectDirectory, discoverInterpreters } from './projectCreation';

/** Shared environment snapshots feed project UI, dependency sources and the original analyzer. */
export class ProjectEnvironmentService implements vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<ProjectEnvironment>();
	readonly onDidChange = this.changed.event;
	private readonly coordinator: ProjectCoordinator;
	private readonly disposables: vscode.Disposable[] = [];
	private readonly configurationWatchers = new Map<string, { signature: string; disposables: vscode.Disposable[] }>();
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 89);
	get states(): ReadonlyMap<string, ProjectEnvironment> { return this.coordinator.states; }
	constructor(context: vscode.ExtensionContext, private readonly runtime: RuntimeService) {
		this.coordinator = new ProjectCoordinator({
			trusted: () => vscode.workspace.isTrusted,
			runtime: (root, signal) => { const folder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.fsPath === root); if (!folder) { throw new Error('The project was removed from this workspace.'); } return runtime.get(folder, signal); },
			dependencies: (sdk, facts, signal) => resolveDependencies(sdk, facts, context.extensionPath, signal)
		}, state => { this.watchConfiguration(state); this.changed.fire(state); this.updateStatus(); });
		this.status.command = 'rubyStudio.projectEnvironment';
		this.disposables.push(this.changed, this.status, this.coordinator);
		const watcher = vscode.workspace.createFileSystemWatcher('**/{.ruby-version,.ruby-gemset,.tool-versions,mise.toml,.mise.toml,Gemfile,Gemfile.lock,gems.rb,gems.locked,*.gemspec,.bundle/config,bin/rails,config/routes.rb}');
		const refreshFile = (uri: vscode.Uri) => { const folder = vscode.workspace.getWorkspaceFolder(uri); if (folder) { this.schedule(folder); } };
		this.disposables.push(watcher, watcher.onDidChange(refreshFile), watcher.onDidCreate(refreshFile), watcher.onDidDelete(refreshFile),
			vscode.workspace.onDidChangeConfiguration(event => { if (event.affectsConfiguration('rubyStudio.interpreterPath')) { this.refresh(); } }),
			vscode.workspace.onDidGrantWorkspaceTrust(() => this.refresh()),
			vscode.window.onDidChangeActiveTextEditor(() => this.updateStatus()),
			vscode.workspace.onDidChangeWorkspaceFolders(event => { for (const folder of event.removed) { this.coordinator.remove(folder.uri.fsPath); this.clearConfigurationWatchers(folder.uri.fsPath); const timer = this.timers.get(folder.uri.fsPath); if (timer) { clearTimeout(timer); this.timers.delete(folder.uri.fsPath); } } this.refresh(); }),
			vscode.window.onDidCloseTerminal(() => this.refresh()),
			vscode.tasks.onDidEndTaskProcess(() => this.refresh()),
			vscode.commands.registerCommand('rubyStudio.refreshEnvironment', () => this.refresh()),
			vscode.commands.registerCommand('rubyStudio.projectEnvironment', async () => {
				const folder = await runtime.folder(); const state = folder && this.states.get(folder.uri.fsPath); if (!state) { return; }
				const choices = [{ label: vscode.l10n.t('Select Ruby SDK'), command: 'rubyStudio.selectInterpreter' }, { label: vscode.l10n.t('Install Ruby'), command: 'rubyStudio.installRuby' }, { label: vscode.l10n.t('Refresh Project Environment'), command: 'rubyStudio.refreshEnvironment' }, ...(state.bundle === 'missing-gems' || state.bundle === 'missing-bundler' ? [{ label: vscode.l10n.t('Bundle Install'), command: 'rubyStudio.bundleInstall' }] : [])];
				const choice = await vscode.window.showQuickPick(choices, { title: folder?.name, placeHolder: state.issues.map(issue => vscode.l10n.t(issue)).join(' ') || vscode.l10n.t('Ruby: {0} · Dependencies: {1}', state.sdk, state.bundle) });
				if (choice) { await vscode.commands.executeCommand(choice.command); }
			}),
			vscode.commands.registerCommand('rubyStudio.getProjectEnvironments', () => [...this.states.values()].map(({ runtime: sdk, ...state }) => ({ ...state, runtime: sdk && { ruby: sdk.ruby, version: sdk.version, manager: sdk.manager } }))),
			vscode.commands.registerCommand('rubyStudio.projectCandidates', async () => ({ parent: os.homedir(), interpreters: await discoverInterpreters(os.homedir()) })),
			vscode.commands.registerCommand('rubyStudio.validateProject', (draft: ProjectDraft) => validateProject(draft)),
			vscode.commands.registerCommand('rubyStudio.createEmptyProject', async (draft: ProjectDraft, existing: 'create' | 'open' | 'reject') => {
				if (existing !== 'open') { await resolveRuntime({ cwd: draft.parent, configuredPath: draft.interpreter, trusted: vscode.workspace.isTrusted }); }
				return createProjectDirectory(draft, existing);
			}));
		this.refresh();
	}
	refresh(): void { this.runtime.invalidate(); for (const folder of vscode.workspace.workspaceFolders || []) { this.schedule(folder); } }
	private schedule(folder: vscode.WorkspaceFolder): void {
		if (folder.uri.scheme !== 'file') { return; }
		this.runtime.invalidate(); const key = folder.uri.fsPath; this.coordinator.cancel(key);
		const timer = this.timers.get(key); if (timer) { clearTimeout(timer); }
		this.timers.set(key, setTimeout(() => { this.timers.delete(key); void this.coordinator.refresh(key); }, 200));
	}
	/** Watch effective paths, including custom manifests and user settings outside the workspace. */
	private watchConfiguration(state: ProjectEnvironment): void {
		// Keep the last successful watch set while a replacement probe is pending or fails.
		if (!state.configurationFiles) { return; }
		const files = [...new Set(state.configurationFiles)].sort();
		const signature = JSON.stringify(files);
		if (this.configurationWatchers.get(state.root)?.signature === signature) { return; }
		this.clearConfigurationWatchers(state.root);
		const entry = { signature, disposables: [] as vscode.Disposable[] };
		this.configurationWatchers.set(state.root, entry);
		const refresh = () => {
			const folder = vscode.workspace.workspaceFolders?.find(folder => folder.uri.fsPath === state.root);
			if (folder) { this.schedule(folder); }
		};
		for (const file of files) {
			// Watch from an existing ancestor so creating a previously absent config also refreshes.
			let directory = path.dirname(file);
			while (!fs.existsSync(directory) && path.dirname(directory) !== directory) { directory = path.dirname(directory); }
			const pattern = path.relative(directory, file).split(path.sep).join('/').replace(/[\[\]{}*?]/g, character => `[${character}]`);
			const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(directory), pattern));
			entry.disposables.push(watcher, watcher.onDidChange(refresh), watcher.onDidCreate(refresh), watcher.onDidDelete(refresh));
		}
	}
	private clearConfigurationWatchers(root: string): void {
		this.configurationWatchers.get(root)?.disposables.forEach(item => item.dispose());
		this.configurationWatchers.delete(root);
	}
	/** Publish analyzer progress without restarting environment resolution. */
	reportIndex(root: string, generation: number, index: ProjectEnvironment['index']): void {
		const state = this.states.get(root); if (state?.generation !== generation) { return; }
		state.index = index; this.changed.fire(state); this.updateStatus();
	}
	private updateStatus(): void {
		const active = vscode.window.activeTextEditor?.document.uri;
		const folder = active && vscode.workspace.getWorkspaceFolder(active) || vscode.workspace.workspaceFolders?.[0];
		const state = folder && this.states.get(folder.uri.fsPath);
		if (!state) { this.status.hide(); return; }
		this.status.text = vscode.l10n.t('$(ruby) Project: {0} · Gems: {1}', state.sdk, state.bundle);
		this.status.tooltip = [folder?.name, state.runtime?.version, state.runtime?.ruby, state.facts?.requestedRuby && vscode.l10n.t('Requested: {0} ({1})', state.facts.requestedRuby.version, path.basename(state.facts.requestedRuby.source)), vscode.l10n.t('Index: Project {0}, Libraries {1}', state.index.project, state.index.libraries), ...state.issues.map(issue => vscode.l10n.t(issue))].filter(Boolean).join('\n');
		this.status.show();
	}
	dispose(): void { for (const timer of this.timers.values()) { clearTimeout(timer); } this.timers.clear(); for (const root of this.configurationWatchers.keys()) { this.clearConfigurationWatchers(root); } this.disposables.splice(0).forEach(item => item.dispose()); }
}
