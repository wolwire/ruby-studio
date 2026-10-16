/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';
const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const filename = path.join(__dirname, '..', 'out', 'testing.js');
const exportsObject = {};
vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
	exports: exportsObject, module: { exports: exportsObject }, require: id => id === 'vscode' ? {} : createRequire(filename)(id)
}, { filename });
const { discoverRubyTests, parseTestEvent, detectRubyTestFramework, resolveRubyTestFramework, rubyTestProcessOptions } = exportsObject;
const plain = value => JSON.parse(JSON.stringify(value));

test('static discovery identifies public test declarations with source lines', () => {
	assert.deepEqual(plain(discoverRubyTests('# def test_ignored\nclass Example < Minitest::Test\n  def test_one\n  end\n  test "validates a record" do\n  end\nend', 'minitest')), [
		{ name: 'test_one', line: 2, filter: 'test_one' }, { name: 'validates a record', line: 4 }
	]);
	assert.deepEqual(plain(discoverRubyTests('RSpec.describe User do\n  it "saves" do\n  end\n  specify("loads") do\n  end\nend', 'rspec')), [{ name: 'saves', line: 1 }, { name: 'loads', line: 3 }]);
});

test('event boundary rejects malformed, missing and invalid status/timing payloads', () => {
	const prefix = '@@RUBY_STUDIO@@';
	const payload = { event: 'finished', id: 'Example#test_one', name: 'test_one', file: '/project/test/example_test.rb', line: 3, status: 'passed', duration: 1.25, message: '' };
	assert.deepEqual(plain(parseTestEvent(prefix + JSON.stringify(payload))), payload);
	assert.deepEqual([
		'normal test output', prefix + '{', prefix + '{}',
		prefix + JSON.stringify({ ...payload, status: 'unknown' }), prefix + JSON.stringify({ ...payload, duration: -1 }),
		prefix + JSON.stringify({ ...payload, line: '3' }), prefix + JSON.stringify({ ...payload, message: {} })
	].map(line => parseTestEvent(line)), [undefined, undefined, undefined, undefined, undefined, undefined, undefined]);
});

const ruby = process.env.RUBY_STUDIO_TEST_RUBY || 'ruby';
const helper = name => path.join(__dirname, '..', 'ruby', name);
const rubyAvailable = spawnSync(ruby, ['-e', "require 'minitest/autorun'"], { encoding: 'utf8' }).status === 0;
const rspecAvailable = spawnSync(ruby, ['-e', "require 'rspec/core'"], { encoding: 'utf8' }).status === 0;
function events(result) {
	return result.stdout.split(/\r?\n/).map(line => parseTestEvent(line)).filter(Boolean);
}
function fixture(t, name, source) {
	const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ruby-studio-tests-')));
	t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
	const file = path.join(directory, name);
	fs.writeFileSync(file, source);
	return file;
}

test('original Minitest helper reports pass/failure/error/skip with navigable locations', { skip: !rubyAvailable && 'Ruby with Minitest is unavailable; set RUBY_STUDIO_TEST_RUBY.' }, t => {
	const file = fixture(t, 'example_test.rb', `require 'minitest/autorun'
class OriginalBridgeTest < Minitest::Test
  def test_pass
    assert_equal 2, 1 + 1
  end
  def test_fail
    assert_equal 3, 1 + 1
  end
  def test_error
    raise 'intentional error'
  end
  def test_skip
    skip 'intentional skip'
  end
end
`);
	const result = spawnSync(ruby, [helper('minitest_runner.rb'), JSON.stringify({ files: [file] })], { encoding: 'utf8', timeout: 15000 });
	assert.equal(result.status, 1, result.stderr);
	const finished = events(result).filter(event => event.event === 'finished');
	assert.deepEqual(finished.map(event => [event.name, event.status, path.normalize(event.file), event.line]).sort(), [
		['test_error', 'errored', file, 9], ['test_fail', 'failed', file, 6], ['test_pass', 'passed', file, 3], ['test_skip', 'skipped', file, 12]
	]);
	assert.ok(finished.every(event => typeof event.duration === 'number' && event.duration >= 0));
});

test('original Minitest selection uses source locations without prefix-name collisions', { skip: !rubyAvailable && 'Ruby with Minitest is unavailable.' }, t => {
	const file = fixture(t, 'selection_test.rb', `require 'minitest/autorun'
class SelectionTest < Minitest::Test
  def test_one
    assert true
  end
  def test_one_extra
    flunk 'must not run'
  end
end
`);
	const result = spawnSync(ruby, [helper('minitest_runner.rb'), JSON.stringify({ files: [file], lines: [3] })], { encoding: 'utf8', timeout: 15000 });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(events(result).filter(event => event.event === 'finished').map(event => [event.name, event.status]), [['test_one', 'passed']]);
});

test('original RSpec helper reports example lifecycle, failure and pending state', { skip: !rspecAvailable && 'Project RSpec is unavailable; set RUBY_STUDIO_TEST_RUBY/GEM_PATH.' }, t => {
	const file = fixture(t, 'example_spec.rb', `RSpec.describe 'Original Bridge' do
  it('passes') { expect(1 + 1).to eq(2) }
  it('fails') { expect(1 + 1).to eq(3) }
  xit('waits') { expect(true).to eq(false) }
end
`);
	const result = spawnSync(ruby, [helper('rspec_formatter.rb'), file], { encoding: 'utf8', timeout: 15000 });
	assert.equal(result.status, 1, result.stderr);
	assert.deepEqual(events(result).filter(event => event.event === 'finished').map(event => [event.name, event.status, event.line]), [
		['Original Bridge passes', 'passed', 2], ['Original Bridge fails', 'failed', 3], ['Original Bridge waits', 'skipped', 4]
	]);
});


test('framework detection separates Minitest specs from RSpec and refuses ambiguous filenames', () => {
	assert.deepEqual([
		detectRubyTestFramework("require 'minitest/spec'\ndescribe 'value' do\n  it('works') { 1.must_equal 1 }\nend", '/project/spec/value_spec.rb'),
		detectRubyTestFramework("RSpec.describe Value do\n  it('works') { expect(1).to eq(1) }\nend", '/project/spec/value_spec.rb'),
		detectRubyTestFramework("describe 'value' do\n  it('works') { }\nend", '/project/spec/value_spec.rb'),
		detectRubyTestFramework("require 'rspec/core'\nrequire 'minitest/spec'", '/project/spec/mixed_spec.rb')
	], ['minitest', 'rspec', undefined, undefined]);
});

test('framework detection follows local helper imports without executing Ruby', async t => {
	const file = fixture(t, 'value_spec.rb', "require_relative 'spec_helper'\ndescribe('value') { it('works') { } }\n");
	fs.writeFileSync(path.join(path.dirname(file), 'spec_helper.rb'), "require_relative 'framework_helper'\n");
	fs.writeFileSync(path.join(path.dirname(file), 'framework_helper.rb'), "require 'minitest/autorun'\n");
	assert.equal(await resolveRubyTestFramework(fs.readFileSync(file, 'utf8'), file, path.dirname(file)), 'minitest');
	fs.writeFileSync(path.join(path.dirname(file), 'framework_helper.rb'), "require 'rspec/core'\n");
	assert.equal(await resolveRubyTestFramework(fs.readFileSync(file, 'utf8'), file, path.dirname(file)), 'rspec');
});

test('real Minitest spec runs through Minitest adapter despite its _spec filename', { skip: !rubyAvailable && 'Ruby with Minitest is unavailable.' }, async t => {
	const file = fixture(t, 'value_spec.rb', `require_relative 'spec_helper'
describe 'Value' do
  it 'works' do
    assert_equal 2, 1 + 1
  end
end
`);
	fs.writeFileSync(path.join(path.dirname(file), 'spec_helper.rb'), "require 'minitest/autorun'\n");
	assert.equal(await resolveRubyTestFramework(fs.readFileSync(file, 'utf8'), file, path.dirname(file)), 'minitest');
	const result = spawnSync(ruby, [helper('minitest_runner.rb'), JSON.stringify({ files: [file], lines: [3] })], { encoding: 'utf8', cwd: path.dirname(file), timeout: 15000 });
	assert.equal(result.status, 0, result.stderr);
	assert.deepEqual(events(result).filter(event => event.event === 'finished').map(event => [event.name, event.status]), [['test_0001_works', 'passed']]);
});

test('Rails test execution adds project load paths, defaults Rails env and preserves overrides', { skip: !rubyAvailable && 'Ruby with Minitest is unavailable.' }, async t => {
	const file = fixture(t, 'environment_test.rb', `require 'test_helper'
require 'project_value'
class EnvironmentTest < Minitest::Test
  def test_environment_and_loadpath
    assert_equal ENV.fetch('EXPECTED_RAILS_ENV', 'test'), ENV['RAILS_ENV']
    assert_equal 7, PROJECT_VALUE
  end
end
`);
	const directory = path.dirname(file);
	for (const name of ['config', 'lib', 'test']) { fs.mkdirSync(path.join(directory, name)); }
	fs.writeFileSync(path.join(directory, 'config', 'application.rb'), '# Rails fixture marker\n');
	fs.writeFileSync(path.join(directory, 'lib', 'project_value.rb'), 'PROJECT_VALUE = 7\n');
	fs.writeFileSync(path.join(directory, 'test', 'test_helper.rb'), "require 'minitest/autorun'\n");
	for (const overrides of [{ RAILS_ENV: undefined }, { RAILS_ENV: 'custom', EXPECTED_RAILS_ENV: 'custom' }]) {
		const options = await rubyTestProcessOptions(directory, { ...process.env, ...overrides });
		assert.deepEqual(plain(options.rubyArgs), ['-I', path.join(directory, 'lib'), '-I', path.join(directory, 'test')]);
		const result = spawnSync(ruby, [...options.rubyArgs, helper('minitest_runner.rb'), JSON.stringify({ files: [file] })], { encoding: 'utf8', cwd: directory, env: options.env, timeout: 15000 });
		assert.equal(result.status, 0, result.stderr);
		assert.deepEqual(events(result).filter(event => event.event === 'finished').map(event => event.status), ['passed']);
	}
});

function cancellationHarness(directory, file) {
	const commands = new Map();
	const contexts = [];
	const disposable = () => ({ dispose() { } });
	class CancellationSource {
		constructor() {
			this.listeners = new Set();
			this.token = { isCancellationRequested: false, onCancellationRequested: listener => {
				this.listeners.add(listener);
				return { dispose: () => this.listeners.delete(listener) };
			} };
		}
		cancel() {
			if (this.token.isCancellationRequested) { return; }
			this.token.isCancellationRequested = true;
			for (const listener of this.listeners) { listener(); }
		}
		dispose() { this.listeners.clear(); }
	}
	const uri = file => ({ fsPath: file, path: file, toString: () => file });
	const folder = { uri: uri(directory), name: 'Cancellation Fixture', index: 0 };
	function collection(parent) {
		const map = new Map();
		return { get size() { return map.size; }, get: id => map.get(id), delete: id => map.delete(id), forEach: callback => map.forEach(callback), add: item => { item.parent = parent; map.set(item.id, item); }, replace: items => { map.clear(); for (const item of items) { item.parent = parent; map.set(item.id, item); } } };
	}
	let started;
	const didStart = new Promise(resolve => { started = resolve; });
	let runHandler;
	const controller = {
		items: collection(), dispose() { },
		createTestItem: (id, label, uri) => { const item = { id, label, uri }; item.children = collection(item); return item; },
		createRunProfile: (_name, kind, callback) => { if (kind === 1) { runHandler = callback; } return disposable(); },
		createTestRun: () => ({ enqueued() { }, started() { started(); }, appendOutput() { }, skipped() { }, errored() { }, failed() { }, passed() { }, end() { } })
	};
	const watcher = { dispose() { }, onDidCreate: disposable, onDidChange: disposable, onDidDelete: disposable };
	const api = {
		tests: { createTestController: () => controller }, CancellationTokenSource: CancellationSource,
		Disposable: class { constructor(callback) { this.callback = callback; } dispose() { this.callback(); } },
		TestRunProfileKind: { Run: 1, Debug: 2 },
		Range: class { constructor(line, column, endLine, endColumn) { this.start = { line, character: column }; this.end = { line: endLine, character: endColumn }; } },
		Location: class { }, TestMessage: class { constructor(message) { this.message = message; } },
		Uri: { joinPath: (base, ...parts) => uri(path.join(base.fsPath, ...parts)) },
		l10n: { t: text => text },
		commands: { registerCommand: (id, callback) => { commands.set(id, callback); return disposable(); }, executeCommand: async (...args) => { contexts.push(args); } },
		workspace: { getConfiguration: () => ({ get: (_key, fallback) => fallback }), isTrusted: true, saveAll: async () => true, getWorkspaceFolder: () => folder, findFiles: async () => [uri(file)], fs: { readFile: async uri => fs.promises.readFile(uri.fsPath) }, createFileSystemWatcher: () => watcher, onDidChangeTextDocument: disposable },
		window: { showWarningMessage() { }, showErrorMessage() { } },
		debug: { onDidStartDebugSession: disposable, onDidTerminateDebugSession: disposable, registerDebugAdapterTrackerFactory: disposable }
	};
	const moduleExports = {};
	vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { exports: moduleExports, module: { exports: moduleExports }, Buffer, setTimeout, clearTimeout, require: id => id === 'vscode' ? api : createRequire(filename)(id) }, { filename });
	const disposables = moduleExports.registerTesting({ extensionUri: uri(path.join(__dirname, '..')) }, { get: async () => ({ ruby, cwd: directory, env: process.env }) });
	return { commands, contexts, didStart, disposables, incoming: new CancellationSource(), run: () => runHandler({}, new CancellationSource().token), runWith: token => runHandler({}, token) };
}

test('Stop command, incoming cancellation and activation teardown terminate real test subprocesses', { skip: !rubyAvailable && 'Ruby with Minitest is unavailable.' }, async t => {
	for (const mode of ['command', 'incoming', 'teardown']) {
		const file = fixture(t, `${mode}_test.rb`, `require 'minitest/autorun'
class CancellationTest < Minitest::Test
  def test_wait
    sleep 30
  end
end
`);
		const harness = cancellationHarness(path.dirname(file), file);
		t.after(() => harness.disposables.forEach(item => item.dispose()));
		const running = harness.runWith(harness.incoming.token);
		let timeout;
		try {
			await Promise.race([harness.didStart, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Test subprocess did not start')), 5000); })]);
			clearTimeout(timeout);
			if (mode === 'command') { harness.commands.get('rubyStudio.cancelTests')(); }
			if (mode === 'incoming') { harness.incoming.cancel(); }
			if (mode === 'teardown') { harness.disposables.forEach(item => item.dispose()); }
			await Promise.race([running, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(`Test subprocess did not cancel: ${mode}`)), 5000); })]);
			assert.ok(harness.contexts.some(args => args[1] === 'rubyStudio.isTesting' && args[2] === true));
			assert.deepEqual(harness.contexts.at(-1), ['setContext', 'rubyStudio.isTesting', false]);
			assert.ok(harness.contexts.every(args => args[1] !== 'rubyStudio.isRunning'));
		} finally { clearTimeout(timeout); harness.incoming.cancel(); }
	}
});
