/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as fs from 'fs/promises';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { RuntimeService, normalizeRubyArguments } from './runtime';

const execute = promisify(execFile);
const categories = [
	['Models', 'app/models'], ['Controllers', 'app/controllers'], ['Views', 'app/views'],
	['Jobs', 'app/jobs'], ['Mailers', 'app/mailers'], ['Helpers', 'app/helpers'],
	['Routes', 'config/routes.rb'], ['Migrations', 'db/migrate'], ['Schema', 'db/schema.rb']
];

async function exists(file: string): Promise<boolean> {
	try { await fs.access(file); return true; } catch { return false; }
}

async function chooseFolder(): Promise<vscode.WorkspaceFolder | undefined> {
	const folders = vscode.workspace.workspaceFolders || [];
	if (folders.length === 1) { return folders[0]; }
	if (folders.length > 1) { return vscode.window.showWorkspaceFolderPick(); }
	void vscode.window.showInformationMessage(vscode.l10n.t('Open a project folder first.'));
	return undefined;
}

async function trusted(): Promise<boolean> {
	if (vscode.workspace.isTrusted) { return true; }
	void vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before running Ruby or Rails commands.'));
	return false;
}

class RailsItem extends vscode.TreeItem {
	constructor(label: string, readonly uri: vscode.Uri, readonly folder: vscode.WorkspaceFolder, directory: boolean) {
		super(label, directory ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None);
		this.resourceUri = uri;
		if (!directory) { this.command = { command: 'vscode.open', title: vscode.l10n.t('Open'), arguments: [uri] }; }
	}
}

class RailsTree implements vscode.TreeDataProvider<RailsItem>, vscode.Disposable {
	private readonly changed = new vscode.EventEmitter<RailsItem | undefined>();
	readonly onDidChangeTreeData = this.changed.event;
	refresh(): void { this.changed.fire(undefined); }
	dispose(): void { this.changed.dispose(); }
	getTreeItem(item: RailsItem): RailsItem { return item; }
	async getChildren(item?: RailsItem): Promise<RailsItem[]> {
		if (!item) {
			const roots: RailsItem[] = [];
			for (const folder of vscode.workspace.workspaceFolders || []) {
				if (await exists(path.join(folder.uri.fsPath, 'config/application.rb'))) {
					roots.push(new RailsItem(folder.name, folder.uri, folder, true));
				}
			}
			return roots;
		}
		if (item.uri.fsPath === item.folder.uri.fsPath) {
			const items: RailsItem[] = [];
			for (const [label, relative] of categories) {
				const file = path.join(item.uri.fsPath, relative);
				try {
					const stat = await fs.stat(file);
					items.push(new RailsItem(vscode.l10n.t(label), vscode.Uri.file(file), item.folder, stat.isDirectory()));
				} catch { /* Categories appear only when present in this project. */ }
			}
			return items;
		}
		const entries = await fs.readdir(item.uri.fsPath, { withFileTypes: true });
		return entries.filter(entry => !entry.isSymbolicLink() && !entry.name.startsWith('.')).sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name)).map(entry => new RailsItem(entry.name, vscode.Uri.joinPath(item.uri, entry.name), item.folder, entry.isDirectory()));
	}
}

interface RailsRoute extends vscode.QuickPickItem {
	controller?: string;
	action?: string;
	source?: string;
	line?: number;
}

/** Parses Rails' expanded route output; no routes are invented when output is absent. */
export function parseRailsRoutes(output: string): RailsRoute[] {
	return output.split(/^--\[ Route[^\n]*$/m).flatMap(block => {
		const fields = new Map<string, string>();
		for (const line of block.split('\n')) {
			const separator = line.indexOf('|');
			if (separator >= 0) { fields.set(line.slice(0, separator).trim(), line.slice(separator + 1).trim()); }
		}
		const uri = fields.get('URI');
		if (!uri) { return []; }
		const endpoint = fields.get('Controller#Action') || '';
		const [controller, action] = endpoint.split('#');
		const location = fields.get('Source Location')?.match(/^(?<file>.+):(?<line>\d+)$/);
		return [{ label: `${fields.get('Verb') || 'ANY'} ${uri}`, description: fields.get('Prefix'), detail: endpoint, controller, action, source: location?.groups?.file, line: Number(location?.groups?.line || 1) - 1 }];
	});
}

async function railsFolder(): Promise<vscode.WorkspaceFolder | undefined> {
	const folder = await chooseFolder();
	if (folder && await exists(path.join(folder.uri.fsPath, 'bin/rails'))) { return folder; }
	if (folder) { void vscode.window.showErrorMessage(vscode.l10n.t('This folder has no bin/rails. Open a Rails application or create one.')); }
	return undefined;
}

async function runRails(runtime: RuntimeService, name: string, args: string[], folder?: vscode.WorkspaceFolder): Promise<void> {
	if (!await trusted()) { return; }
	folder ||= await railsFolder();
	if (folder) {
		const rubyArgs = [path.join(folder.uri.fsPath, 'bin/rails'), ...args];
		if (args[0] === 'console') { await runtime.terminal(name, rubyArgs, folder); }
		else { await runtime.task(name, 'ruby', rubyArgs, folder); }
	}
}

async function showRoutes(runtime: RuntimeService): Promise<void> {
	if (!await trusted()) { return; }
	const folder = await railsFolder();
	if (!folder) { return; }
	const sdk = await runtime.get(folder);
	if (!sdk) { return; }
	const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Reading Rails Routes') }, async () => execute(sdk.ruby, [path.join(folder.uri.fsPath, 'bin/rails'), 'routes', '--expanded'], { cwd: sdk.cwd, env: sdk.env, timeout: 60000, maxBuffer: 8 * 1024 * 1024 }));
	const routes = parseRailsRoutes(result.stdout);
	if (!routes.length) { void vscode.window.showInformationMessage(vscode.l10n.t('Rails returned no expanded routes.')); return; }
	const selected = await vscode.window.showQuickPick(routes, { placeHolder: vscode.l10n.t('Search Rails Routes'), matchOnDescription: true, matchOnDetail: true });
	if (!selected) { return; }
	const controller = selected.controller && !selected.controller.includes(' ') ? path.join(folder.uri.fsPath, 'app/controllers', `${selected.controller}_controller.rb`) : undefined;
	let target = selected.source ? path.resolve(folder.uri.fsPath, selected.source) : controller && await exists(controller) ? controller : path.join(folder.uri.fsPath, 'config/routes.rb');
	if (!await exists(target)) { target = path.join(folder.uri.fsPath, 'config/routes.rb'); }
	const document = await vscode.workspace.openTextDocument(target);
	let line = selected.source ? selected.line || 0 : 0;
	if (!selected.source && target === controller && selected.action) {
		const found = document.getText().split('\n').findIndex(text => new RegExp(`^\\s*def\\s+${selected.action!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(text));
		if (found >= 0) { line = found; }
	}
	line = Math.min(Math.max(line, 0), document.lineCount - 1);
	await vscode.window.showTextDocument(document, { selection: new vscode.Range(line, 0, line, 0) });
}

async function relatedFile(): Promise<void> {
	const editor = vscode.window.activeTextEditor;
	const folder = editor && vscode.workspace.getWorkspaceFolder(editor.document.uri);
	if (!editor || !folder) { return; }
	const relative = path.relative(folder.uri.fsPath, editor.document.uri.fsPath).replace(/\\/g, '/');
	const controller = relative.match(/^app\/controllers\/(?<name>.+)_controller\.rb$/)?.groups?.name;
	const view = relative.match(/^app\/views\/(?<name>.+)\/[^/]+$/)?.groups?.name;
	const model = relative.match(/^app\/models\/(?<name>.+)\.rb$/)?.groups?.name;
	const stem = controller || view || model;
	if (!stem) { void vscode.window.showInformationMessage(vscode.l10n.t('Open a Rails controller, view or model to find related files.')); return; }
	const singular = stem.endsWith('ies') ? `${stem.slice(0, -3)}y` : stem.endsWith('s') && !stem.endsWith('ss') ? stem.slice(0, -1) : stem;
	const plural = stem === singular ? `${stem}s` : stem;
	const action = controller ? editor.document.getText(new vscode.Range(0, 0, editor.selection.active.line, editor.selection.active.character)).match(/\bdef\s+\w+/g)?.at(-1)?.replace(/^def\s+/, '') : undefined;
	const patterns = [
		...(action ? [`app/views/${stem}/${action}.*`] : []),
		`app/models/${singular}.rb`, `spec/models/${singular}_spec.rb`, `test/models/${singular}_test.rb`,
		`app/controllers/${plural}_controller.rb`, `app/views/${plural}/**/*`,
		`app/controllers/${stem}_controller.rb`, `app/views/${stem}/**/*`, `app/helpers/${stem}_helper.rb`,
		`app/models/${stem}.rb`, `spec/controllers/${stem}_controller_spec.rb`, `spec/requests/${stem}*`,
		`spec/models/${stem}_spec.rb`, `test/controllers/${stem}_controller_test.rb`, `test/models/${stem}_test.rb`
	];
	const files = (await Promise.all(patterns.map(pattern => vscode.workspace.findFiles(new vscode.RelativePattern(folder, pattern), '**/{node_modules,vendor,.git}/**', 500)))).flat();
	const unique = [...new Map(files.map(uri => [uri.fsPath, uri])).values()].filter(uri => uri.fsPath !== editor.document.uri.fsPath);
	const selected = await vscode.window.showQuickPick(unique.map(uri => ({ label: path.relative(folder.uri.fsPath, uri.fsPath), uri })), { placeHolder: vscode.l10n.t('Open Related Rails File') });
	if (selected) { await vscode.window.showTextDocument(selected.uri); }
}

/** Keep Rails action names distinct from attribute declarations and never parse shell syntax. */
export function parseRailsGeneratorArguments(generator: string, value: string): string[] | undefined {
	const args = value.trim().split(/\s+/).filter(Boolean);
	if (generator === 'job') { return args.length ? undefined : []; }
	if (['controller', 'mailer', 'channel'].includes(generator)) {
		return args.every(arg => /^[a-zA-Z_]\w*$/.test(arg)) ? args : undefined;
	}
	if (['model', 'migration', 'scaffold', 'resource'].includes(generator)) {
		return args.every(arg => /^[A-Za-z_]\w*:[\w{}:,.-]+$/.test(arg)) ? args : undefined;
	}
	return undefined;
}

async function generateRails(runtime: RuntimeService): Promise<void> {
	if (!await trusted()) { return; }
	const folder = await railsFolder();
	if (!folder) { return; }
	const generator = await vscode.window.showQuickPick(['model', 'controller', 'migration', 'scaffold', 'job', 'mailer', 'channel', 'resource'], { placeHolder: vscode.l10n.t('Choose a Rails Generator') });
	if (!generator) { return; }
	const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Generator Name (For Example, User or Admin::Users)'), validateInput: value => /^(?:[A-Za-z]\w*::)*[A-Za-z]\w*$/.test(value) ? undefined : vscode.l10n.t('Enter a Ruby class or migration name.') });
	if (!name) { return; }
	const actions = ['controller', 'mailer', 'channel'].includes(generator);
	const input = generator === 'job' ? '' : await vscode.window.showInputBox({
		prompt: actions ? vscode.l10n.t('Actions Separated by Spaces (For Example, index show)') : vscode.l10n.t('Attributes Separated by Spaces (For Example, name:string age:integer)'),
		value: '',
		validateInput: value => parseRailsGeneratorArguments(generator, value) ? undefined : actions ? vscode.l10n.t('Use action names separated by spaces.') : vscode.l10n.t('Use attribute:type tokens. Options and shell expressions are not accepted.')
	});
	if (input === undefined) { return; }
	const args = parseRailsGeneratorArguments(generator, input);
	if (!args) { return; }
	await runRails(runtime, vscode.l10n.t('Rails Generator'), ['generate', generator, name, ...args], folder);
}

async function createProject(runtime: RuntimeService): Promise<void> {
	if (!await trusted()) { return; }
	const kind = await vscode.window.showQuickPick(['Ruby Project', 'Ruby Gem', 'Rails Application']);
	if (!kind) { return; }
	const parent = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: vscode.l10n.t('Choose Parent Folder') });
	if (!parent?.length) { return; }
	const name = await vscode.window.showInputBox({ prompt: vscode.l10n.t('Project Name'), validateInput: value => /^[a-z][a-z0-9_]*$/.test(value) ? undefined : vscode.l10n.t('Use lowercase letters, digits and underscores, starting with a letter.') });
	if (!name) { return; }
	const destination = path.join(parent[0].fsPath, name);
	if (await exists(destination)) { throw new Error(vscode.l10n.t('The destination already exists. Choose a new name.')); }
	if (kind === 'Rails Application') {
		const folder: vscode.WorkspaceFolder = { uri: parent[0], name: path.basename(parent[0].fsPath), index: 0 };
		const sdk = await runtime.get(folder);
		if (!sdk) { return; }
		try { await execute(sdk.ruby, normalizeRubyArguments(['-S', 'rails', '--version']), { cwd: parent[0].fsPath, env: sdk.env, timeout: 15000 }); }
		catch { void vscode.window.showErrorMessage(vscode.l10n.t('Rails is unavailable for the selected Ruby SDK. Use Install Gem to install rails, then create the application again.')); return; }
		// Rails otherwise derives a shebang from Gem.ruby, whose quoted path can
		// leave a trailing quote when the selected SDK lives in a path with spaces.
		await runtime.terminal(vscode.l10n.t('Create Rails Application'), ['-S', 'rails', 'new', destination, '--ruby=ruby'], folder);
		void vscode.window.showInformationMessage(vscode.l10n.t('Rails is creating the application in the terminal. Open the destination folder when it finishes.'));
		return;
	}
	await fs.mkdir(path.join(destination, 'lib'), { recursive: true });
	await fs.mkdir(path.join(destination, 'test'));
	await fs.writeFile(path.join(destination, 'Gemfile'), `source 'https://rubygems.org'\n${kind === 'Ruby Gem' ? 'gemspec\n' : "gem 'minitest'\n"}`);
	await fs.writeFile(path.join(destination, 'README.md'), `# ${name}\n\nA Ruby project created with Ruby Studio.\n`);
	await fs.writeFile(path.join(destination, '.gitignore'), '/.bundle/\n/vendor/bundle/\n/coverage/\n');
	if (kind === 'Ruby Gem') {
		const moduleName = name.split('_').map(part => part[0].toUpperCase() + part.slice(1)).join('');
		await fs.writeFile(path.join(destination, 'lib', `${name}.rb`), `module ${moduleName}\n  VERSION = '0.1.0'\nend\n`);
		await fs.writeFile(path.join(destination, `${name}.gemspec`), `require_relative 'lib/${name}'\n\nGem::Specification.new do |spec|\n  spec.name = '${name}'\n  spec.version = ${moduleName}::VERSION\n  spec.summary = 'Describe your gem'\n  spec.authors = ['Your Name']\n  spec.files = Dir['lib/**/*.rb']\n  spec.require_paths = ['lib']\nend\n`);
	} else { await fs.writeFile(path.join(destination, 'main.rb'), "puts 'Hello, Ruby!'\n"); }
	await vscode.commands.executeCommand('vscode.openFolder', vscode.Uri.file(destination), { forceNewWindow: true });
}

/** Registers Rails navigation and explicit execution workflows. */
export function registerRails(_context: vscode.ExtensionContext, runtime: RuntimeService): vscode.Disposable[] {
	const tree = new RailsTree();
	const disposables: vscode.Disposable[] = [tree, vscode.window.registerTreeDataProvider('rubyStudio.rails', tree)];
	const register = (command: string, callback: () => Promise<void> | void) => disposables.push(vscode.commands.registerCommand(`rubyStudio.${command}`, async () => {
		try { await callback(); } catch (error) { void vscode.window.showErrorMessage(vscode.l10n.t('Rails: {0}', error instanceof Error ? error.message : String(error))); }
	}));
	register('refreshRails', () => tree.refresh());
	register('railsRoutes', () => showRoutes(runtime));
	register('railsConsole', () => runRails(runtime, vscode.l10n.t('Rails Console'), ['console']));
	register('railsServer', () => runRails(runtime, vscode.l10n.t('Rails Server'), ['server']));
	register('migrateRails', () => runRails(runtime, vscode.l10n.t('Rails Migrations'), ['db:migrate']));
	register('generateRails', () => generateRails(runtime));
	register('relatedFile', relatedFile);
	register('createProject', () => createProject(runtime));
	disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => tree.refresh()));
	return disposables;
}
