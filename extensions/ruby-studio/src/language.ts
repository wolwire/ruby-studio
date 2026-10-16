/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import { ChildProcess, execFile } from 'node:child_process';
import type { RuntimeService } from './runtime';
import { extractRubyLiteral, maskRubyTemplate, parseRubySyntaxOutput, RenameFailure, RubyDocument, RubyIndex, RubySymbol, RubySymbolKind, rubyWhitespaceEdits } from './languageModel';
import { registerRubyNavigation } from './languageNavigation';
import { NativeRubyLexer } from './nativeLexer';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { ProjectEnvironmentService } from './projectEnvironment';

const sourceName = 'Ruby Studio';
const includePattern = '**/{*.rb,*.rake,*.gemspec,*.ru,*.erb,Gemfile,Rakefile,Guardfile,Vagrantfile}';
const excludePattern = '**/{vendor,node_modules,.git,.bundle,.runtime,coverage,tmp,log}/**';
const maxDocumentBytes = 512 * 1024;
const selector: vscode.DocumentSelector = [{ language: 'ruby', scheme: 'file' }, { language: 'ruby', scheme: 'untitled' }, { language: 'erb', scheme: 'file' }];
const snippets: [string, string, string][] = [
	['def', 'def ${1:method_name}(${2:arguments})\n  $0\nend', 'Define Method'],
	['class', 'class ${1:ClassName}\n  $0\nend', 'Define Class'],
	['module', 'module ${1:ModuleName}\n  $0\nend', 'Define Module'],
	['if', 'if ${1:condition}\n  $0\nend', 'If Statement'],
	['each', '${1:collection}.each do |${2:item}|\n  $0\nend', 'Each Block'],
	['begin', 'begin\n  $0\nrescue ${1:StandardError} => ${2:error}\n  \nend', 'Begin and Rescue'],
];

function isRuby(document: vscode.TextDocument): boolean { return document.languageId === 'ruby' || document.languageId === 'erb'; }
function isTemplate(document: vscode.TextDocument): boolean { return document.languageId === 'erb' || document.uri.path.endsWith('.erb'); }
function configuration(document?: vscode.TextDocument): vscode.WorkspaceConfiguration { return vscode.workspace.getConfiguration('rubyStudio', document?.uri); }
function range(document: vscode.TextDocument, start: number, end: number): vscode.Range { return new vscode.Range(document.positionAt(start), document.positionAt(end)); }
function project(uri: vscode.Uri): string { return vscode.workspace.getWorkspaceFolder(uri)?.uri.toString() || uri.toString(); }
function symbolKind(kind: RubySymbolKind): vscode.SymbolKind {
	switch (kind) {
		case 'class': return vscode.SymbolKind.Class;
		case 'module': return vscode.SymbolKind.Module;
		case 'method': return vscode.SymbolKind.Method;
		case 'constant': return vscode.SymbolKind.Constant;
		case 'instanceVariable': return vscode.SymbolKind.Field;
		default: return vscode.SymbolKind.Variable;
	}
}
function completionKind(kind: RubySymbolKind): vscode.CompletionItemKind {
	switch (kind) {
		case 'class': return vscode.CompletionItemKind.Class;
		case 'module': return vscode.CompletionItemKind.Module;
		case 'method': return vscode.CompletionItemKind.Method;
		case 'constant': return vscode.CompletionItemKind.Constant;
		case 'instanceVariable': return vscode.CompletionItemKind.Field;
		default: return vscode.CompletionItemKind.Variable;
	}
}
function signature(symbol: RubySymbol): string { return symbol.kind === 'method' ? `${symbol.singleton ? 'self.' : ''}${symbol.name}(${symbol.parameters.map(parameter => parameter.label).join(', ')})` : `${symbol.kind} ${symbol.qualifiedName}`; }
function renameFailure(reason: RenameFailure): string {
	switch (reason) {
		case 'dynamicMethod': return vscode.l10n.t('Ruby method rename is unavailable: dynamic dispatch cannot be safely rewritten by the lexical index.');
		case 'unsupportedVariable': return vscode.l10n.t('Rename supports explicit locals, positional parameters and unambiguous constants. Implicit numbered parameters and dynamic variables cannot be renamed.');
		case 'keywordParameter': return vscode.l10n.t('Renaming a keyword parameter would change its public call interface. This refactoring is not supported.');
		case 'reflection': return vscode.l10n.t('Rename was refused because reflection or eval can access this binding dynamically.');
		case 'interpolation': return vscode.l10n.t('Rename was refused because the name also occurs in a literal, symbol or string interpolation that needs semantic analysis.');
		case 'unsupportedSyntax': return vscode.l10n.t('Rename was refused because this source contains scopes or namespace forms the lexical index cannot prove safe.');
		case 'incompleteIndex': return vscode.l10n.t('Constant rename requires a complete workspace index. Check the language index output for skipped files or indexing limits.');
		case 'ambiguousConstant': return vscode.l10n.t('This constant has multiple declarations. Reopened or reassigned constants cannot be safely renamed by this index.');
		case 'collision': return vscode.l10n.t('The new name conflicts with another binding or would capture references in a nested scope.');
		case 'invalidName': return vscode.l10n.t('Use a valid Ruby local name, or an uppercase name for a constant. Reserved words and numbered block parameters are not allowed.');
		default: return vscode.l10n.t('No statically resolved Ruby binding is available at this position.');
	}
}

/** Owns the original static index, provider registrations and optional Ruby syntax checks. */
class RubyLanguageService implements vscode.Disposable {
	readonly index = new RubyIndex();
	private readonly disposables: vscode.Disposable[] = [];
	private readonly whitespace = vscode.languages.createDiagnosticCollection('rubyStudio.whitespace');
	private readonly syntax = vscode.languages.createDiagnosticCollection('rubyStudio.syntax');
	private readonly output = vscode.window.createOutputChannel(vscode.l10n.t('Ruby Studio Language'));
	private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly checks = new Map<string, ChildProcess>();
	private readonly pendingModels = new Map<string, Promise<RubyDocument | undefined>>();
	private readonly revisions = new Map<string, number>();
	private readonly native: NativeRubyLexer;
	private indexing: Promise<void> = Promise.resolve();
	private generation = 0;
	private disposed = false;
	readonly externalUris = new Set<string>();
	private librarySignature = '';

	constructor(context: vscode.ExtensionContext, private readonly runtime: RuntimeService, private readonly environments?: ProjectEnvironmentService) {
		this.native = new NativeRubyLexer(context.extensionUri.fsPath, message => this.output.appendLine(vscode.l10n.t('Native Ruby Worker: {0}', message)));
		this.disposables.push(this.native);
		this.disposables.push(this.whitespace, this.syntax, this.output);
		const watcher = vscode.workspace.createFileSystemWatcher(includePattern);
		this.disposables.push(watcher,
			watcher.onDidCreate(uri => { void this.readFile(uri); }),
			watcher.onDidChange(uri => { void this.readFile(uri); }),
			watcher.onDidDelete(uri => { this.touch(uri.toString()); this.index.remove(uri.toString()); this.syntax.delete(uri); this.whitespace.delete(uri); this.cancelCheck(uri.toString()); }),
			vscode.workspace.onDidOpenTextDocument(document => this.changed(document)),
			vscode.workspace.onDidChangeTextDocument(event => this.changed(event.document)),
			vscode.workspace.onDidSaveTextDocument(document => this.changed(document, 20)),
			vscode.workspace.onDidCloseTextDocument(document => { this.cancelCheck(document.uri.toString()); if (document.uri.scheme === 'untitled') { this.index.remove(document.uri.toString()); } }),
			vscode.workspace.onDidChangeWorkspaceFolders(() => { this.indexing = this.rebuild(); }),
			vscode.workspace.onDidGrantWorkspaceTrust(() => { for (const document of vscode.workspace.textDocuments) { this.changed(document); } }),
			vscode.workspace.onDidChangeConfiguration(event => {
				if (event.affectsConfiguration('rubyStudio')) {
					for (const key of [...this.timers.keys(), ...this.checks.keys()]) { this.cancelCheck(key); }
					this.syntax.clear(); this.whitespace.clear();
					this.indexing = this.rebuild();
					for (const document of vscode.workspace.textDocuments) { this.changed(document); }
				}
			}),
			vscode.commands.registerCommand('rubyStudio.rebuildIndex', () => { this.indexing = this.rebuild(); return this.indexing; }),
			vscode.commands.registerCommand('rubyStudio.gotoClass', async () => {
				await this.ready();
				const selected = await vscode.window.showQuickPick([...this.index.documents.values()].flatMap(document => document.symbols.filter(symbol => ['class', 'module', 'constant'].includes(symbol.kind)).map(symbol => ({
					label: symbol.name, description: symbol.qualifiedName, detail: vscode.workspace.asRelativePath(vscode.Uri.parse(symbol.uri)), symbol,
				}))), { title: vscode.l10n.t('Go to Ruby Class'), placeHolder: vscode.l10n.t('Search Indexed Classes, Modules and Constants'), matchOnDescription: true, matchOnDetail: true });
				if (selected) {
					const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(selected.symbol.uri));
					await vscode.window.showTextDocument(document, { selection: range(document, selected.symbol.start, selected.symbol.end) });
				}
			}),
			vscode.commands.registerCommand('rubyStudio.languageStatus', () => {
				this.output.appendLine(vscode.l10n.t('Tokenization: {0}', this.native.status));
				this.output.appendLine(vscode.l10n.t('{0} documents, {1} declarations. Index complete: {2}.', this.index.documents.size, [...this.index.documents.values()].reduce((count, document) => count + document.symbols.length, 0), this.index.complete));
				this.output.appendLine(vscode.l10n.t('Static Ruby navigation supports explicit inheritance, constructors, super, bounded local receiver bindings, type/call hierarchy, qualified constants and keyword arguments. Mixins, refinements, metaprogramming, RBS inference and dynamic method rename remain unsupported. Formatting removes nonliteral trailing whitespace only; ERB Ruby tags retain template offsets.'));
				this.output.show(true);
			}),
			vscode.commands.registerCommand('rubyStudio.extractLocal', (uri: vscode.Uri, version: number, start: number, end: number) => this.extractLocal(uri, version, start, end)),
		);
		if (environments) { this.disposables.push(environments.onDidChange(() => { const signature = JSON.stringify([...environments.states.values()].map(state => [state.root, state.generation, state.dependencies.map(item => item.requireRoots)])); if (signature !== this.librarySignature) { this.librarySignature = signature; this.indexing = this.rebuild(); } })); }
		for (const document of vscode.workspace.textDocuments) { this.changed(document); }
		this.indexing = this.rebuild();
	}

	enabled(document?: vscode.TextDocument): boolean { return !this.disposed && configuration(document).get<boolean>('language.enabled', true); }
	private touch(key: string): number { const revision = (this.revisions.get(key) || 0) + 1; this.revisions.set(key, revision); return revision; }
	private changed(document: vscode.TextDocument, delay = 900): void {
		if (!isRuby(document) || !this.enabled(document)) { return; }
		if (document.getText().length > maxDocumentBytes) { this.index.remove(document.uri.toString()); this.index.complete = false; return; }
		void this.updateModel(document);
		this.cancelCheck(document.uri.toString()); this.syntax.delete(document.uri);
		if (isTemplate(document) || !vscode.workspace.isTrusted || !configuration(document).get<boolean>('syntaxCheck', true) || !configuration(document).get<boolean>('languageDiagnostics', true)) { return; }
		const version = document.version;
		this.timers.set(document.uri.toString(), setTimeout(() => { this.timers.delete(document.uri.toString()); void this.checkSyntax(document, version); }, delay));
	}

	/** Commits only the current document version after asynchronous native analysis. */
	private updateModel(document: vscode.TextDocument): Promise<RubyDocument | undefined> {
		const text = document.getText();
		const version = document.version;
		const generation = this.generation;
		const key = document.uri.toString();
		const revision = this.touch(key);
		const template = isTemplate(document);
		const pending = (async () => {
			try {
				const tokens = await this.native.tokenize(template ? maskRubyTemplate(text) : text);
				if (this.disposed || generation !== this.generation || this.revisions.get(key) !== revision || document.isClosed || document.version !== version || !this.enabled(document)) { return undefined; }
				const model = this.index.update(key, text, this.externalUris.has(key) ? this.index.documents.get(key)?.project || project(document.uri) : project(document.uri), template, tokens);
				this.updateWhitespace(document, model);
				return model;
			} catch (error) {
				this.index.complete = false;
				this.output.appendLine(error instanceof Error ? error.message : String(error));
				return undefined;
			}
		})();
		this.pendingModels.set(key, pending);
		void pending.finally(() => { if (this.pendingModels.get(key) === pending) { this.pendingModels.delete(key); } });
		return pending;
	}

	private updateWhitespace(document: vscode.TextDocument, model: RubyDocument): void {
		if (isTemplate(document) || !configuration(document).get<boolean>('languageDiagnostics', true)) { this.whitespace.delete(document.uri); return; }
		this.whitespace.set(document.uri, rubyWhitespaceEdits(document.getText(), model.tokens).map(edit => {
			const diagnostic = new vscode.Diagnostic(range(document, edit.start, edit.end), vscode.l10n.t('Trailing Whitespace'), vscode.DiagnosticSeverity.Hint);
			diagnostic.source = sourceName; diagnostic.code = 'trailing-whitespace'; diagnostic.tags = [vscode.DiagnosticTag.Unnecessary]; return diagnostic;
		}));
	}

	private async readFile(uri: vscode.Uri): Promise<void> {
		const generation = this.generation;
		const revision = this.touch(uri.toString());
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		const relative = folder ? path.relative(folder.uri.fsPath, uri.fsPath).split(path.sep).join('/') : uri.path;
		if (!this.enabled() || /(?:^|\/)(?:vendor|node_modules|\.git|\.bundle|\.runtime|coverage|tmp|log)(?:\/|$)/.test(relative)) { return; }
		const open = vscode.workspace.textDocuments.find(document => document.uri.toString() === uri.toString());
		if (open) { this.changed(open); return; }
		try {
			const stat = await vscode.workspace.fs.stat(uri);
			if (stat.size > maxDocumentBytes) { this.index.complete = false; this.output.appendLine(vscode.l10n.t('Skipped a file larger than 512 KiB: {0}', uri.fsPath)); return; }
			const text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
			if (text.includes('\0')) { this.index.complete = false; return; }
			const template = uri.path.endsWith('.erb');
			const tokens = await this.native.tokenize(template ? maskRubyTemplate(text) : text);
			if (!this.disposed && generation === this.generation && this.revisions.get(uri.toString()) === revision && !vscode.workspace.textDocuments.some(document => document.uri.toString() === uri.toString())) { this.index.update(uri.toString(), text, project(uri), template, tokens); }
		} catch (error) { this.index.complete = false; this.output.appendLine(vscode.l10n.t('Could Not Index {0}: {1}', uri.fsPath, error instanceof Error ? error.message : String(error))); }
	}

	private async rebuild(): Promise<void> {
		const generation = ++this.generation;
		for (const state of this.environments?.states.values() || []) { this.environments?.reportIndex(state.root, state.generation, { project: 'indexing', libraries: state.dependencies.length ? 'indexing' : 'pending', skippedRoots: [] }); }
		this.index.clear(); this.externalUris.clear(); this.index.complete = false;
		if (!this.enabled()) { for (const state of this.environments?.states.values() || []) { this.environments?.reportIndex(state.root, state.generation, { project: 'partial', libraries: 'partial', skippedRoots: [state.root] }); } return; }
		const maximum = Math.max(1, Math.min(10000, configuration().get<number>('maxIndexedFiles', 2000)));
		try {
			const files = await vscode.workspace.findFiles(includePattern, excludePattern, maximum + 1);
			if (generation !== this.generation || this.disposed) { return; }
			this.index.complete = files.length <= maximum;
			for (let i = 0; i < Math.min(files.length, maximum); i += 8) {
				if (generation !== this.generation || this.disposed) { return; }
				await Promise.all(files.slice(i, Math.min(i + 8, maximum)).map(uri => this.readFile(uri)));
			}
			await this.indexLibraries(generation);
			if (files.length > maximum) { this.output.appendLine(vscode.l10n.t('Index Limited to {0} Files. Increase rubyStudio.maxIndexedFiles to include more.', maximum)); }
			for (const document of vscode.workspace.textDocuments) { if (isRuby(document)) { this.changed(document); await this.pendingModels.get(document.uri.toString()); if (generation !== this.generation || this.disposed) { return; } } }
			this.output.appendLine(vscode.l10n.t('Indexed {0} Ruby and ERB Documents. Complete: {1}.', this.index.documents.size, this.index.complete));
		} catch (error) { this.index.complete = false; this.output.appendLine(error instanceof Error ? error.message : String(error)); }
	}

	private async indexLibraries(generation: number): Promise<void> {
		if (!this.environments) { return; }
		const states = [...this.environments.states.values()];
		const projectComplete = this.index.complete;
		const roots = new Map<string, string[]>();
		for (const state of states) { for (const dependency of state.dependencies) { for (const root of dependency.requireRoots) { const owners = roots.get(root) || []; if (!owners.includes(state.root)) { owners.push(state.root); } roots.set(root, owners); } } }
		const visited = new Set<string>(); let count = 0; const skipped = new Set<string>();
		const maximum = Math.max(1, Math.min(20000, configuration().get<number>('maxLibraryFiles', 4000)));
		const entries = new Map<string, Set<string>>();
		const visit = async (directory: string, owners: string[], depth = 0): Promise<void> => {
			if (generation !== this.generation || this.disposed) { return; }
			if (depth > 32 || count >= maximum) { skipped.add(directory); return; }
			let children; try { children = await fs.readdir(directory, { withFileTypes: true }); } catch { skipped.add(directory); return; }
			for (const child of children) {
				if (child.isSymbolicLink() || ['.git', 'node_modules', 'vendor', 'test', 'spec'].includes(child.name)) { continue; }
				const file = path.join(directory, child.name);
				if (child.isDirectory()) { await visit(file, owners, depth + 1); }
				else if (child.isFile() && /\.(?:rb|rake)$/.test(child.name)) {
					if (!visited.has(file)) { if (count >= maximum) { skipped.add(directory); break; } visited.add(file); count++; }
					const set = entries.get(file) || new Set<string>(); owners.forEach(owner => set.add(owner)); entries.set(file, set);
				}
			}
		};
		for (const [root, owners] of roots) { await visit(root, owners); }
		for (const [file, owners] of entries) {
			if (generation !== this.generation || this.disposed) { return; }
			try {
				const stat = await fs.stat(file); if (stat.size > maxDocumentBytes) { skipped.add(file); continue; }
				const text = await fs.readFile(file, 'utf8'); if (text.includes('\0')) { skipped.add(file); continue; }
				const uri = vscode.Uri.file(file).toString(); if (this.index.documents.has(uri)) { continue; }
				const tokens = await this.native.tokenize(text); if (generation !== this.generation || this.disposed) { return; }
				this.index.updateLibrary(uri, text, [...owners].map(root => vscode.Uri.file(root).toString()), tokens, true); this.externalUris.add(uri);
			} catch { skipped.add(file); }
		}
		this.index.commitLibraries();
		if (skipped.size) { this.index.complete = false; }
		for (const state of states) { this.environments.reportIndex(state.root, state.generation, { project: projectComplete ? 'ready' : 'partial', libraries: skipped.size || ['resolving', 'missing-bundler', 'missing-gems', 'error'].includes(state.bundle) || !['ready', 'mismatch'].includes(state.sdk) ? 'partial' : 'ready', skippedRoots: [...skipped] }); }
	}

	async ready(): Promise<void> {
		let pending = this.indexing;
		do { pending = this.indexing; await pending; } while (pending !== this.indexing);
	}

	async ensure(document: vscode.TextDocument): Promise<RubyDocument | undefined> {
		if (!this.enabled(document)) { return undefined; }
		await this.ready();
		if (this.disposed || document.getText().length > maxDocumentBytes) { return undefined; }
		await this.pendingModels.get(document.uri.toString());
		const cached = this.index.documents.get(document.uri.toString());
		return cached?.text === document.getText() ? cached : this.updateModel(document);
	}

	private cancelCheck(key: string): void {
		const timer = this.timers.get(key); if (timer) { clearTimeout(timer); this.timers.delete(key); }
		const child = this.checks.get(key); if (child) { this.checks.delete(key); child.kill(); }
	}

	private async checkSyntax(document: vscode.TextDocument, version: number): Promise<void> {
		const generation = this.generation;
		if (this.disposed || document.isClosed || document.version !== version || !vscode.workspace.isTrusted) { return; }
		try {
			const sdk = await this.runtime.get(vscode.workspace.getWorkspaceFolder(document.uri));
			if (this.disposed || generation !== this.generation || document.isClosed || document.version !== version || !vscode.workspace.isTrusted || !this.enabled(document) || !configuration(document).get<boolean>('syntaxCheck', true) || !configuration(document).get<boolean>('languageDiagnostics', true)) { return; }
			const key = document.uri.toString();
			const child = execFile(sdk.ruby, ['-c', '-'], { cwd: sdk.cwd, env: sdk.env, encoding: 'utf8', timeout: 10000, maxBuffer: 1024 * 1024, windowsHide: true }, (error, stdout, stderr) => {
				if (this.checks.get(key) !== child) { return; }
				this.checks.delete(key);
				if (this.disposed || document.isClosed || document.version !== version) { return; }
				const parsed = parseRubySyntaxOutput(`${stdout}\n${stderr}`);
				this.syntax.set(document.uri, parsed.map(problem => {
					const line = document.lineAt(Math.min(problem.line, document.lineCount - 1));
					const diagnostic = new vscode.Diagnostic(line.range, problem.message, problem.warning ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error);
					diagnostic.source = sourceName; diagnostic.code = 'ruby-syntax'; return diagnostic;
				}));
				if (error && !parsed.length) { this.output.appendLine(vscode.l10n.t('Ruby Syntax Check Failed: {0}', error.message)); }
			});
			this.checks.set(key, child);
			child.stdin?.on('error', () => { /* A cancelled or failed Ruby process can close stdin early. */ });
			child.stdin?.end(document.getText());
		} catch (error) { if (!this.disposed) { this.output.appendLine(vscode.l10n.t('Ruby Syntax Check Unavailable: {0}', error instanceof Error ? error.message : String(error))); } }
	}

	private async extractLocal(uri: vscode.Uri, version: number, start: number, end: number): Promise<void> {
		const document = await vscode.workspace.openTextDocument(uri);
		if (document.version !== version) { void vscode.window.showInformationMessage(vscode.l10n.t('The document changed. Select the literal again before extracting.')); return; }
		const model = await this.ensure(document);
		if (!model || isTemplate(document) || !extractRubyLiteral(model, start, end)) { return; }
		const name = await vscode.window.showInputBox({
			prompt: vscode.l10n.t('Name for the Extracted Literal'),
			validateInput: value => extractRubyLiteral(model, start, end, value) ? undefined : vscode.l10n.t('Use a fresh Ruby local name that does not occur in this file.'),
		});
		if (!name || document.version !== version) { return; }
		const edits = extractRubyLiteral(model, start, end, name); if (!edits) { return; }
		const edit = new vscode.WorkspaceEdit(); for (const item of edits) { edit.replace(uri, range(document, item.start, item.end), item.text); }
		await vscode.workspace.applyEdit(edit);
	}

	dispose(): void {
		this.disposed = true; this.generation++;
		for (const key of [...this.timers.keys(), ...this.checks.keys()]) { this.cancelCheck(key); }
		for (const disposable of this.disposables) { disposable.dispose(); }
		this.revisions.clear(); this.pendingModels.clear();
		this.index.clear();
	}
}

/** Registers original lexical providers; static indexing is usable in untrusted workspaces. */
export function registerLanguage(context: vscode.ExtensionContext, runtime: RuntimeService, environments?: ProjectEnvironmentService): vscode.Disposable[] {
	const service = new RubyLanguageService(context, runtime, environments);
	const disposables: vscode.Disposable[] = [service, ...registerRubyNavigation(service, selector)];
	disposables.push(vscode.languages.registerDocumentSymbolProvider(selector, {
		async provideDocumentSymbols(document, token) {
			const model = await service.ensure(document); if (!model || token.isCancellationRequested) { return []; }
			const symbols = model.symbols.filter(symbol => ['class', 'module', 'method', 'constant'].includes(symbol.kind));
			const mapped = new Map(symbols.map(symbol => [symbol.id, new vscode.DocumentSymbol(symbol.name, symbol.qualifiedName, symbolKind(symbol.kind), range(document, symbol.bodyStart, Math.max(symbol.bodyEnd, symbol.end)), range(document, symbol.start, symbol.end))]));
			const roots: vscode.DocumentSymbol[] = [];
			for (const symbol of symbols) { const item = mapped.get(symbol.id)!; const parent = symbol.parentSymbolId && mapped.get(symbol.parentSymbolId); if (parent) { parent.children.push(item); } else { roots.push(item); } }
			return roots;
		}
	}));
	disposables.push(vscode.languages.registerWorkspaceSymbolProvider({
		async provideWorkspaceSymbols(query, token) {
			if (!service.enabled()) { return []; }
			await service.ready();
			const results: vscode.SymbolInformation[] = [];
			for (const model of service.index.documents.values()) {
				if (token.isCancellationRequested) { return []; }
				for (const symbol of model.symbols) {
					if (!['class', 'module', 'method', 'constant'].includes(symbol.kind) || !symbol.qualifiedName.toLowerCase().includes(query.toLowerCase())) { continue; }
					const before = model.text.slice(0, symbol.start); const line = before.split('\n').length - 1; const column = symbol.start - (before.lastIndexOf('\n') + 1);
					results.push(new vscode.SymbolInformation(symbol.name, symbolKind(symbol.kind), symbol.owner, new vscode.Location(vscode.Uri.parse(symbol.uri), new vscode.Range(line, column, line, column + symbol.end - symbol.start))));
					if (results.length >= 500) { return results; }
				}
			}
			return results;
		}
	}));
	disposables.push(vscode.languages.registerDefinitionProvider(selector, {
		async provideDefinition(document, position, token) {
			if (!await service.ensure(document) || token.isCancellationRequested) { return undefined; }
			const found = service.index.resolve(document.uri.toString(), document.offsetAt(position));
			if (!found?.definitions.length) { return undefined; }
			return Promise.all([...found.definitions].sort((a, b) => Number(service.externalUris.has(a.uri)) - Number(service.externalUris.has(b.uri)) || Number(b.uri === document.uri.toString()) - Number(a.uri === document.uri.toString())).map(async symbol => { const target = await vscode.workspace.openTextDocument(vscode.Uri.parse(symbol.uri)); return new vscode.Location(target.uri, range(target, symbol.start, symbol.end)); }));
		}
	}));
	disposables.push(vscode.languages.registerReferenceProvider(selector, {
		async provideReferences(document, position, context, token) {
			if (!await service.ensure(document) || token.isCancellationRequested) { return []; }
			const found = service.index.resolve(document.uri.toString(), document.offsetAt(position)); if (!found?.definitions.length) { return []; }
			const references = [...new Map(found.definitions.flatMap(symbol => service.index.references(symbol, context.includeDeclaration)).map(item => [`${item.uri}:${item.start}`, item])).values()];
			return Promise.all(references.map(async item => { const target = await vscode.workspace.openTextDocument(vscode.Uri.parse(item.uri)); return new vscode.Location(target.uri, range(target, item.start, item.end)); }));
		}
	}));
	disposables.push(vscode.languages.registerRenameProvider(selector, {
		async prepareRename(document, position, token) {
			if (!await service.ensure(document) || token.isCancellationRequested) { throw new Error(renameFailure('noSymbol')); }
			const result = service.index.rename(document.uri.toString(), document.offsetAt(position)); if (result.failure || !result.symbol || !result.token) { throw new Error(renameFailure(result.failure || 'noSymbol')); }
			if (service.externalUris.has(result.symbol.uri)) { throw new Error(vscode.l10n.t('Dependency source cannot be renamed from this project.')); }
			return { range: range(document, result.token.start, result.token.end), placeholder: result.symbol.name };
		},
		async provideRenameEdits(document, position, newName, token) {
			if (!await service.ensure(document) || token.isCancellationRequested) { return undefined; }
			const result = service.index.rename(document.uri.toString(), document.offsetAt(position), newName); if (result.failure) { throw new Error(renameFailure(result.failure)); }
			if ([...result.edits.keys()].some(uri => service.externalUris.has(uri))) { throw new Error(vscode.l10n.t('Rename would modify dependency source.')); }
			const edit = new vscode.WorkspaceEdit();
			for (const [uri, edits] of result.edits) { const target = await vscode.workspace.openTextDocument(vscode.Uri.parse(uri)); for (const item of edits) { edit.replace(target.uri, range(target, item.start, item.end), item.text); } }
			return edit;
		}
	}));
	disposables.push(vscode.languages.registerHoverProvider(selector, {
		async provideHover(document, position, token) {
			if (!await service.ensure(document) || token.isCancellationRequested) { return undefined; }
			const found = service.index.resolve(document.uri.toString(), document.offsetAt(position)); if (!found?.definitions.length) { return undefined; }
			const content = new vscode.MarkdownString(); content.isTrusted = false;
			for (const symbol of found.definitions.slice(0, 3)) { content.appendCodeblock(signature(symbol), 'ruby'); if (symbol.documentation) { content.appendText(symbol.documentation); content.appendMarkdown('\n\n'); } content.appendText(vscode.l10n.t('Declared in {0}', vscode.workspace.asRelativePath(vscode.Uri.parse(symbol.uri)))); content.appendMarkdown('\n\n'); }
			content.appendText(vscode.l10n.t('Ruby Studio Static Index — Explicit Declarations and Bounded Receiver Bindings; Runtime Dispatch May Differ.'));
			return new vscode.Hover(content, range(document, found.token.start, found.token.end));
		}
	}));
	disposables.push(vscode.languages.registerCompletionItemProvider(selector, {
		async provideCompletionItems(document, position, token) {
			if (!await service.ensure(document) || token.isCancellationRequested) { return []; }
			const word = document.getWordRangeAtPosition(position, /[A-Za-z_]\w*[!?]?/); const offset = document.offsetAt(word?.start || position);
			const containing = service.index.tokenAt(document.uri.toString(), Math.max(0, offset - 1)); if (containing?.kind === 'literal' || containing?.kind === 'comment') { return []; }
			const items = service.index.completions(document.uri.toString(), offset).map(symbol => { const item = new vscode.CompletionItem(symbol.name, completionKind(symbol.kind)); item.detail = vscode.l10n.t('Ruby Studio: {0}', signature(symbol)); item.range = word; if (symbol.documentation) { const docs = new vscode.MarkdownString(); docs.appendText(symbol.documentation); item.documentation = docs; } return item; });
			for (const parameter of service.index.keywordCompletions(document.uri.toString(), offset)) { const item = new vscode.CompletionItem(`${parameter.name}:`, vscode.CompletionItemKind.Field); item.insertText = word && document.getText().slice(document.offsetAt(word.end), document.offsetAt(word.end) + 1) === ':' ? parameter.name : `${parameter.name}: `; item.detail = vscode.l10n.t('Keyword Argument · {0}', parameter.label); item.range = word; items.unshift(item); }
			if (!/[.:]$/.test(document.getText(new vscode.Range(position.line, 0, position.line, word?.start.line === position.line ? word.start.character : position.character)))) {
				items.push(...snippets.map(([name, body, label]) => { const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Snippet); item.insertText = new vscode.SnippetString(body); item.detail = vscode.l10n.t(label); item.range = word; return item; }));
			}
			return items;
		}
	}, '.', ':', ','));
	disposables.push(vscode.languages.registerSignatureHelpProvider(selector, {
		async provideSignatureHelp(document, position, token) {
			if (!await service.ensure(document) || token.isCancellationRequested) { return undefined; }
			const result = service.index.signature(document.uri.toString(), document.offsetAt(position)); if (!result) { return undefined; }
			const help = new vscode.SignatureHelp(); help.activeSignature = 0; help.activeParameter = Math.min(result.activeParameter, Math.max(0, result.symbols[0].parameters.length - 1));
			help.signatures = result.symbols.map((symbol, index) => { const info = new vscode.SignatureInformation(signature(symbol)); info.activeParameter = Math.min(result.activeParameters[index], Math.max(0, symbol.parameters.length - 1)); info.parameters = symbol.parameters.map(parameter => new vscode.ParameterInformation(parameter.label)); if (symbol.documentation) { const documentation = new vscode.MarkdownString(); documentation.appendText(symbol.documentation); info.documentation = documentation; } return info; });
			return help;
		}
	}, '(', ',', ':'));
	disposables.push(vscode.languages.registerDocumentFormattingEditProvider(selector, {
		provideDocumentFormattingEdits(document) { return service.enabled(document) && !isTemplate(document) ? rubyWhitespaceEdits(document.getText()).map(edit => vscode.TextEdit.replace(range(document, edit.start, edit.end), edit.text)) : []; }
	}));
	disposables.push(vscode.languages.registerCodeActionsProvider(selector, {
		async provideCodeActions(document, selection, context, token) {
			const model = await service.ensure(document); if (!model || token.isCancellationRequested || isTemplate(document)) { return []; }
			const actions: vscode.CodeAction[] = [];
			for (const diagnostic of context.diagnostics) {
				if (diagnostic.source !== sourceName || diagnostic.code !== 'trailing-whitespace') { continue; }
				const action = new vscode.CodeAction(vscode.l10n.t('Remove Trailing Whitespace'), vscode.CodeActionKind.QuickFix); action.diagnostics = [diagnostic]; action.edit = new vscode.WorkspaceEdit(); action.edit.delete(document.uri, diagnostic.range); actions.push(action);
			}
			const whitespace = rubyWhitespaceEdits(document.getText());
			if (whitespace.length) { const action = new vscode.CodeAction(vscode.l10n.t('Remove Nonliteral Trailing Whitespace in File'), vscode.CodeActionKind.SourceFixAll); action.edit = new vscode.WorkspaceEdit(); for (const edit of whitespace) { action.edit.delete(document.uri, range(document, edit.start, edit.end)); } actions.push(action); }
			const start = document.offsetAt(selection.start); const end = document.offsetAt(selection.end);
			if (!selection.isEmpty && extractRubyLiteral(model, start, end)) { const action = new vscode.CodeAction(vscode.l10n.t('Extract Literal to Local Variable'), vscode.CodeActionKind.RefactorExtract); action.command = { command: 'rubyStudio.extractLocal', title: action.title, arguments: [document.uri, document.version, start, end] }; actions.push(action); }
			return actions;
		}
	}, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix, vscode.CodeActionKind.SourceFixAll, vscode.CodeActionKind.RefactorExtract] }));
	return disposables;
}
