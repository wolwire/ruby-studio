/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { NativeRubyLexer } = require('../out/nativeLexer');
const { tokenizeRuby } = require('../out/languageModel');

(async () => {
	const client = new NativeRubyLexer(path.resolve(__dirname, '..'), message => { throw new Error(message); });
	const results = [];
	try {
		for (const lines of [250, 1000, 4000]) {
			const source = Array.from({ length: lines }, (_, i) => `value_${i} = items.map { |item| item + ${i} } # lexical throughput`).join('\n');
			assert.deepEqual(await client.tokenize(source), tokenizeRuby(source));
			const iterations = lines === 4000 ? 15 : 50;
			for (let i = 0; i < 4; i++) { tokenizeRuby(source); await client.tokenize(source); }
			let started = performance.now();
			for (let i = 0; i < iterations; i++) { tokenizeRuby(source); }
			const typescriptMs = (performance.now() - started) / iterations;
			started = performance.now();
			for (let i = 0; i < iterations; i++) { await client.tokenize(source); }
			const nativeWithIpcMs = (performance.now() - started) / iterations;
			results.push({ lines, bytes: Buffer.byteLength(source), iterations, typescriptMs, nativeWithIpcMs, speedupIncludingIpc: typescriptMs / nativeWithIpcMs });
		}
	} finally { client.dispose(); }
	const report = { protocol: 'binary-v1', date: new Date().toISOString(), node: process.version, platform: process.platform, arch: process.arch, scope: 'Synthetic original Ruby tokenization only. Rust timings include IPC, binary decoding, validation and token reconstruction. Excludes scope indexing and UI. Not a full IDE benchmark.', results };
	if (process.argv[2]) { fs.writeFileSync(process.argv[2], JSON.stringify(report, null, 2) + '\n'); }
	process.stdout.write(JSON.stringify(report, null, 2) + '\n');
})().catch(error => { process.stderr.write(error.stack + '\n'); process.exitCode = 1; });
