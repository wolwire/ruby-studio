/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const vscode = require('vscode');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');

function timeout(promise, label, milliseconds = 30000) {
	let timer;
	return Promise.race([promise, new Promise((_resolve, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${milliseconds} ms`)), milliseconds); })]).finally(() => clearTimeout(timer));
}

function flattenSymbols(symbols) {
	return (symbols || []).flatMap(symbol => [symbol, ...flattenSymbols(symbol.children)]);
}

function position(document, needle, offset = 0, last = false) {
	const start = last ? document.getText().lastIndexOf(needle) : document.getText().indexOf(needle);
	assert.ok(start >= 0, `Fixture text contains ${needle}`);
	return document.positionAt(start + offset);
}

async function waitForDiagnostics(uri, predicate) {
	const existing = vscode.languages.getDiagnostics(uri).filter(predicate);
	if (existing.length) { return existing; }
	let disposable;
	try {
		return await timeout(new Promise(resolve => {
			disposable = vscode.languages.onDidChangeDiagnostics(event => {
				if (!event.uris.some(changed => changed.toString() === uri.toString())) { return; }
				const diagnostics = vscode.languages.getDiagnostics(uri).filter(predicate);
				if (diagnostics.length) { resolve(diagnostics); }
			});
		}), 'Original Ruby Syntax Diagnostics', 20000);
	} finally { disposable?.dispose(); }
}

/** Run inside the real extension host via --extensionTestsPath. */
exports.run = async function run() {
	const results = {
		suite: 'Ruby Studio Native Extension Host Integration',
		startedAt: new Date().toISOString(),
		host: { appName: vscode.env.appName, appHost: vscode.env.appHost, version: vscode.version, trusted: vscode.workspace.isTrusted, platform: process.platform },
		checks: [],
		boundaries: [
			'Language assertions cover explicit lexical symbols, constants, local rename and implicit method calls; dynamic receiver inference and metaprogramming are outside this test.',
			'Debug assertions cover the original adapter on the main Ruby thread/process. They do not establish remote debugging, other threads, conditional breakpoints or blocked native-I/O pause.',
			'The native TestController command is invoked and its fixture side effect is verified. Stable VS Code APIs do not expose complete test-result history for this harness.',
			'Test Stop is checked on a real Minitest process paused in a 30-second sleep: the native Stop command must settle the run within 5 seconds without reaching its finished marker. This does not establish cancellation behavior for every framework or remote process.',
			'HTTP is verified against a local loopback server through the real command and response editor; external services, TLS/authentication, redirects and cancellation are outside this check.',
			'SQLite uses actual native DatabaseSync data through the real open/query commands and results webview. Read-only write rejection and the 500-row display cap are checked; other database engines are not covered.',
			'Only a newly created fixture directory is edited. Existing project files and user breakpoints are preserved.'
		]
	};
	let directory;
	const disposables = [];
	const createdBreakpoints = [];
	const initialTabs = new Set(vscode.window.tabGroups.all.flatMap(group => group.tabs));
	let debugSession;
	const check = async (name, action) => {
		const started = Date.now();
		try { const details = await action(); results.checks.push({ name, status: 'passed', durationMs: Date.now() - started, details }); }
		catch (error) { results.checks.push({ name, status: 'failed', durationMs: Date.now() - started, error: { message: error.message, stack: error.stack } }); }
	};
	try {
		const folder = vscode.workspace.workspaceFolders?.[0];
		assert.ok(folder && folder.uri.scheme === 'file', 'The launcher must open a local disposable workspace.');
		assert.equal(vscode.workspace.isTrusted, true, 'The disposable integration workspace must be trusted explicitly by the launcher.');
		directory = await fs.realpath(await fs.mkdtemp(path.join(folder.uri.fsPath, 'ruby-studio-integration-')));
		const extension = vscode.extensions.getExtension('ruby-studio.ruby-studio');
		assert.ok(extension, 'The original built-in Ruby Studio extension is present.');
		await timeout(extension.activate(), 'Ruby Studio Activation');
		results.host.extensionId = extension.id;
		results.host.extensionPath = extension.extensionPath;
		const source = [
			'class RubyStudioIntegrationGreeter',
			'  def greeting(name, suffix = "!")',
			'    name + suffix',
			'  end',
			'  def call(name)',
			'    greeting(name, "?")',
			'  end',
			'end',
			'greeter = RubyStudioIntegrationGreeter.new',
			'seed = 21',
			'total = seed * 2',
			'puts total',
			'puts greeter.call("Ruby Studio")',
			''
		].join('\n');
		const uri = vscode.Uri.file(path.join(directory, 'integration_program.rb'));
		await fs.writeFile(uri.fsPath, source);
		const document = await vscode.workspace.openTextDocument(uri);
		await vscode.window.showTextDocument(document);
		await timeout(vscode.commands.executeCommand('rubyStudio.rebuildIndex'), 'Initial Ruby Index');

		await check('Original Commands Register in the Native Host', async () => {
			const registered = new Set(await vscode.commands.getCommands(true));
			const expected = ['rubyStudio.runCurrent', 'rubyStudio.debugCurrent', 'rubyStudio.runSelected', 'rubyStudio.debugSelected', 'rubyStudio.pickConfiguration', 'rubyStudio.stop', 'rubyStudio.selectInterpreter', 'rubyStudio.runTests', 'rubyStudio.cancelTests', 'rubyStudio.refreshTests', 'rubyStudio.rebuildIndex', 'rubyStudio.manageGems', 'rubyStudio.sendRequest', 'rubyStudio.openDatabase', 'rubyStudio.queryDatabase'];
			assert.deepEqual(expected.filter(command => !registered.has(command)), []);
			return { commands: expected, extensionActive: extension.isActive };
		});
		await check('Document and Workspace Symbols', async () => {
			const symbols = await vscode.commands.executeCommand('vscode.executeDocumentSymbolProvider', uri);
			const names = flattenSymbols(symbols).map(symbol => symbol.name);
			assert.ok(['RubyStudioIntegrationGreeter', 'greeting', 'call'].every(name => names.includes(name)));
			const workspace = await vscode.commands.executeCommand('vscode.executeWorkspaceSymbolProvider', 'RubyStudioIntegrationGreeter');
			assert.ok(workspace.some(symbol => symbol.location.uri.toString() === uri.toString()));
			return { documentNames: names, workspaceMatches: workspace.length };
		});
		await check('Definition and References Resolve an Explicit Constant', async () => {
			const at = position(document, 'RubyStudioIntegrationGreeter', 3, true);
			const definitions = await vscode.commands.executeCommand('vscode.executeDefinitionProvider', uri, at);
			assert.ok(definitions.some(location => (location.uri || location.targetUri).toString() === uri.toString() && (location.range || location.targetRange).start.line === 0));
			const references = await vscode.commands.executeCommand('vscode.executeReferenceProvider', uri, at);
			assert.ok(references.filter(location => location.uri.toString() === uri.toString()).length >= 2);
			return { definitionCount: definitions.length, referenceCount: references.length };
		});
		await check('Rename Produces Safe Local Binding Edits', async () => {
			const edit = await vscode.commands.executeCommand('vscode.executeDocumentRenameProvider', uri, position(document, 'seed =', 2), 'integrationSeed');
			assert.ok(edit);
			const edits = edit.get(uri);
			assert.deepEqual(edits.map(item => ({ text: item.newText, old: document.getText(item.range) })), [{ text: 'integrationSeed', old: 'seed' }, { text: 'integrationSeed', old: 'seed' }]);
			return { editCount: edits.length, applied: false };
		});
		await check('Original Completion and Signature Providers', async () => {
			const completion = await vscode.commands.executeCommand('vscode.executeCompletionItemProvider', uri, position(document, 'RubyStudioIntegrationGreeter', 6, true));
			const own = completion.items.filter(item => item.detail?.startsWith('Ruby Studio:'));
			assert.ok(own.some(item => (typeof item.label === 'string' ? item.label : item.label.label) === 'RubyStudioIntegrationGreeter'));
			const signature = await vscode.commands.executeCommand('vscode.executeSignatureHelpProvider', uri, position(document, '    greeting(', '    greeting('.length));
			assert.ok(signature?.signatures.some(item => item.label.startsWith('greeting(') && item.parameters.length === 2));
			return { ownCompletionCount: own.length, signatures: signature.signatures.map(item => item.label) };
		});
		await check('Unsaved Invalid Buffer Gets Actual Ruby Syntax Diagnostics', async () => {
			const invalidUri = vscode.Uri.file(path.join(directory, 'syntax_buffer.rb'));
			await fs.writeFile(invalidUri.fsPath, 'value = 1\n');
			const invalid = await vscode.workspace.openTextDocument(invalidUri);
			await vscode.window.showTextDocument(invalid);
			const edit = new vscode.WorkspaceEdit();
			edit.replace(invalidUri, new vscode.Range(new vscode.Position(0, 0), invalid.positionAt(invalid.getText().length)), 'def incomplete(\n');
			assert.equal(await vscode.workspace.applyEdit(edit), true);
			assert.equal(invalid.isDirty, true);
			const diagnostics = await waitForDiagnostics(invalidUri, diagnostic => diagnostic.source === 'Ruby Studio' && diagnostic.code === 'ruby-syntax' && diagnostic.severity === vscode.DiagnosticSeverity.Error);
			const details = diagnostics.map(diagnostic => ({ code: diagnostic.code, line: diagnostic.range.start.line + 1, message: diagnostic.message }));
			const restore = new vscode.WorkspaceEdit();
			restore.replace(invalidUri, new vscode.Range(new vscode.Position(0, 0), invalid.positionAt(invalid.getText().length)), 'value = 1\n');
			await vscode.workspace.applyEdit(restore); await invalid.save();
			return { unsavedBufferChecked: true, diagnostics: details };
		});
		await check('Native TestController Run Command Executes the Fixture', async () => {
			const testFile = path.join(directory, 'integration_native_test.rb');
			await fs.writeFile(testFile, [
				'require "minitest/autorun"', 'require "json"',
				'class RubyStudioNativeHostTest < Minitest::Test',
				'  def test_native_host_pipeline',
				'    assert_equal 42, 21 * 2',
				'    File.write(File.join(__dir__, "native-test-ran.json"), JSON.generate({executed: true, value: 42}))',
				'  end', 'end', ''
			].join('\n'));
			await timeout(vscode.commands.executeCommand('rubyStudio.refreshTests'), 'Native Test Discovery');
			await timeout(vscode.commands.executeCommand('rubyStudio.runTests'), 'Native TestController Run', 60000);
			const marker = JSON.parse(await fs.readFile(path.join(directory, 'native-test-ran.json'), 'utf8'));
			assert.deepEqual(marker, { executed: true, value: 42 });
			return { fixtureExecuted: true, resultHistoryAssertion: 'Not exposed by the stable extension API.' };
		});
		await check('Native Stop Cancels a Running Minitest Process', async () => {
			const testFile = path.join(directory, 'integration_stop_test.rb');
			const startedMarker = path.join(directory, 'native-stop-started.txt');
			const finishedMarker = path.join(directory, 'native-stop-finished.txt');
			let runPromise;
			let runState = 'pending';
			try {
				await fs.writeFile(testFile, [
					'require "minitest/autorun"',
					'class RubyStudioNativeStopTest < Minitest::Test',
					'  def test_native_stop_pipeline',
					'    File.write(File.join(__dir__, "native-stop-started.txt"), "started\\n")',
					'    sleep 30',
					'    File.write(File.join(__dir__, "native-stop-finished.txt"), "finished\\n")',
					'    assert true', '  end', 'end', ''
				].join('\n'));
				await timeout(vscode.commands.executeCommand('rubyStudio.refreshTests'), 'Stop Fixture Discovery');
				// Attach a rejection handler immediately while waiting for the actual
				// Ruby-side marker, so an early command failure cannot be unhandled.
				runPromise = Promise.resolve(vscode.commands.executeCommand('rubyStudio.runTests')).then(
					() => { runState = 'resolved'; return { ok: true }; },
					error => { runState = 'rejected'; return { ok: false, error }; }
				);
				const startDeadline = Date.now() + 20000;
				let started = false;
				while (Date.now() < startDeadline) {
					try { started = (await fs.readFile(startedMarker, 'utf8')).replace(/\r\n/g, '\n') === 'started\n'; }
					catch (error) { if (error.code !== 'ENOENT') { throw error; } }
					if (started) { break; }
					assert.equal(runState, 'pending', 'The run ended before entering the sleeping test.');
					await new Promise(resolve => setTimeout(resolve, 50));
				}
				assert.equal(started, true, 'The real Minitest fixture entered its 30-second sleep.');
				assert.equal(runState, 'pending', 'The Minitest fixture is still running when Stop is invoked.');
				const stopStarted = Date.now();
				await timeout(vscode.commands.executeCommand('rubyStudio.stop'), 'Native Stop Command', 5000);
				const outcome = await timeout(runPromise, 'Cancelled Native Test Run', Math.max(1, 5000 - (Date.now() - stopStarted)));
				const elapsedMs = Date.now() - stopStarted;
				assert.equal(outcome.ok, true, outcome.error?.message || 'The cancellation command settles cleanly.');
				assert.ok(elapsedMs < 5000, `Stopping took ${elapsedMs} ms.`);
				await assert.rejects(fs.access(finishedMarker), { code: 'ENOENT' });
				return { framework: 'minitest', sleepSeconds: 30, enteredTest: true, stopCommand: 'rubyStudio.stop', runSettled: true, stopElapsedMs: elapsedMs, finishedMarkerAbsent: true };
			} finally {
				if (runPromise) {
					try { await timeout(vscode.commands.executeCommand('rubyStudio.stop'), 'Stop Fixture Cleanup Command', 5000); }
					finally { await timeout(runPromise, 'Stop Fixture Process Cleanup', 35000); }
				}
				await Promise.all([testFile, startedMarker, finishedMarker].map(file => fs.rm(file, { force: true })));
				await timeout(vscode.commands.executeCommand('rubyStudio.refreshTests'), 'Stop Fixture Removal');
			}
		});
		await check('Native HTTP Command Sends a Real Request and Opens the Response', async () => {
			const requests = [];
			const expectedBody = { ok: true, doubled: 42, source: 'Ruby Studio Native HTTP' };
			const server = http.createServer((request, response) => {
				let body = '';
				request.setEncoding('utf8');
				request.on('data', chunk => { body += chunk; });
				request.on('end', () => {
					requests.push({ method: request.method, url: request.url, header: request.headers['x-ruby-studio-test'], body });
					response.writeHead(201, { 'content-type': 'application/json', 'x-ruby-studio-response': 'native-host' });
					response.end(JSON.stringify(expectedBody));
				});
			});
			let responseDocument;
			try {
				await timeout(new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }), 'Loopback HTTP Server');
				const address = server.address();
				assert.ok(address && typeof address === 'object');
				const requestUri = vscode.Uri.file(path.join(directory, 'native_request.http'));
				const payload = JSON.stringify({ value: 21, label: 'native host' });
				await fs.writeFile(requestUri.fsPath, `POST http://127.0.0.1:${address.port}/integration?source=native HTTP/1.1\nContent-Type: application/json\nX-Ruby-Studio-Test: original-client\n\n${payload}\n`);
				await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(requestUri));
				await timeout(vscode.commands.executeCommand('rubyStudio.sendRequest'), 'Native HTTP Send Command');
				responseDocument = vscode.window.activeTextEditor?.document;
				assert.ok(responseDocument?.isUntitled, 'The HTTP command opens a new response document.');
				const responseText = responseDocument.getText();
				assert.match(responseText, /^HTTP 201 Created\n/);
				assert.match(responseText, /x-ruby-studio-response: native-host/);
				assert.ok(responseText.includes(JSON.stringify(expectedBody)));
				assert.deepEqual(requests, [{ method: 'POST', url: '/integration?source=native', header: 'original-client', body: payload }]);
				return { request: requests[0], status: 'HTTP 201 Created', responseBody: expectedBody, responseEditorLanguage: responseDocument.languageId };
			} finally {
				if (responseDocument?.isUntitled && !responseDocument.isClosed) {
					await vscode.window.showTextDocument(responseDocument);
					await vscode.commands.executeCommand('workbench.action.revertAndCloseActiveEditor');
				}
				if (server.listening) { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
			}
		});
		await check('Native SQLite Open, Results Grid, Row Limit and Write Rejection', async () => {
			const { DatabaseSync } = require('node:sqlite');
			const databaseUri = vscode.Uri.file(path.join(directory, 'native_database.sqlite'));
			const fixture = new DatabaseSync(databaseUri.fsPath);
			try {
				fixture.exec('CREATE TABLE invoices (id INTEGER PRIMARY KEY, customer TEXT, total_cents INTEGER, note TEXT); CREATE TABLE bulk_values (value INTEGER);');
				const insert = fixture.prepare('INSERT INTO invoices VALUES (?, ?, ?, ?)');
				insert.run(1, 'Ada', 4200, null); insert.run(2, 'Grace', 1050, 'Paid');
				fixture.exec('WITH RECURSIVE seq(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seq WHERE n<501) INSERT INTO bulk_values SELECT n FROM seq;');
			} finally { fixture.close(); }
			const opened = await timeout(vscode.commands.executeCommand('rubyStudio.openDatabase', databaseUri), 'Native SQLite Open Command');
			assert.equal(opened?.fsPath, databaseUri.fsPath);
			const result = await timeout(vscode.commands.executeCommand('rubyStudio.queryDatabase', { file: databaseUri.fsPath, table: 'invoices' }), 'Native SQLite Results Command');
			assert.deepEqual(result.columns, ['id', 'customer', 'total_cents', 'note']);
			assert.deepEqual([...result.rows].sort((left, right) => Number(left.id) - Number(right.id)), [{ id: '1', customer: 'Ada', total_cents: '4200', note: 'NULL' }, { id: '2', customer: 'Grace', total_cents: '1050', note: 'Paid' }]);
			assert.equal(result.readOnly, true); assert.equal(result.truncated, false);
			const bounded = await timeout(vscode.commands.executeCommand('rubyStudio.queryDatabase', { file: databaseUri.fsPath, table: 'bulk_values' }), 'Native SQLite Bounded Results');
			assert.deepEqual({ rowCount: bounded.rows.length, truncated: bounded.truncated, readOnly: bounded.readOnly }, { rowCount: 500, truncated: true, readOnly: true });
			const sqlUri = vscode.Uri.file(path.join(directory, 'readonly_write.sql'));
			await fs.writeFile(sqlUri.fsPath, 'DELETE FROM invoices;\n');
			let sqlDocument = await vscode.workspace.openTextDocument(sqlUri);
			if (sqlDocument.languageId !== 'sql') { sqlDocument = await vscode.languages.setTextDocumentLanguage(sqlDocument, 'sql'); }
			await vscode.window.showTextDocument(sqlDocument);
			let writeError = '';
			await assert.rejects(timeout(vscode.commands.executeCommand('rubyStudio.queryDatabase', { file: databaseUri.fsPath }), 'Native SQLite Write Rejection'), error => { writeError = error.message; return /read.?only/i.test(writeError); });
			const unchanged = await vscode.commands.executeCommand('rubyStudio.queryDatabase', { file: databaseUri.fsPath, table: 'invoices' });
			assert.deepEqual(unchanged.rows, result.rows);
			return { columns: result.columns, rows: result.rows, truncated: result.truncated, readOnly: result.readOnly, displayCap: { rows: bounded.rows.length, truncated: bounded.truncated }, writeRejected: true, writeError, resultsWebview: 'rubyStudio.results' };
		});
		await check('Original DAP Breakpoint, Stack, Locals, Evaluate and Continue', async () => {
			await vscode.window.showTextDocument(document);
			const name = `Ruby Studio Integration ${path.basename(directory)}`;
			const messages = [];
			const waiting = [];
			const received = message => {
				messages.push(message);
				for (let index = waiting.length - 1; index >= 0; index--) {
					if (waiting[index].predicate(message)) { const waiter = waiting.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message); }
				}
			};
			const wait = (predicate, label) => {
				const existing = messages.find(predicate); if (existing) { return Promise.resolve(existing); }
				return new Promise((resolve, reject) => { const waiter = { predicate, resolve, timer: setTimeout(() => { const index = waiting.indexOf(waiter); if (index >= 0) { waiting.splice(index, 1); } reject(new Error(`${label} timed out; events: ${messages.filter(message => message.type === 'event').map(message => message.event).join(', ')}`)); }, 20000) }; waiting.push(waiter); });
			};
			disposables.push(vscode.debug.registerDebugAdapterTrackerFactory('rubyStudio', {
				createDebugAdapterTracker(session) {
					if (session.name !== name) { return undefined; }
					debugSession = session;
					return { onDidSendMessage: received, onError: error => received({ type: 'trackerError', message: error.message }), onExit: (code, signal) => received({ type: 'trackerExit', code, signal }) };
				}
			}));
			const breakpointLine = source.split('\n').findIndex(line => line === 'total = seed * 2');
			const breakpoint = new vscode.SourceBreakpoint(new vscode.Location(uri, new vscode.Position(breakpointLine, 0)), true);
			createdBreakpoints.push(breakpoint); vscode.debug.addBreakpoints([breakpoint]);
			try {
				assert.equal(await timeout(vscode.debug.startDebugging(folder, { type: 'rubyStudio', request: 'launch', name, script: uri.fsPath, args: ['integration argument with spaces'], cwd: directory, stopOnEntry: false }), 'Native Debug Launch'), true);
				const stopped = await wait(message => message.type === 'event' && message.event === 'stopped', 'DAP Stopped Event');
				assert.equal(stopped.body.reason, 'breakpoint');
				assert.ok(debugSession, 'The real tracker supplied the DebugSession.');
				const stack = await timeout(debugSession.customRequest('stackTrace', { threadId: 1 }), 'DAP Stack Trace');
				assert.equal(await fs.realpath(stack.stackFrames[0].source.path), await fs.realpath(uri.fsPath));
				assert.equal(stack.stackFrames[0].line, breakpointLine + 1);
				const scopes = await timeout(debugSession.customRequest('scopes', { frameId: stack.stackFrames[0].id }), 'DAP Scopes');
				const locals = scopes.scopes.find(scope => scope.name === 'Locals'); assert.ok(locals);
				const variables = await timeout(debugSession.customRequest('variables', { variablesReference: locals.variablesReference }), 'DAP Variables');
				assert.ok(variables.variables.some(variable => variable.name === 'seed' && variable.value === '21'));
				const evaluation = await timeout(debugSession.customRequest('evaluate', { frameId: stack.stackFrames[0].id, expression: 'seed * 2', context: 'repl' }), 'DAP Evaluate');
				assert.equal(evaluation.result, '42');
				await timeout(debugSession.customRequest('continue', { threadId: 1 }), 'DAP Continue');
				await wait(message => message.type === 'event' && message.event === 'terminated', 'DAP Terminated Event');
				return { adapter: 'rubyStudio', stoppedReason: stopped.body.reason, stackFrameCount: stack.stackFrames.length, scopeNames: scopes.scopes.map(scope => scope.name), localSeed: '21', evaluation: evaluation.result, terminated: true, output: messages.filter(message => message.type === 'event' && message.event === 'output').map(message => message.body.output).join('') };
			} finally { waiting.splice(0).forEach(waiter => clearTimeout(waiter.timer)); if (debugSession) { await vscode.debug.stopDebugging(debugSession); debugSession = undefined; } }
		});
	} catch (error) { results.fatalError = { message: error.message, stack: error.stack }; }
	finally {
		try {
			if (debugSession) { await timeout(vscode.debug.stopDebugging(debugSession), 'Integration Debug Cleanup', 5000); }
			vscode.debug.removeBreakpoints(createdBreakpoints);
			disposables.reverse().forEach(disposable => disposable.dispose());
			if (directory) {
				const inside = uri => uri?.scheme === 'file' && uri.fsPath.startsWith(directory + path.sep);
				for (const document of vscode.workspace.textDocuments) { if (inside(document.uri) && document.isDirty) { await document.save(); } }
				const tabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => tab.input instanceof vscode.TabInputText && inside(tab.input.uri));
				if (tabs.length) { await vscode.window.tabGroups.close(tabs, true); }
				const resultTabs = vscode.window.tabGroups.all.flatMap(group => group.tabs).filter(tab => !initialTabs.has(tab) && tab.input instanceof vscode.TabInputWebview && tab.input.viewType === 'rubyStudio.results');
				if (resultTabs.length) { await vscode.window.tabGroups.close(resultTabs, true); }
				await fs.rm(directory, { recursive: true, force: true });
			}
		} catch (error) { results.cleanupError = { message: error.message, stack: error.stack }; }
		results.finishedAt = new Date().toISOString();
		results.success = !results.fatalError && !results.cleanupError && results.checks.every(check => check.status === 'passed') && results.checks.length === 11;
		const destination = process.env.RUBY_STUDIO_INTEGRATION_RESULT || path.join(os.tmpdir(), 'ruby-studio-native-integration-result.json');
		await fs.mkdir(path.dirname(destination), { recursive: true });
		await fs.writeFile(destination, JSON.stringify(results, null, 2) + '\n');
	}
	if (!results.success) { throw new Error(`Ruby Studio integration failed: ${results.checks.filter(check => check.status === 'failed').map(check => check.name).join(', ') || results.fatalError?.message}`); }
};
