/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs/promises';
import { spawn } from 'child_process';
import { RuntimeService } from './runtime';

type Framework = 'minitest' | 'rspec';
interface DiscoveredTest { name: string; line: number; filter?: string; }
interface TestEvent { event: 'started' | 'finished'; id: string; name: string; file?: string; line?: number; status?: 'passed' | 'failed' | 'errored' | 'skipped'; duration?: number; message?: string; }
interface Selection { file: vscode.TestItem; tests: vscode.TestItem[]; wholeFile: boolean; }
interface DebugMessage { type: string; event?: string; body?: { output?: string; }; }
const eventPrefix = '@@RUBY_STUDIO@@';

/** Reads literal imports only; dynamic Ruby expressions are deliberately unresolved. */
function literalRequires(text: string): { name: string; relative: boolean }[] {
	return text.split(/\r?\n/).flatMap(line => {
		const match = line.match(/^\s*(?<kind>require(?:_relative)?)\s*(?:\(\s*)?(['"])(?<name>[^'"\r\n]+)\2/);
		return match?.groups ? [{ name: match.groups.name, relative: match.groups.kind === 'require_relative' }] : [];
	});
}

/** Independent, conservative detection: a spec filename alone never implies RSpec. */
export function detectRubyTestFramework(text: string, file: string, helpers: string[] = []): Framework | undefined {
	const signals = (source: string) => {
		const imports = literalRequires(source).map(value => value.name);
		return {
			minitest: imports.some(value => /(?:^|\/)minitest(?:\/|$)/i.test(value)) || /^\s*class\s+[^\n]+<\s*(?:Mini[tT]est::(?:Test|Spec|Unit::TestCase)|ActiveSupport::TestCase)\b/m.test(source),
			rspec: imports.some(value => /(?:^|\/)rspec(?:\/|$)/i.test(value)) || /^\s*RSpec\.(?:describe|context|feature|configure|shared_examples)\b/m.test(source)
		};
	};
	const direct = signals(text);
	if (direct.minitest || direct.rspec) { return direct.minitest === direct.rspec ? undefined : direct.minitest ? 'minitest' : 'rspec'; }
	const inherited = helpers.map(signals);
	const minitest = inherited.some(value => value.minitest);
	const rspec = inherited.some(value => value.rspec);
	if (minitest || rspec) { return minitest === rspec ? undefined : minitest ? 'minitest' : 'rspec'; }
	if (/^\s*def\s+test_[\w!?]+/m.test(text) || /^\s*test\s*\(?\s*['"]/m.test(text) || /\.(?:must|wont)_\w+/.test(text)) { return 'minitest'; }
	if (/\bexpect\s*(?:\(|\{)/.test(text) && /^\s*(?:describe|context|it|specify)\b/m.test(text)) { return 'rspec'; }
	return /(?:^|[\\/])(?:test_[^\\/]+|[^\\/]+_test)\.rb$/.test(file) ? 'minitest' : undefined;
}

/** Resolves local helper imports within one project, with a fixed read/depth budget. */
export async function resolveRubyTestFramework(text: string, file: string, projectRoot: string, readSource: (file: string) => Promise<string> = file => fs.readFile(file, 'utf8')): Promise<Framework | undefined> {
	const helpers: string[] = [];
	const visited = new Set<string>([path.resolve(file)]);
	let reads = 0;
	const inspect = async (source: string, sourceFile: string, depth: number): Promise<void> => {
		if (depth >= 8 || reads >= 32) { return; }
		for (const imported of literalRequires(source)) {
			if (path.isAbsolute(imported.name)) { continue; }
			const roots = imported.relative ? [path.dirname(sourceFile)] : [path.dirname(sourceFile), path.join(projectRoot, 'test'), path.join(projectRoot, 'spec'), path.join(projectRoot, 'lib'), projectRoot];
			for (const root of roots) {
				const candidate = path.resolve(root, imported.name.endsWith('.rb') ? imported.name : `${imported.name}.rb`);
				const relative = path.relative(projectRoot, candidate);
				if (relative.startsWith(`..${path.sep}`) || relative === '..' || path.isAbsolute(relative) || visited.has(candidate)) { continue; }
				visited.add(candidate);
				if (++reads > 32) { return; }
				try {
					const helper = await readSource(candidate);
					helpers.push(helper);
					await inspect(helper, candidate, depth + 1);
					break;
				} catch { /* Missing local imports can refer to installed gems; no execution follows. */ }
			}
		}
	};
	await inspect(text, file, 0);
	return detectRubyTestFramework(text, file, helpers);
}

/** Adds conventional project load paths and a Rails test default without overwriting user env. */
export async function rubyTestProcessOptions(cwd: string, env: NodeJS.ProcessEnv): Promise<{ rubyArgs: string[]; env: NodeJS.ProcessEnv }> {
	const rubyArgs: string[] = [];
	for (const directory of ['lib', 'test']) {
		try { if ((await fs.stat(path.join(cwd, directory))).isDirectory()) { rubyArgs.push('-I', path.join(cwd, directory)); } } catch { /* Optional project directories. */ }
	}
	const result = { ...env };
	try {
		if ((await fs.stat(path.join(cwd, 'config', 'application.rb'))).isFile() && result.RAILS_ENV === undefined) { result.RAILS_ENV = 'test'; }
	} catch { /* Plain Ruby projects have no Rails environment default. */ }
	return { rubyArgs, env: result };
}

/** Static discovery covers ordinary method/DSL declarations; dynamic tests appear during a run. */
export function discoverRubyTests(text: string, framework: Framework): DiscoveredTest[] {
	const tests: DiscoveredTest[] = [];
	for (const [line, source] of text.split(/\r?\n/).entries()) {
		if (framework === 'minitest') {
			const method = source.match(/^\s*def\s+(?<name>test_[\w!?]+)/)?.groups?.name;
			if (method) { tests.push({ name: method, line, filter: method }); continue; }
			const dsl = source.match(/^\s*(?:test|it|specify)\s*\(?\s*(['"])(?<name>[^'"\r\n]+)\1/)?.groups?.name;
			if (dsl) { tests.push({ name: dsl, line }); }
		} else {
			const example = source.match(/^\s*(?:f|x)?(?:it|specify|example|scenario)\s*\(?\s*(['"])(?<name>[^'"\r\n]+)\1/)?.groups?.name;
			if (example) { tests.push({ name: example, line }); }
		}
	}
	return tests;
}

/** Ignores ordinary application output and validates the event shape at the process boundary. */
export function parseTestEvent(line: string): TestEvent | undefined {
	if (!line.startsWith(eventPrefix)) { return undefined; }
	try {
		const event: TestEvent = JSON.parse(line.slice(eventPrefix.length));
		if (!event || !['started', 'finished'].includes(event.event) || typeof event.id !== 'string' || typeof event.name !== 'string') { return undefined; }
		if (event.file !== undefined && typeof event.file !== 'string') { return undefined; }
		if (event.line !== undefined && (!Number.isInteger(event.line) || event.line < 1)) { return undefined; }
		if (event.duration !== undefined && (!Number.isFinite(event.duration) || event.duration < 0)) { return undefined; }
		if (event.message !== undefined && typeof event.message !== 'string') { return undefined; }
		if (event.event === 'finished' && !['passed', 'failed', 'errored', 'skipped'].includes(event.status || '')) { return undefined; }
		return event;
	} catch { return undefined; }
}

/** Registers original Minitest/RSpec discovery, result adapters and run/debug profiles. */
export function registerTesting(context: vscode.ExtensionContext, runtime: RuntimeService): vscode.Disposable[] {
	const controller = vscode.tests.createTestController('rubyStudio.tests', vscode.l10n.t('Ruby Tests'));
	const disposables: vscode.Disposable[] = [controller];
	const activeRuns = new Set<vscode.CancellationTokenSource>();
	const activeChildren = new Set<ReturnType<typeof spawn>>();
	let disposed = false;
	const publishTestingState = () => { void vscode.commands.executeCommand('setContext', 'rubyStudio.isTesting', !disposed && activeRuns.size > 0); };
	disposables.push(new vscode.Disposable(() => {
		disposed = true;
		for (const source of activeRuns) { source.cancel(); }
		for (const child of activeChildren) { child.kill('SIGKILL'); }
		publishTestingState();
	}));
	disposables.push(vscode.commands.registerCommand('rubyStudio.cancelTests', () => {
		for (const source of activeRuns) { source.cancel(); }
	}));
	publishTestingState();
	const metadata = new Map<string, { framework?: Framework; filter?: string }>();
	const debugSessions = new Map<string, vscode.DebugSession>();
	const debugRuns = new Map<string, { output: (text: string) => void; done: () => void }>();
	let sequence = 0;
	const addFile = async (uri: vscode.Uri, content?: string) => {
		if (path.basename(uri.fsPath) === 'test_helper.rb') { return; }
		const folder = vscode.workspace.getWorkspaceFolder(uri);
		if (!folder) { return; }
		const text = content ?? Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
		const framework = await resolveRubyTestFramework(text, uri.fsPath, folder.uri.fsPath);
		const id = uri.toString();
		let file = controller.items.get(id);
		if (!file) {
			file = controller.createTestItem(id, path.relative(folder.uri.fsPath, uri.fsPath), uri);
			file.canResolveChildren = true;
			controller.items.add(file);
		}
		metadata.set(id, { framework });
		file.children.forEach(child => metadata.delete(child.id));
		const children = (framework ? discoverRubyTests(text, framework) : []).map(test => {
			const child = controller.createTestItem(`${id}#${test.line}`, test.name, uri);
			child.range = new vscode.Range(test.line, 0, test.line, 0);
			metadata.set(child.id, { framework, filter: test.filter });
			return child;
		});
		file.children.replace(children);
		file.error = framework ? undefined : vscode.l10n.t('The test framework is ambiguous. Add a literal Minitest/RSpec import, or an explicit RSpec.describe declaration, then refresh tests.');
	};
	const discover = async () => {
		const files = (await vscode.workspace.findFiles('**/{test_*.rb,*_test.rb,*_spec.rb}', '**/{node_modules,vendor,.git,.bundle}/**', 20000)).filter(uri => path.basename(uri.fsPath) !== 'test_helper.rb');
		const existing = new Set(files.map(uri => uri.toString()));
		controller.items.forEach(item => { if (!existing.has(item.id)) { controller.items.delete(item.id); } });
		for (const file of files) {
			try { await addFile(file); } catch (error) {
				const item = controller.items.get(file.toString());
				if (item) { item.error = error instanceof Error ? error.message : String(error); }
			}
		}
	};
	controller.resolveHandler = async item => {
		if (item?.uri) { await addFile(item.uri); } else { await discover(); }
	};
	controller.refreshHandler = discover;
	const isExcluded = (item: vscode.TestItem, excluded: Set<string>): boolean => excluded.has(item.id) || !!item.parent && isExcluded(item.parent, excluded);
	const selections = (request: vscode.TestRunRequest): Selection[] => {
		const excluded = new Set((request.exclude || []).map(item => item.id));
		const selections = new Map<string, Selection>();
		const add = (item: vscode.TestItem) => {
			if (isExcluded(item, excluded)) { return; }
			const file = item.parent || item;
			const selection = selections.get(file.id) || { file, tests: [], wholeFile: false };
			if (!item.parent) {
				selection.wholeFile = !Array.from(excluded).some(id => id.startsWith(`${file.id}#`));
				item.children.forEach(child => { if (!isExcluded(child, excluded)) { selection.tests.push(child); } });
			} else if (!selection.tests.some(test => test.id === item.id)) { selection.tests.push(item); }
			selections.set(file.id, selection);
		};
		if (request.include) { request.include.forEach(add); } else { controller.items.forEach(add); }
		return [...selections.values()].filter(selection => selection.wholeFile || selection.tests.length);
	};
	const runTests = async (request: vscode.TestRunRequest, incomingToken: vscode.CancellationToken, debug: boolean) => {
		if (disposed) { return; }
		const source = new vscode.CancellationTokenSource();
		const linked = incomingToken.onCancellationRequested(() => source.cancel());
		if (incomingToken.isCancellationRequested) { source.cancel(); }
		const token = source.token;
		activeRuns.add(source);
		publishTestingState();
		try {
			if (!vscode.workspace.isTrusted) {
				void vscode.window.showWarningMessage(vscode.l10n.t('Trust this workspace before running tests.'));
				return;
			}
			if (!await vscode.workspace.saveAll(false)) {
				void vscode.window.showErrorMessage(vscode.l10n.t('Save the test files before running them.'));
				return;
			}
			if (!controller.items.size) { await discover(); }
			const run = controller.createTestRun(request);
			try {
				for (const selection of selections(request)) {
					if (token.isCancellationRequested) { break; }
					const file = selection.file;
					if (!file.uri) { continue; }
					const folder = vscode.workspace.getWorkspaceFolder(file.uri);
					if (!folder) { continue; }
					const framework = metadata.get(file.id)?.framework;
					if (!framework) {
						run.errored(file, new vscode.TestMessage(vscode.l10n.t('The test framework is ambiguous; Ruby Studio will not guess based on a spec filename. Add a framework import or resolve its helper, then refresh tests.')));
						continue;
					}
					const sdk = await runtime.get(folder);
					const processOptions = await rubyTestProcessOptions(sdk.cwd, sdk.env);
					if (token.isCancellationRequested) { break; }
					const pending = new Set(selection.tests);
					for (const test of selection.tests) { run.enqueued(test); }
					let buffer = '';
					let reported = 0;
					const eventItems = new Map<string, vscode.TestItem>();
					const consume = (chunk: string) => {
						buffer += chunk;
						let newline: number;
						while ((newline = buffer.indexOf('\n')) >= 0) {
							const line = buffer.slice(0, newline).replace(/\r$/, '');
							buffer = buffer.slice(newline + 1);
							const event = parseTestEvent(line);
							if (!event) { run.appendOutput(`${line}\r\n`, undefined, file); continue; }
							let item = eventItems.get(event.id);
							if (!item && event.file && path.resolve(event.file) === path.resolve(file.uri!.fsPath)) {
								file.children.forEach(child => { if (child.range?.start.line === (event.line || 1) - 1) { item = child; } });
							}
							if (!item && selection.wholeFile) {
								item = controller.createTestItem(`${file.id}#runtime:${event.id}`, event.name, file.uri);
								if (event.line) { item.range = new vscode.Range(event.line - 1, 0, event.line - 1, 0); }
								file.children.add(item);
							}
							if (!item || !selection.wholeFile && !selection.tests.includes(item)) { continue; }
							eventItems.set(event.id, item);
							if (event.event === 'started') { run.started(item); pending.add(item); continue; }
							reported++;
							pending.delete(item);
							const message = new vscode.TestMessage(event.message || vscode.l10n.t('Test {0}', event.status || 'failed'));
							if (item.uri && item.range) { message.location = new vscode.Location(item.uri, item.range); }
							switch (event.status) {
								case 'passed': run.passed(item, event.duration); break;
								case 'skipped': run.skipped(item); break;
								case 'errored': run.errored(item, message, event.duration); break;
								case 'failed': run.failed(item, message, event.duration); break;
							}
						}
					};
					const minitestLines = selection.tests.map(test => (test.range?.start.line || 0) + 1);
					const script = vscode.Uri.joinPath(context.extensionUri, 'ruby', framework === 'minitest' ? 'minitest_runner.rb' : 'rspec_formatter.rb').fsPath;
					const args = framework === 'minitest' ? [JSON.stringify({ files: [file.uri.fsPath], lines: selection.wholeFile ? undefined : minitestLines })] : selection.wholeFile ? [file.uri.fsPath] : selection.tests.map(test => `${file.uri!.fsPath}:${(test.range?.start.line || 0) + 1}`);
					let code: number | null = null;
					try {
						if (debug) {
							const key = `rubyStudio-tests-${++sequence}`;
							await new Promise<void>((resolve, reject) => {
								let cancellation: vscode.Disposable | undefined;
								debugRuns.set(key, { output: consume, done: () => { cancellation?.dispose(); debugRuns.delete(key); resolve(); } });
								cancellation = token.onCancellationRequested(() => {
									const session = debugSessions.get(key);
									if (session) { void vscode.debug.stopDebugging(session); }
								});
								void vscode.debug.startDebugging(folder, { type: 'rubyStudio', request: 'launch', name: vscode.l10n.t('Debug Ruby Tests'), script, args, rubyArgs: processOptions.rubyArgs, cwd: sdk.cwd, env: processOptions.env, stopOnEntry: false, rubyStudioTestingRun: key }).then(started => {
									if (!started) { cancellation?.dispose(); debugRuns.delete(key); reject(new Error(vscode.l10n.t('Ruby test debugging could not start.'))); }
									else if (token.isCancellationRequested) { void vscode.debug.stopDebugging(debugSessions.get(key)); }
								}, error => { cancellation?.dispose(); debugRuns.delete(key); reject(error); });
							});
						} else {
							code = await new Promise<number | null>((resolve, reject) => {
								const child = spawn(sdk.ruby, [...processOptions.rubyArgs, script, ...args], { cwd: sdk.cwd, env: processOptions.env, stdio: ['ignore', 'pipe', 'pipe'] });
								activeChildren.add(child);
								let escalation: ReturnType<typeof setTimeout> | undefined;
								const cancellation = token.onCancellationRequested(() => {
									child.kill('SIGTERM');
									escalation = setTimeout(() => child.kill('SIGKILL'), 3000);
								});
								child.stdout.setEncoding('utf8').on('data', consume);
								child.stderr.setEncoding('utf8').on('data', (text: string) => run.appendOutput(text.replace(/\r?\n/g, '\r\n'), undefined, file));
								child.on('error', error => { activeChildren.delete(child); cancellation.dispose(); if (escalation) { clearTimeout(escalation); } reject(error); });
								child.on('close', result => { activeChildren.delete(child); cancellation.dispose(); if (escalation) { clearTimeout(escalation); } resolve(result); });
								if (token.isCancellationRequested) { child.kill('SIGTERM'); }
							});
						}
						if (buffer) { consume('\n'); }
						for (const item of pending) {
							if (token.isCancellationRequested) { run.skipped(item); }
							else { run.errored(item, new vscode.TestMessage(vscode.l10n.t('The Ruby runner did not report this test. Check Test Output for load errors or unsupported dynamic declarations.'))); }
						}
						if (!reported && !token.isCancellationRequested) { run.errored(file, new vscode.TestMessage(vscode.l10n.t('No structured test results were received (exit code: {0}). Check Test Output and the project framework installation.', String(code)))); }
					} catch (error) {
						run.errored(file, new vscode.TestMessage(error instanceof Error ? error.message : String(error)));
					}
				}
			} catch (error) {
				run.appendOutput(`${error instanceof Error ? error.message : String(error)}\r\n`);
			} finally { run.end(); }
		} finally {
			linked.dispose();
			activeRuns.delete(source);
			source.dispose();
			publishTestingState();
		}
	};
	const runProfile = controller.createRunProfile(vscode.l10n.t('Run Ruby Tests'), vscode.TestRunProfileKind.Run, (request, token) => runTests(request, token, false), true);
	disposables.push(runProfile);
	disposables.push(vscode.commands.registerCommand('rubyStudio.runTests', () => vscode.window.withProgress({
		location: vscode.ProgressLocation.Notification, title: vscode.l10n.t('Running Ruby Tests'), cancellable: true
	}, async (_progress, token) => {
		await discover();
		await runTests(new vscode.TestRunRequest(undefined, undefined, runProfile), token, false);
	})));
	disposables.push(controller.createRunProfile(vscode.l10n.t('Debug Ruby Tests'), vscode.TestRunProfileKind.Debug, (request, token) => runTests(request, token, true), true));
	disposables.push(vscode.debug.onDidStartDebugSession(session => {
		const key: string | undefined = session.configuration.rubyStudioTestingRun;
		if (key) { debugSessions.set(key, session); }
	}), vscode.debug.onDidTerminateDebugSession(session => {
		const key: string | undefined = session.configuration.rubyStudioTestingRun;
		if (key) { debugSessions.delete(key); debugRuns.get(key)?.done(); }
	}));
	disposables.push(vscode.debug.registerDebugAdapterTrackerFactory('rubyStudio', {
		createDebugAdapterTracker: session => {
			const key: string | undefined = session.configuration.rubyStudioTestingRun;
			return !key ? undefined : {
				onDidSendMessage: (message: DebugMessage) => {
					if (message.event === 'output' && message.body?.output) { debugRuns.get(key)?.output(message.body.output); }
					if (message.event === 'terminated') { debugRuns.get(key)?.done(); }
				},
				onExit: () => debugRuns.get(key)?.done(),
				onError: () => debugRuns.get(key)?.done()
			};
		}
	}));
	const watcher = vscode.workspace.createFileSystemWatcher('**/{test_*.rb,*_test.rb,*_spec.rb}');
	disposables.push(watcher, watcher.onDidCreate(uri => { void addFile(uri).catch(() => { /* A newly created file may be removed before reading. */ }); }), watcher.onDidChange(uri => { void addFile(uri).catch(() => { /* Re-read on the next filesystem update. */ }); }), watcher.onDidDelete(uri => controller.items.delete(uri.toString())));
	disposables.push(vscode.workspace.onDidChangeTextDocument(event => {
		if (controller.items.get(event.document.uri.toString())) { void addFile(event.document.uri, event.document.getText()); }
	}));
	disposables.push(vscode.commands.registerCommand('rubyStudio.refreshTests', discover));
	return disposables;
}
