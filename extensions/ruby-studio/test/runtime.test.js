/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { resolveRuntime } = require('../out/runtime');
const { parseRunConfigurations, buildRunPlan } = require('../out/execution');
const execute = promisify(execFile);
let directory;
let sdk;

before(async () => {
	directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ruby studio runtime-')));
	sdk = await resolveRuntime({ cwd: directory, configuredPath: process.env.RUBY_STUDIO_RUBY || 'ruby', trusted: true });
});
after(async () => { await fs.rm(directory, { recursive: true, force: true }); });

test('SDK resolution validates real Ruby and preserves its gem/library environment', async () => {
	const { stdout } = await execute(sdk.ruby, ['-rjson', '-rrubygems', '-ropenssl', '-e', 'puts JSON.generate({cwd: Dir.pwd, gems: Gem.path, version: RUBY_VERSION, openssl: OpenSSL::OPENSSL_VERSION})'], { cwd: sdk.cwd, env: sdk.env });
	const result = JSON.parse(stdout);
	assert.deepEqual({ cwd: path.normalize(result.cwd), version: /^\d+\.\d+/.test(result.version), gems: result.gems.length > 0, openssl: result.openssl.startsWith('OpenSSL') }, { cwd: directory, version: true, gems: true, openssl: true });
});

test('untrusted SDK resolution cannot execute even an explicitly selected wrapper', async () => {
	const marker = path.join(directory, 'should-not-exist');
	const wrapper = path.join(directory, 'untrusted-ruby');
	await fs.writeFile(wrapper, `#!/bin/sh\ntouch '${marker}'\nexit 1\n`, { mode: 0o755 });
	await assert.rejects(resolveRuntime({ cwd: directory, configuredPath: wrapper, trusted: false }), /Trust/);
	await assert.rejects(fs.access(marker), { code: 'ENOENT' });
});

test('a missing explicitly selected SDK fails instead of silently using another Ruby', async () => {
	await assert.rejects(resolveRuntime({ cwd: directory, configuredPath: './missing-ruby', trusted: true }), /not found/);
});

test('run plan preserves cwd, environment and argument boundaries with real Ruby', async () => {
	const working = path.join(directory, 'working directory');
	await fs.mkdir(working);
	const script = path.join(working, 'main file.rb');
	await fs.writeFile(script, 'require "json"\nputs JSON.generate({args: ARGV, cwd: Dir.pwd, marker: ENV["APP_MARKER"]})\n');
	const plan = await buildRunPlan({ name: 'Arguments', type: 'ruby', script: 'main file.rb', cwd: 'working directory', args: ['with spaces', "quote' and \"double\"", '$(touch should-not-exist)'], env: { APP_MARKER: '${workspaceFolder}' } }, sdk);
	const { stdout } = await execute(plan.executable, plan.args, { cwd: plan.cwd, env: plan.env });
	const output = JSON.parse(stdout);
	assert.deepEqual({ ...output, cwd: path.normalize(output.cwd) }, { args: ['with spaces', "quote' and \"double\"", '$(touch should-not-exist)'], cwd: working, marker: directory });
	await assert.rejects(fs.access(path.join(working, 'should-not-exist')), { code: 'ENOENT' });
});

test('run configuration rejects malformed input before a process can be constructed', () => {
	assert.throws(() => parseRunConfigurations('{"configurations":[{"name":"bad","type":"ruby","args":"--oops"}]}'), /arguments/);
	assert.throws(() => parseRunConfigurations('{"configurations":[{"name":"bad","type":"shell"}]}'), /ruby, rails/);
	assert.throws(() => parseRunConfigurations('{"configurations":[{"name":"bad","type":"ruby","env":{"INJECT;BAD":"x"}}]}'), /environment/);
});

test('Bundler selection validates Gemfile and invokes the selected real Ruby', async () => {
	await assert.rejects(buildRunPlan({ name: 'Bundle', type: 'ruby', script: 'missing.rb', bundle: true }, sdk));
	const script = path.join(directory, 'bundled.rb');
	await fs.writeFile(script, 'puts "bundled:" + RUBY_VERSION\n');
	await fs.writeFile(path.join(directory, 'Gemfile'), '# This fixture needs no external gems.\n');
	const plan = await buildRunPlan({ name: 'Bundle', type: 'ruby', script, bundle: true }, sdk);
	const { stdout } = await execute(plan.executable, plan.args, { cwd: plan.cwd, env: plan.env });
	assert.match(stdout, /^bundled:\d+\.\d+/);
});

test('Bundler activates the installed locked version before setup can re-execute a spaced SDK path', async () => {
	const { stdout: available } = await execute(sdk.ruby, ['-rrubygems', '-e', 'puts Gem::Specification.find_all_by_name("bundler").map(&:version).max'], { cwd: sdk.cwd, env: sdk.env });
	const locked = available.trim();
	assert.match(locked, /^\d+\.\d+/);
	await fs.writeFile(path.join(directory, 'Gemfile'), '# No external gems are needed.\n');
	await fs.writeFile(path.join(directory, 'Gemfile.lock'), `GEM\n  specs:\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n\nBUNDLED WITH\n   ${locked}\n`);
	const script = path.join(directory, 'locked.rb');
	await fs.writeFile(script, 'puts Gem.loaded_specs.fetch("bundler").version\n');
	const plan = await buildRunPlan({ name: 'Locked Bundle', type: 'ruby', script, bundle: true }, sdk);
	const { stdout } = await execute(plan.executable, plan.args, { cwd: plan.cwd, env: plan.env });
	assert.equal(stdout.trim(), locked);
});

test('real Ruby warnings and syntax errors retain different task diagnostic severities', async () => {
	const matcher = require('../package.json').contributes.problemMatchers.find(value => value.name === 'rubyStudioRuntime');
	assert.ok(matcher);
	const pattern = new RegExp(matcher.pattern.regexp);
	const warningFile = path.join(directory, 'warning.rb');
	await fs.writeFile(warningFile, 'unused = 1\n');
	const warning = await execute(sdk.ruby, ['-w', warningFile], { cwd: sdk.cwd, env: sdk.env });
	const warningMatch = warning.stderr.split('\n').map(line => pattern.exec(line)).find(Boolean);
	assert.equal(path.normalize(warningMatch?.[matcher.pattern.file] || ''), warningFile);
	assert.equal(warningMatch?.[matcher.pattern.severity], 'warning');
	const errorFile = path.join(directory, 'syntax_error.rb');
	await fs.writeFile(errorFile, '(\n');
	await assert.rejects(execute(sdk.ruby, ['-c', errorFile], { cwd: sdk.cwd, env: sdk.env }), error => {
		const errorMatch = error.stderr.split('\n').map(line => pattern.exec(line)).find(Boolean);
		assert.equal(path.normalize(errorMatch?.[matcher.pattern.file] || ''), errorFile);
		assert.equal(errorMatch?.[matcher.pattern.severity] || matcher.severity, 'error');
		assert.match(errorMatch?.[matcher.pattern.message] || '', /syntax error/);
		return true;
	});
});
