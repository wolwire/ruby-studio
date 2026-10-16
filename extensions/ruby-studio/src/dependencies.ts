/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'node:path';
import { RuntimeService } from './runtime';
import type { ProjectEnvironmentService } from './projectEnvironment';

interface LockedGem {
	name: string;
	version: string;
	line: number;
	dependencies: string[];
}

/** Reads resolved GEM/GIT/PATH specs without running Bundler or loading project Ruby. */
export function parseGemfileLock(text: string): LockedGem[] {
	const gems: LockedGem[] = [];
	let inSpecs = false;
	let current: LockedGem | undefined;
	for (const [line, textLine] of text.split(/\r?\n/).entries()) {
		if (/^  specs:\s*$/.test(textLine)) { inSpecs = true; current = undefined; continue; }
		if (/^\S/.test(textLine)) { inSpecs = false; current = undefined; }
		if (!inSpecs) { continue; }
		const spec = textLine.match(/^    (?<name>[\w.-]+) \((?<version>[^)]+)\)\s*$/);
		if (spec?.groups) {
			current = { name: spec.groups.name, version: spec.groups.version, line, dependencies: [] };
			gems.push(current);
			continue;
		}
		const dependency = textLine.match(/^      (?<name>[\w.-]+)(?:\s|$)/)?.groups?.name;
		if (current && dependency) { current.dependencies.push(dependency); }
	}
	return gems.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

class GemItem extends vscode.TreeItem {
	constructor(label: string, readonly folder: vscode.WorkspaceFolder, readonly kind: 'folder' | 'gem' | 'dependency' | 'message' | 'source', readonly gem?: LockedGem, readonly allGems: LockedGem[] = [], readonly sourcePath?: string, directory = false) {
		super(label, kind === 'folder' || (kind === 'source' && directory) || (kind === 'gem' && !!gem?.dependencies.length) ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		this.contextValue = `rubyStudio.${kind}`;
		if (sourcePath) { this.resourceUri = vscode.Uri.file(sourcePath); this.iconPath = new vscode.ThemeIcon(directory ? 'folder' : 'file'); if (!directory) { this.command = { command: 'vscode.open', title: vscode.l10n.t('Open Dependency Source'), arguments: [this.resourceUri] }; } }
		if (gem) {
			this.description = gem.version;
			this.tooltip = `${gem.name} (${gem.version})\n${gem.dependencies.join(', ')}`;
			this.iconPath = new vscode.ThemeIcon('package');
			this.command = { command: 'vscode.open', title: vscode.l10n.t('Open Locked Dependency'), arguments: [vscode.Uri.joinPath(folder.uri, 'Gemfile.lock'), { selection: new vscode.Range(gem.line, 0, gem.line, 0) }] };
		}
	}
}

class GemTree implements vscode.TreeDataProvider<GemItem>, vscode.Disposable {
	constructor(private readonly environments?: ProjectEnvironmentService) { }
	private readonly changed = new vscode.EventEmitter<GemItem | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	refresh(): void { this.changed.fire(undefined); }
	dispose(): void { this.changed.dispose(); }
	getTreeItem(item: GemItem): GemItem { return item; }
	async getChildren(item?: GemItem): Promise<GemItem[]> {
		if (!item) { return (vscode.workspace.workspaceFolders || []).map(folder => new GemItem(folder.name, folder, 'folder')); }
		if (item.kind === 'source' && item.sourcePath) {
			try { return (await fs.readdir(item.sourcePath, { withFileTypes: true })).filter(entry => !entry.isSymbolicLink() && !entry.name.startsWith('.')).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).slice(0, 1000).map(entry => new GemItem(entry.name, item.folder, 'source', undefined, [], path.join(item.sourcePath!, entry.name), entry.isDirectory())); } catch { return []; }
		}
		if (item.kind === 'gem' && item.gem) {
			return item.gem.dependencies.map(name => {
				const gem = item.allGems.find(gem => gem.name === name);
				return new GemItem(name, item.folder, 'dependency', gem, item.allGems);
			});
		}
		if (item.kind !== 'folder') { return []; }
		const result: GemItem[] = [];
		// This status displays configuration only; expanding the tree never starts Ruby.
		const configured = vscode.workspace.getConfiguration('rubyStudio', item.folder.uri).get<string>('interpreterPath') || 'ruby (from PATH)';
		const sdk = new GemItem(vscode.l10n.t('Ruby SDK'), item.folder, 'message');
		sdk.description = configured;
		sdk.iconPath = new vscode.ThemeIcon('ruby');
		sdk.command = { command: 'rubyStudio.selectInterpreter', title: vscode.l10n.t('Select Ruby Interpreter') };
		result.push(sdk);
		try {
			const contents = await fs.readFile(vscode.Uri.joinPath(item.folder.uri, 'Gemfile.lock').fsPath, 'utf8');
			const gems = parseGemfileLock(contents);
			result.push(...gems.map(gem => new GemItem(gem.name, item.folder, 'gem', gem, gems)));
			if (!gems.length) { result.push(new GemItem(vscode.l10n.t('No Resolved Gems in Gemfile.lock'), item.folder, 'message')); }
		} catch (error) {
			const itemLabel = error instanceof Error && 'code' in error && error.code === 'ENOENT' ? vscode.l10n.t('No Gemfile.lock — Run Bundle Install') : vscode.l10n.t('Cannot Read Gemfile.lock: {0}', error instanceof Error ? error.message : String(error));
			result.push(new GemItem(itemLabel, item.folder, 'message'));
		}
		const state = this.environments?.states.get(item.folder.uri.fsPath);
		for (const dependency of state?.dependencies || []) {
			const source = new GemItem(dependency.name, item.folder, 'source', undefined, [], dependency.sourcePath, true);
			source.description = `${dependency.version} · ${dependency.source}`;
			source.tooltip = dependency.sourcePath;
			source.iconPath = new vscode.ThemeIcon('library');
			result.push(source);
		}
		if (state && !['none', 'ready'].includes(state.bundle)) { const status = new GemItem(vscode.l10n.t('Dependencies: {0}', state.bundle), item.folder, 'message'); status.command = { command: 'rubyStudio.projectEnvironment', title: vscode.l10n.t('Project Environment') }; result.push(status); }
		return result;
	}
}

async function chooseFolder(item?: GemItem): Promise<vscode.WorkspaceFolder | undefined> {
	if (item?.folder) { return item.folder; }
	const folders = vscode.workspace.workspaceFolders || [];
	if (folders.length === 1) { return folders[0]; }
	if (folders.length > 1) { return vscode.window.showWorkspaceFolderPick(); }
	void vscode.window.showInformationMessage(vscode.l10n.t('Open a project folder first.'));
	return undefined;
}

async function runTool(runtime: RuntimeService, name: string, args: string[], item?: GemItem): Promise<void> {
	if (!vscode.workspace.isTrusted) {
		void vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before installing or updating dependencies.'));
		return;
	}
	const folder = await chooseFolder(item);
	if (folder) { await runtime.terminal(name, args, folder); }
}

/** Registers explicit gem installation/update actions and a read-only lockfile tree. */
export function registerDependencies(_context: vscode.ExtensionContext, runtime: RuntimeService, environments?: ProjectEnvironmentService): vscode.Disposable[] {
	const tree = new GemTree(environments);
	const disposables: vscode.Disposable[] = [tree, vscode.window.registerTreeDataProvider('rubyStudio.gems', tree)];
	const register = (name: string, callback: (item?: GemItem) => Promise<void> | void) => disposables.push(vscode.commands.registerCommand(`rubyStudio.${name}`, async (item?: GemItem) => {
		try { await callback(item); } catch (error) { void vscode.window.showErrorMessage(vscode.l10n.t('Ruby Dependencies: {0}', error instanceof Error ? error.message : String(error))); }
	}));
	register('refreshGems', () => { environments?.refresh(); tree.refresh(); });
	if (environments) { disposables.push(environments.onDidChange(() => tree.refresh())); }
	register('bundleInstall', item => runTool(runtime, vscode.l10n.t('Bundle Install'), ['-S', 'bundle', 'install'], item));
	register('bundleUpdate', async item => {
		const chosen = await vscode.window.showQuickPick([
			{ label: vscode.l10n.t('Update All Gems'), gem: '' },
			{ label: vscode.l10n.t('Update a Specific Gem'), gem: '*' }
		], { placeHolder: vscode.l10n.t('Bundler Will Change Gemfile.lock') });
		if (!chosen) { return; }
		let name = chosen.gem;
		if (name === '*') {
			const input = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Gem to Update'), value: item?.gem?.name, validateInput: value => /^[a-zA-Z0-9][\w.-]*$/.test(value) ? undefined : vscode.l10n.t('Enter a single gem name.') });
			if (!input) { return; }
			name = input;
		}
		await runTool(runtime, vscode.l10n.t('Bundle Update'), ['-S', 'bundle', 'update', ...(name ? [name] : [])], item);
	});
	register('installGem', async item => {
		const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Gem to Install for the Selected Ruby SDK'), validateInput: value => /^[a-zA-Z0-9][\w.-]*$/.test(value) ? undefined : vscode.l10n.t('Enter a single gem name.') });
		if (!name) { return; }
		const version = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Optional Version Requirement (Blank for Latest)'), validateInput: value => !value || /^[\d\s.,<>=~a-zA-Z-]+$/.test(value) ? undefined : vscode.l10n.t('Enter a RubyGems version requirement.') });
		if (version === undefined) { return; }
		await runTool(runtime, vscode.l10n.t('Install Ruby Gem'), ['-S', 'gem', 'install', name, ...(version ? ['--version', version] : [])], item);
	});
	register('gemDependencies', async item => {
		const folder = await chooseFolder(item);
		if (!folder) { return; }
		const gems = parseGemfileLock(await fs.readFile(vscode.Uri.joinPath(folder.uri, 'Gemfile.lock').fsPath, 'utf8'));
		const chosen = await vscode.window.showQuickPick(gems.map(gem => ({ label: gem.name, description: gem.version, detail: gem.dependencies.join(', '), gem })), { placeHolder: vscode.l10n.t('Search Locked Gem Dependencies'), matchOnDetail: true });
		if (chosen) { await vscode.commands.executeCommand('vscode.open', vscode.Uri.joinPath(folder.uri, 'Gemfile.lock'), { selection: new vscode.Range(chosen.gem.line, 0, chosen.gem.line, 0) }); }
	});
	const watcher = vscode.workspace.createFileSystemWatcher('**/Gemfile.lock');
	disposables.push(watcher, watcher.onDidChange(() => tree.refresh()), watcher.onDidCreate(() => tree.refresh()), watcher.onDidDelete(() => tree.refresh()), vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()));
	return disposables;
}
