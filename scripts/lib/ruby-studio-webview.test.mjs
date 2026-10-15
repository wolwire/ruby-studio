/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const pre = new URL('../../src/vs/workbench/contrib/webview/browser/pre/', import.meta.url);
// HTML parsing normalizes CRLF/CR before CSP hashes are checked.
const html = fs.readFileSync(new URL('index.html', pre), 'utf8').replace(/\r\n?/g, '\n');
const start = html.indexOf('const workerReady =');
const end = html.indexOf('const hostMessaging =', start);
assert.ok(start > 0 && end > start);
const bootstrap = html.slice(start, end);
class Worker extends EventTarget {
	constructor(state = 'activated') { super(); this.state = state; this.messages = []; }
	postMessage(message) { this.messages.push(message); this.onPost?.(message); }
	change(state) { this.state = state; this.dispatchEvent(new Event('statechange')); }
}
function fixture(worker = new Worker()) {
	const container = new EventTarget(); container.controller = null;
	const registration = { active: worker, installing: null, waiting: null, updates: 0, async update() { this.updates++; return this; } };
	container.register = async () => registration;
	worker.onPost = () => { container.controller = worker; container.dispatchEvent(new Event('controllerchange')); };
	return { container, registration, worker };
}
function ready({ container }, disabled = false) {
	return vm.runInNewContext(`${bootstrap}\nworkerReady;`, { navigator: { serviceWorker: container }, disableServiceWorker: disabled, areServiceWorkersEnabled: () => true, expectedWorkerVersion: 6, searchParams: new URLSearchParams(), encodeURI, onElectron: true });
}
async function deadline(promise) {
	let timer;
	try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Worker control stalled')), 1000); })]); }
	finally { clearTimeout(timer); }
}
const turn = () => new Promise(resolve => setImmediate(resolve));

test('a detached client asks an already activated worker to claim it', async () => {
	const item = fixture(); await deadline(ready(item));
	assert.equal(item.registration.updates, 1);
	assert.equal(item.container.controller, item.worker);
	assert.equal(item.worker.messages.length, 1); assert.equal(item.worker.messages[0].channel, 'claim-client');
});

test('an already controlled webview checks for updates without a redundant claim', async () => {
	const item = fixture(); item.container.controller = item.worker;
	await deadline(ready(item)); assert.equal(item.registration.updates, 1); assert.equal(item.worker.messages.length, 0);
});

test('an installing update must activate and control the client before rendering', async () => {
	const item = fixture(); item.container.controller = item.worker;
	const update = new Worker('installing'); item.registration.installing = update;
	update.onPost = () => { item.container.controller = update; item.container.dispatchEvent(new Event('controllerchange')); };
	let settled = false; const promise = ready(item).then(() => { settled = true; });
	await turn(); assert.equal(settled, false); assert.equal(update.messages.length, 0);
	item.registration.active = update; item.registration.installing = null; update.change('activated');
	await deadline(promise); assert.equal(item.container.controller, update); assert.equal(update.messages.length, 1);
});

test('a worker that becomes redundant reports failure instead of leaving a blank webview', async () => {
	const item = fixture(new Worker('installing')); item.registration.installing = item.worker; item.registration.active = null;
	const failure = assert.rejects(deadline(ready(item)), /could not activate/);
	await turn(); item.worker.change('redundant'); await failure;
});

test('registration failures remain visible and disabled workers do not register', async () => {
	const item = fixture(); item.container.register = async () => { throw new Error('registration failure'); };
	await assert.rejects(deadline(ready(item)), /Could not register service worker.*registration failure/);
	await deadline(ready(item, true));
});

test('the shipped service worker handles client claims and shares the host protocol version', async () => {
	const code = fs.readFileSync(new URL('service-worker.js', pre), 'utf8');
	const host = fs.readFileSync(new URL('../webviewElement.ts', pre), 'utf8');
	assert.equal(code.match(/const VERSION = (\d+)/)[1], host.match(/_expectedServiceWorkerVersion = (\d+)/)[1]);
	const listeners = new Map(); let claims = 0; let lifetime;
	const location = new URL('vscode-webview://fixture/service-worker.js?v=6');
	const self = { location, clients: { async claim() { claims++; } }, addEventListener(type, handler) { listeners.set(type, handler); } };
	vm.runInNewContext(code, { self, location, URL, Response, Request, Headers, ReadableStream, TransformStream, performance: { mark() {} }, setTimeout, clearTimeout, console });
	await listeners.get('message')({ source: {}, data: { channel: 'claim-client' }, waitUntil(promise) { lifetime = promise; } });
	await lifetime; assert.ok(lifetime instanceof Promise); assert.equal(claims, 1);
});

test('the webview security policy authorizes the shipped inline bootstrap', () => {
	const scripts = [...html.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)];
	assert.equal(scripts.length, 1);
	const hash = createHash('sha256').update(scripts[0][1]).digest('base64');
	assert.ok(html.includes("script-src 'sha256-" + hash + "'"), 'Update the CSP hash whenever the inline bootstrap changes.');
});
