/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const worker = process.env.RUBY_STUDIO_NATIVE_LEXER || path.join(__dirname, '../native/bin', `${process.platform}-${process.arch}`, 'ruby-studio-lexer' + (process.platform === 'win32' ? '.exe' : ''));
const archive = path.join(__dirname, '../native/tests/fixtures/ruby-sdk.7z');
const extract = (source, destination, root = 'ruby-sdk') => execFileSync(worker, ['--extract-ruby-sdk', source, destination, root], { encoding: 'utf8', stdio: 'pipe' });
async function fixture(t) { const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ruby-sdk-extract spaces ')); t.after(() => fs.rm(directory, { recursive: true, force: true })); return directory; }

test('bundled native SDK decoder extracts LZMA2 archives with spaces in destination paths', async t => {
	const directory = await fixture(t); extract(archive, directory);
	assert.equal(await fs.readFile(path.join(directory, 'ruby-sdk/bin/ruby.exe'), 'utf8'), 'Ruby Studio portable SDK archive fixture\n');
});

test('native SDK extraction rejects mismatched roots and preserves nonempty destinations', async t => {
	const directory = await fixture(t); assert.throws(() => extract(archive, directory, 'unexpected-root'), /Unexpected Ruby SDK archive path/);
	assert.deepEqual(await fs.readdir(directory), []); await fs.writeFile(path.join(directory, 'keep'), 'existing SDK');
	assert.throws(() => extract(archive, directory), /empty directory/); assert.equal(await fs.readFile(path.join(directory, 'keep'), 'utf8'), 'existing SDK');
});

test('native SDK decoder rejects corrupted archives rather than reporting installation success', async t => {
	const directory = await fixture(t); const damaged = path.join(directory, 'damaged.7z'); const destination = path.join(directory, 'extracted'); await fs.mkdir(destination);
	const bytes = await fs.readFile(archive); await fs.writeFile(damaged, bytes.subarray(0, bytes.length - 12));
	assert.throws(() => extract(damaged, destination));
});
