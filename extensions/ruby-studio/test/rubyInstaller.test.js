/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { RubyInstaller, parseRubyVersions, parseRubySourceCatalog, parseRubyWindowsCatalog, validateRubyArchive } = require('../out/rubyInstaller');
const { resolveRuntime } = require('../out/runtime');
const native = { skip: process.platform === 'win32' };

async function fixture(t, mode = 'success') {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), "ruby installer ' $ "));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const sdk = await resolveRuntime({ cwd: directory, configuredPath: process.env.RUBY_STUDIO_RUBY || 'ruby', trusted: true });
	const version = sdk.version.split(' ')[1].replace(/p\d+$/, '');
	const root = `ruby-${version}`; const source = path.join(directory, root); await fs.mkdir(source);
	const actual = '#!/bin/sh\nexec ' + "'" + sdk.ruby.replace(/'/g, "'\\''") + "'" + ' "$@"\n';
	const calls = path.join(directory, 'calls'); const marker = path.join(directory, 'orphan');
	await fs.writeFile(path.join(source, 'configure'), `#!${process.execPath}
const fs = require('node:fs'); const path = require('node:path'); const {spawn}=require('node:child_process');
const args = process.argv.slice(2);fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(args)+'\\n');
if (${JSON.stringify(mode)} === 'fail') {console.error('compiler failed fixture');process.exit(7);}
if (${JSON.stringify(mode)} === 'slow') {spawn(process.execPath,['-e',${JSON.stringify(`setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'orphan'),700)`)}],{stdio:'inherit'});console.log('BUILD_READY');setTimeout(()=>{},60000);}
else {
 const prefix=args.find(a=>a.startsWith('--prefix=')).slice(9);
 const install='const fs=require("node:fs");const path=require("node:path");fs.mkdirSync('+JSON.stringify(path.join(prefix,'bin'))+',{recursive:true});fs.writeFileSync('+JSON.stringify(path.join(prefix,'bin/ruby'))+','+${JSON.stringify(JSON.stringify(actual))}+',{mode:0o755});';
 fs.writeFileSync('install.cjs',install);
 fs.writeFileSync('Makefile','all:\\n\\t@echo BUILD_COMPLETE\\ninstall:\\n\\t"'+process.execPath+'" install.cjs\\n');
}
`, { mode: 0o755 });
	const archive = path.join(directory, 'fixture.tar.gz'); execFileSync('tar', ['-czf', archive, '-C', directory, root]);
	const bytes = await fs.readFile(archive); const sha = createHash('sha256').update(bytes).digest('hex');
	const url = `https://cache.ruby-lang.org/pub/ruby/${version.split('.').slice(0, 2).join('.')}/${root}.tar.gz`;
	const catalog = `${root}\t${url}\tunused\t${sha}\tunused\n`;
	const requests = [];
	const request = async address => { requests.push(String(address)); return new Response(String(address).endsWith('index.txt') ? catalog : bytes); };
	const storage = path.join(directory, 'app storage'); const output = []; const controller = new AbortController();
	const installer = new RubyInstaller(storage, sdk.env, undefined, request);
	const operation = { trusted: true, signal: controller.signal, onOutput: text => output.push(text) };
	return { installer, directory, storage, version, output, requests, request, operation, controller, calls, marker, catalog, bytes, actual };
}

test('versions sort complete stable Ruby releases numerically without accepting options or paths', () => {
	assert.deepEqual(parseRubyVersions('3.3.8\n3.10.0\n10.0.0\n3.3.8 jruby-9.4.0.0 3.4.0-rc1 --help ../../3.3.8'), ['10.0.0', '3.10.0', '3.3.8']);
});

test('source catalog requires official release paths and SHA-256 checksums', () => {
	const hash = 'a'.repeat(64); const row = `ruby-3.3.8\thttps://cache.ruby-lang.org/pub/ruby/3.3/ruby-3.3.8.tar.gz\tunused\t${hash}`;
	assert.deepEqual(parseRubySourceCatalog(row), [{ version: '3.3.8', url: 'https://cache.ruby-lang.org/pub/ruby/3.3/ruby-3.3.8.tar.gz', sha256: hash, root: 'ruby-3.3.8' }]);
	for (const invalid of [row.replace('https:', 'http:'), row.replace('cache.ruby-lang.org', 'untrusted.example'), row.replace(hash, 'not-a-hash'), row.replaceAll('3.3.8', '3.3.8-preview1'), row.replaceAll('3.3.8', '../../escape')]) { assert.deepEqual(parseRubySourceCatalog(invalid), []); }
});

test('Windows catalog selects matching official portable packages with published digests', () => {
	const hash = 'b'.repeat(64); const release = { tag_name: 'RubyInstaller-3.3.8-1', assets: ['x64', 'arm', 'x86'].map(arch => ({ name: `rubyinstaller-3.3.8-1-${arch}.7z`, digest: 'sha256:' + hash, browser_download_url: `https://github.com/oneclick/rubyinstaller2/releases/download/RubyInstaller-3.3.8-1/rubyinstaller-3.3.8-1-${arch}.7z` })) };
	assert.equal(parseRubyWindowsCatalog(JSON.stringify([release]), 'x64')[0].root, 'rubyinstaller-3.3.8-1-x64');
	assert.equal(parseRubyWindowsCatalog(JSON.stringify([release]), 'arm64')[0].root, 'rubyinstaller-3.3.8-1-arm');
	for (const changes of [{ prerelease: true }, { draft: true }, { assets: release.assets.map(asset => ({ ...asset, digest: undefined })) }, { assets: release.assets.map(asset => ({ ...asset, browser_download_url: 'https://untrusted.example/archive.7z' })) }]) { assert.deepEqual(parseRubyWindowsCatalog(JSON.stringify([{ ...release, ...changes }]), 'x64'), []); }
});

test('archive extraction rejects traversal, absolute paths and unexpected roots', () => {
	validateRubyArchive('ruby-3.3.8/\nruby-3.3.8/bin/ruby\n', 'ruby-3.3.8');
	for (const listing of ['', '/etc/passwd', 'C:\\Windows\\file', 'ruby-3.3.8/../../escape', 'other/bin/ruby', 'ruby-3.3.8/dir\x00file']) { assert.throws(() => validateRubyArchive(listing, 'ruby-3.3.8'), /unexpected paths/); }
});

test('untrusted or malformed requests cannot download or create storage', native, async t => {
	const f = await fixture(t);
	await assert.rejects(f.installer.versions({ ...f.operation, trusted: false }), /Trust/);
	for (const version of ['--help', '../../escape', '3.3.8;touch marker', 'latest', '3.3']) { await assert.rejects(f.installer.install(version, f.operation), /complete stable/); }
	assert.deepEqual(f.requests, []); await assert.rejects(fs.access(f.storage), { code: 'ENOENT' });
});

test('verified source builds preserve argument boundaries, validate real Ruby and reuse existing SDKs', native, async t => {
	const f = await fixture(t); assert.deepEqual(await f.installer.versions(f.operation), [f.version]);
	const sdk = await f.installer.install(f.version, f.operation); assert.equal(sdk.ruby, path.join(f.storage, 'rubies', f.version, 'bin/ruby'));
	await f.installer.install(f.version, f.operation);
	const calls = (await fs.readFile(f.calls, 'utf8')).trim().split('\n').map(JSON.parse);
	assert.equal(calls.length, 1); assert.equal(calls[0][0], '--prefix=' + path.join(f.storage, 'rubies', f.version));
	assert.ok(f.output.join('').includes('checksum verified'));
	const receipt = JSON.parse(await fs.readFile(path.join(f.storage, 'rubies', f.version, '.ruby-studio-sdk.json'), 'utf8')); assert.equal(receipt.version, f.version);
});

test('checksum corruption cannot run configure or leave a partial SDK', native, async t => {
	const f = await fixture(t); const installer = new RubyInstaller(f.storage, process.env, undefined, async url => new Response(String(url).endsWith('index.txt') ? f.catalog : Buffer.concat([f.bytes, Buffer.from('corrupt')])));
	await assert.rejects(installer.install(f.version, f.operation), /checksum verification failed/);
	await assert.rejects(fs.access(f.calls), { code: 'ENOENT' }); assert.deepEqual(await fs.readdir(path.join(f.storage, 'rubies')), []);
});

test('failed builds remove only their own partial SDK and release locks for retry', native, async t => {
	const f = await fixture(t, 'fail'); const other = path.join(f.storage, 'rubies', 'other-sdk'); await fs.mkdir(other, { recursive: true }); await fs.writeFile(path.join(other, 'keep'), 'keep');
	for (let attempt = 0; attempt < 2; attempt++) { await assert.rejects(f.installer.install(f.version, f.operation), /compiler failed fixture/); }
	assert.deepEqual(await fs.readdir(path.join(f.storage, 'rubies')), ['other-sdk']);
});

test('cancellation stops build descendants and releases locks before removing partial output', native, async t => {
	const f = await fixture(t, 'slow'); let ready; const started = new Promise(resolve => { ready = resolve; });
	const pending = f.installer.install(f.version, { ...f.operation, onOutput: text => { if (text.includes('BUILD_READY')) { ready(); } } });
	await started; await assert.rejects(f.installer.install(f.version, f.operation), /another window/); f.controller.abort();
	await assert.rejects(pending, /cancelled/); await new Promise(resolve => setTimeout(resolve, 900));
	await assert.rejects(fs.access(f.marker), { code: 'ENOENT' }); assert.deepEqual(await fs.readdir(path.join(f.storage, 'rubies')), []);
});

test('download cancellation aborts the request and cleans partial files', native, async t => {
	const f = await fixture(t); let ready; const started = new Promise(resolve => { ready = resolve; });
	const installer = new RubyInstaller(f.storage, process.env, undefined, async (url, options) => {
		if (String(url).endsWith('index.txt')) { return new Response(f.catalog); }
		ready(); return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new Error('download aborted')), { once: true }));
	});
	const pending = installer.install(f.version, f.operation); await started; f.controller.abort(); await assert.rejects(pending, /cancelled/);
	assert.deepEqual(await fs.readdir(path.join(f.storage, 'rubies')), []);
});

test('unavailable versions and invalid existing SDKs are preserved without downloads', native, async t => {
	const f = await fixture(t); await assert.rejects(f.installer.install('999.0.0', f.operation), /unavailable/);
	const destination = path.join(f.storage, 'rubies', f.version); await fs.mkdir(destination, { recursive: true }); await fs.writeFile(path.join(destination, 'keep'), 'user files');
	await assert.rejects(f.installer.install(f.version, f.operation), /not found/); assert.equal(await fs.readFile(path.join(destination, 'keep'), 'utf8'), 'user files');
	assert.equal(f.requests.length, 1);
});

test('an interrupted app-owned SDK and dead owner lock can be recovered', native, async t => {
	const f = await fixture(t); const destination = path.join(f.storage, 'rubies', f.version);
	await fs.mkdir(destination, { recursive: true });
	await fs.writeFile(destination + '.installing', '2147483647');
	await fs.writeFile(path.join(destination, '.ruby-studio-installing.json'), JSON.stringify({ version: f.version, pid: 2147483647 }));
	await fs.writeFile(path.join(destination, 'partial'), 'interrupted');
	const sdk = await f.installer.install(f.version, f.operation); assert.ok(sdk.version.startsWith('ruby ' + f.version));
	await assert.rejects(fs.access(path.join(destination, 'partial')), { code: 'ENOENT' });
	assert.deepEqual(await fs.readdir(path.join(f.storage, 'rubies')), [f.version]);
});

test('a different Ruby version in an existing SDK is rejected without overwriting it', native, async t => {
	const f = await fixture(t); const parts = f.version.split('.').map(Number); parts[2]++; const requested = parts.join('.');
	const destination = path.join(f.storage, 'rubies', requested); await fs.mkdir(path.join(destination, 'bin'), { recursive: true });
	await fs.writeFile(path.join(destination, 'bin/ruby'), f.actual, { mode: 0o755 });
	const installer = new RubyInstaller(f.storage, process.env, undefined, async () => new Response(f.catalog.replaceAll(f.version, requested)));
	await assert.rejects(installer.install(requested, f.operation), /does not report/);
	assert.equal(await fs.readFile(path.join(destination, 'bin/ruby'), 'utf8'), f.actual);
});

// One real Windows SDK installation catches extraction, layout and DLL compatibility
// that a synthetic fixture cannot establish. Enabled in native CI.
test('official Windows portable SDK extracts and validates its core libraries', { skip: process.platform !== 'win32' || process.env.RUBY_STUDIO_TEST_SDK_INSTALL !== '1', timeout: 180000 }, async t => {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ruby-studio-sdk-real-')); t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const request = (url, options = {}) => fetch(url, { ...options, headers: { ...options.headers, ...(String(url).startsWith('https://api.github.com/') && process.env.SDK_INSTALL_GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.SDK_INSTALL_GITHUB_TOKEN}` } : {}) } });
	const installer = new RubyInstaller(directory, process.env, undefined, request);
	const operation = { trusted: true, signal: AbortSignal.timeout(150000), onOutput: () => {} };
	const versions = await installer.versions(operation); assert.ok(versions.includes('3.3.12'));
	const sdk = await installer.install('3.3.12', operation); assert.ok(sdk.version.startsWith('ruby 3.3.12'));
	const result = execFileSync(sdk.ruby, ['-ropenssl', '-rjson', '-e', 'puts JSON.generate(version: RUBY_VERSION, ssl: OpenSSL::OPENSSL_VERSION)'], { env: sdk.env, encoding: 'utf8' });
	assert.equal(JSON.parse(result).version, '3.3.12');
});
