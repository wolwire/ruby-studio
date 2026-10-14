/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { parseRequest } = require('../out/httpModel');

test('request selection preserves header/body separators and substitutes explicit document variables', () => {
	assert.deepEqual(parseRequest('@host = http://localhost:4321\nGET {{host}}/first\n\n### Create\nPOST {{host}}/users HTTP/1.1\nContent-Type: application/json\nX-Token: test\n\n{"name":"Ruby"}\n', 8), {
		method: 'POST', url: 'http://localhost:4321/users', headers: { 'Content-Type': 'application/json', 'X-Token': 'test' }, body: '{"name":"Ruby"}'
	});
});

test('invalid protocol, missing variable and GET body fail before network activity', () => {
	for (const text of ['GET file:///etc/passwd', 'GET http://localhost/{{unknown}}', 'GET http://localhost\n\nbody']) {
		assert.throws(() => parseRequest(text, 0));
	}
});

test('parsed request works end to end against a real local HTTP server', async () => {
	const server = http.createServer((request, response) => {
		let text = '';
		request.on('data', chunk => { text += chunk; });
		request.on('end', () => { response.writeHead(201, { 'content-type': 'application/json' }); response.end(JSON.stringify({ method: request.method, path: request.url, body: text, token: request.headers['x-token'] })); });
	});
	server.listen(0, '127.0.0.1');
	await once(server, 'listening');
	try {
		const plan = parseRequest(`POST http://127.0.0.1:${server.address().port}/items\nX-Token: fixture\n\nhello`, 0);
		const response = await fetch(plan.url, plan);
		assert.deepEqual({ status: response.status, result: await response.json() }, { status: 201, result: { method: 'POST', path: '/items', body: 'hello', token: 'fixture' } });
	} finally { await new Promise(resolve => server.close(resolve)); }
});
