/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { NativeRubyLexer } = require('../out/nativeLexer');
const { tokenizeRuby } = require('../out/languageModel');

test('persistent native client correlates concurrent document requests and preserves UTF-16 positions', async () => {
	const errors = [];
	const client = new NativeRubyLexer(path.resolve(__dirname, '..'), text => errors.push(text));
	try {
		const sources = Array.from({ length: 12 }, (_, i) => `# Doc ${i} 💎\nmodule Billing\n  class Invoice${i}\n    def total(amount)\n      value = amount + ${i}\n      "text #{value}"\n    end\n  end\nend\n`);
		const actual = await Promise.all(sources.map(source => client.tokenize(source)));
		assert.deepEqual(actual, sources.map(tokenizeRuby));
		assert.deepEqual(errors, []);
		assert.match(client.status, /^Rust worker \(12 documents/);
	} finally { client.dispose(); }
});

test('missing native binary reports once and returns a usable fallback signal', async () => {
	const errors = [];
	const client = new NativeRubyLexer('/nonexistent-ruby-studio-extension', text => errors.push(text));
	try {
		assert.equal(await client.tokenize('puts 1'), undefined);
		assert.equal(await client.tokenize('puts 2'), undefined);
		assert.equal(errors.length, 1);
		assert.equal(client.status, 'TypeScript fallback');
	} finally { client.dispose(); }
});

test('disposing a native worker resolves pending work and prevents new requests', async () => {
	const client = new NativeRubyLexer(path.resolve(__dirname, '..'), () => {});
	const pending = client.tokenize('puts 1\n');
	client.dispose();
	assert.equal(await pending, undefined);
	assert.equal(await client.tokenize('puts 2'), undefined);
});
