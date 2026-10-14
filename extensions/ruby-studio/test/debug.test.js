/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { resolveRuntime } = require('../out/runtime');
const { RubyDebugBridge } = require('../out/debug');
let directory;
let sdk;
const bridgePath = path.resolve(__dirname, '../ruby/debug_bridge.rb');

before(async () => {
	directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'ruby studio debug-')));
	sdk = await resolveRuntime({ cwd: directory, configuredPath: process.env.RUBY_STUDIO_RUBY || 'ruby', trusted: true });
});
after(async () => { await fs.rm(directory, { recursive: true, force: true }); });

function record(bridge) {
	const events = [];
	const waiting = [];
	let output = '';
	const publish = item => {
		const index = waiting.findIndex(waiter => waiter.event === item.event);
		if (index >= 0) { const waiter = waiting.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(item); }
		else { events.push(item); }
	};
	bridge.on('event', publish);
	bridge.on('exit', body => publish({ event: 'exit', body }));
	bridge.on('output', body => { output += body.output; publish({ event: 'output', body }); });
	return {
		output: () => output,
		next: event => {
			const index = events.findIndex(item => item.event === event);
			if (index >= 0) { return Promise.resolve(events.splice(index, 1)[0]); }
			return new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error(`Waiting for ${event}; output: ${output}`)), 10000); waiting.push({ event, resolve, timer }); });
		}
	};
}

test('real TracePoint breakpoints, stepping, stack, locals, nested variables and evaluate', async () => {
	const lines = [
		'class Dangerous',
		'  def inspect; raise "Automatic inspect must not run"; end',
		'end',
		'def twice(value)',
		'  total = value * 2',
		'  total + 1',
		'end',
		'value = 10',
		'data = {"answer" => value}',
		'danger = Dangerous.new',
		'result = twice(value)',
		'puts JSON.generate({result: result, args: ARGV, marker: ENV["APP_MARKER"]})',
		'# A breakpoint on this comment relocates to the next executable line.',
		'puts %q({"type":"response","id":1,"result":"normal program output"})'
	];
	const script = path.join(directory, 'program with spaces.rb');
	await fs.writeFile(script, lines.join('\n') + '\n');
	const bridge = await RubyDebugBridge.launch({ runtime: { ...sdk, env: { ...sdk.env, APP_MARKER: 'selected environment' } }, bridgePath, script, args: ['argument with spaces', "quote'"], trusted: true });
	const recorded = record(bridge);
	try {
		assert.deepEqual((await bridge.request('setBreakpoints', { path: script, lines: [13] })).breakpoints, [{ verified: true, line: 14 }]);
		assert.deepEqual((await bridge.request('setBreakpoints', { path: script, lines: [11, 999] })).breakpoints, [{ verified: true, line: 11 }, { verified: false, line: 999 }]);
		await bridge.request('start');
		assert.equal((await recorded.next('stopped')).body.reason, 'breakpoint');
		let stack = (await bridge.request('stackTrace')).stackFrames;
		assert.equal(stack[0].line, 11);
		const frameId = stack[0].id;
		const scopes = (await bridge.request('scopes', { frameId })).scopes;
		const locals = (await bridge.request('variables', { variablesReference: scopes[0].variablesReference })).variables;
		assert.deepEqual(locals.filter(item => ['value', 'danger'].includes(item.name)).map(item => [item.name, item.value]), [['danger', '#<Dangerous>'], ['value', '10']]);
		const data = locals.find(item => item.name === 'data');
		assert.equal((await bridge.request('variables', { variablesReference: data.variablesReference })).variables[0].value, '10');
		assert.equal((await bridge.request('evaluate', { frameId, expression: 'value + 5' })).result, '15');
		await assert.rejects(bridge.request('evaluate', { frameId, expression: 'raise "explicit evaluation error"' }), /explicit evaluation error/);
		await bridge.request('stepIn');
		await recorded.next('stopped');
		stack = (await bridge.request('stackTrace')).stackFrames;
		assert.deepEqual([stack[0].name, stack[0].line, stack.length], ['twice', 5, 2]);
		await bridge.request('next');
		await recorded.next('stopped');
		stack = (await bridge.request('stackTrace')).stackFrames;
		assert.equal((await bridge.request('evaluate', { frameId: stack[0].id, expression: 'total' })).result, '20');
		await bridge.request('stepOut');
		await recorded.next('stopped');
		assert.equal((await bridge.request('stackTrace')).stackFrames[0].line, 12);
		await bridge.request('continue');
		await recorded.next('exit');
		const output = recorded.output();
		assert.deepEqual(JSON.parse(output.split('\n')[0]), { result: 21, args: ['argument with spaces', "quote'"], marker: 'selected environment' });
		assert.match(output, /normal program output/);
	} finally { bridge.dispose(); }
});

test('stopOnEntry pauses before executing the first statement and stop kills the owned process', async () => {
	const script = path.join(directory, 'long running.rb');
	await fs.writeFile(script, 'puts "started"\nloop { sleep 0.1 }\n');
	const bridge = await RubyDebugBridge.launch({ runtime: sdk, bridgePath, script, trusted: true });
	const recorded = record(bridge);
	try {
		await bridge.request('start', { stopOnEntry: true });
		assert.equal((await recorded.next('stopped')).body.reason, 'entry');
		assert.equal(recorded.output(), '');
		const exited = recorded.next('exit');
		bridge.dispose();
		const event = await exited;
		assert.ok(event.body.signal === 'SIGTERM' || event.body.code === 0);
	} finally { bridge.dispose(); }
});

test('untrusted debug launch never starts a Ruby process', async () => {
	await assert.rejects(RubyDebugBridge.launch({ runtime: sdk, bridgePath, script: path.join(directory, 'does-not-exist.rb'), trusted: false }), /Trust/);
});

test('stop also terminates child processes in the owned Linux process group', { skip: process.platform !== 'linux' }, async () => {
	const script = path.join(directory, 'with child.rb');
	await fs.writeFile(script, 'child = fork { loop { sleep 0.1 } }\nSTDOUT.write("child=#{child}\\n")\nloop { sleep 0.1 }\n');
	const bridge = await RubyDebugBridge.launch({ runtime: sdk, bridgePath, script, trusted: true });
	const recorded = record(bridge);
	let childPid;
	try {
		await bridge.request('start');
		while (!/child=\d+/.test(recorded.output())) { await recorded.next('output'); }
		childPid = Number(recorded.output().match(/child=(\d+)/)[1]);
		const exited = recorded.next('exit');
		bridge.dispose();
		await exited;
		let state = '';
		for (let attempt = 0; attempt < 20; attempt++) {
			try { state = (await fs.readFile(`/proc/${childPid}/status`, 'utf8')).match(/^State:\s+(\w)/m)[1]; }
			catch (error) { if (error.code === 'ENOENT') { state = 'gone'; } else { throw error; } }
			if (state === 'gone' || state === 'Z') { break; }
			await new Promise(resolve => setTimeout(resolve, 50));
		}
		assert.ok(state === 'gone' || state === 'Z', `Child still running: ${state}`);
	} finally { bridge.dispose(); if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch { /* Already stopped. */ } } }
});
