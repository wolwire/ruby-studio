/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { detectProject, ProjectCoordinator, requestedVersionMatches } = require('../out/projectModel');
const { validateProject, createProjectDirectory } = require('../out/projectCreation');
const { resolveRuntime } = require('../out/runtime');
const { resolveDependencies } = require('../out/dependencyResolver');
const { RubyIndex } = require('../out/languageModel');
const extensionPath = path.resolve(__dirname, '..');
async function fixture(t) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'ruby-project-')); t.after(() => fs.rm(root, { recursive: true, force: true })); return root; }
const sdk = root => ({ ruby: '/fixture/ruby', cwd: root, env: {}, version: 'ruby 3.3.8', manager: 'selected' });
const noDependencies = async () => ({ bundle: 'none', dependencies: [], issues: [] });

test('detect Rails, requested version/gemset and test roots without booting Ruby', async t => {
	const root = await fixture(t); await fs.mkdir(path.join(root, 'bin')); await fs.writeFile(path.join(root, 'bin/rails'), 'raise "Do not execute"'); await fs.writeFile(path.join(root, '.ruby-version'), 'ruby-3.3.8@invoices\n'); await fs.writeFile(path.join(root, 'Gemfile'), 'raise "Do not evaluate"');
	const facts = await detectProject(root);
	assert.deepEqual({ kind: facts.kind, version: facts.requestedRuby.version, gemset: facts.requestedRuby.gemset, bundled: facts.bundled, roots: facts.testRoots.map(item => path.basename(item)) }, { kind: 'rails', version: '3.3.8', gemset: 'invoices', bundled: true, roots: ['features', 'spec', 'test'] });
});
test('external configuration replacement changes the project fingerprint', async t => {
	const root = await fixture(t); await fs.writeFile(path.join(root, '.ruby-version'), '3.3.8'); const before = await detectProject(root); await fs.writeFile(path.join(root, '.ruby-version'), '3.4.0'); assert.notEqual((await detectProject(root)).fingerprint, before.fingerprint);
});
test('untrusted initialization never invokes the runtime or dependency resolver', async t => {
	const root = await fixture(t); let calls = 0;
	const coordinator = new ProjectCoordinator({ trusted: () => false, runtime: async () => { calls++; return sdk(root); }, dependencies: async () => { calls++; return noDependencies(); } }, () => {}); t.after(() => coordinator.dispose()); await coordinator.refresh(root);
	assert.deepEqual({ calls, sdk: coordinator.states.get(root).sdk }, { calls: 0, sdk: 'restricted' });
});
test('new generation aborts a slow probe and preserves two independent roots', async t => {
	const first = await fixture(t); const second = await fixture(t); let release; let entered; let calls = 0; let oldSignal;
	const started = new Promise(resolve => entered = resolve);
	const coordinator = new ProjectCoordinator({ trusted: () => true, runtime: async (root, signal) => { if (root === first && ++calls === 1) { oldSignal = signal; entered(); await new Promise(resolve => release = resolve); return { ...sdk(root), version: 'ruby 0.0.1' }; } return sdk(root); }, dependencies: noDependencies }, () => {}); t.after(() => coordinator.dispose());
	const pending = coordinator.refresh(first); await started; await coordinator.refresh(first); await coordinator.refresh(second); release(); await pending;
	assert.deepEqual({ aborted: oldSignal.aborted, versions: [...coordinator.states.values()].map(state => state.runtime.version) }, { aborted: true, versions: ['ruby 3.3.8', 'ruby 3.3.8'] });
});
test('missing and mismatched SDKs remain actionable without hiding project facts', async t => {
	const root = await fixture(t); await fs.writeFile(path.join(root, '.ruby-version'), '3.4.0'); let missing = false;
	const coordinator = new ProjectCoordinator({ trusted: () => true, runtime: async () => { if (missing) { throw new Error('SDK missing'); } return sdk(root); }, dependencies: noDependencies }, () => {}); t.after(() => coordinator.dispose()); await coordinator.refresh(root); const mismatch = coordinator.states.get(root).sdk; missing = true; await coordinator.refresh(root);
	assert.deepEqual({ mismatch, missing: coordinator.states.get(root).sdk, facts: coordinator.states.get(root).facts.requestedRuby.version, aliases: requestedVersionMatches('system', 'ruby 3.3.8') }, { mismatch: 'mismatch', missing: 'missing', facts: '3.4.0', aliases: undefined });
});
test('empty project creation generates no source, dependencies or test directories', async t => {
	const parent = await fixture(t); const draft = { parent, name: 'Invoice Tools-1', interpreter: '/fixture/ruby' }; const result = await createProjectDirectory(draft);
	assert.deepEqual({ entries: await fs.readdir(result.destination), created: result.created, openExisting: result.openExisting }, { entries: [], created: true, openExisting: false });
});
test('destination decisions preserve existing files and reject path escape', async t => {
	const parent = await fixture(t); const draft = { parent, name: 'Existing', interpreter: '/fixture/ruby' }; const destination = path.join(parent, draft.name); await fs.mkdir(destination); await fs.writeFile(path.join(destination, 'sentinel.rb'), 'unchanged');
	await assert.rejects(createProjectDirectory(draft), /not empty/); await createProjectDirectory(draft, 'open'); await createProjectDirectory(draft, 'create');
	assert.deepEqual({ content: await fs.readFile(path.join(destination, 'sentinel.rb'), 'utf8'), escaped: !!(await validateProject({ ...draft, name: '../escape' })).error, sdk: !!(await validateProject({ ...draft, interpreter: '' })).error }, { content: 'unchanged', escaped: true, sdk: true });
});
test('Rails destination can be opened but is not turned into an empty project', async t => {
	const parent = await fixture(t); const draft = { parent, name: 'Rails', interpreter: '/fixture/ruby' }; await fs.mkdir(path.join(parent, 'Rails/bin'), { recursive: true }); await fs.writeFile(path.join(parent, 'Rails/bin/rails'), '');
	await assert.rejects(createProjectDirectory(draft, 'create'), /existing Rails/); assert.equal((await createProjectDirectory(draft, 'open')).openExisting, true);
});
test('installed library declarations are isolated by environment including shared roots', () => {
	const index = new RubyIndex(); index.update('file:///a/main.rb', 'LibraryA\nShared', 'a'); index.update('file:///b/main.rb', 'LibraryA\nShared', 'b'); index.updateLibrary('file:///gem/a.rb', 'class LibraryA\nend', ['a']); index.updateLibrary('file:///gem/shared.rb', 'class Shared\nend', ['a', 'b']);
	assert.deepEqual({ a: index.resolve('file:///a/main.rb', 2).definitions.map(item => item.uri), b: index.resolve('file:///b/main.rb', 2).definitions.map(item => item.uri), shared: index.resolve('file:///b/main.rb', 12).definitions.map(item => item.uri), sharedUsers: [...new Set(index.references(index.resolve('file:///b/main.rb', 12).definitions[0]).map(item => item.uri))].sort() }, { a: ['file:///gem/a.rb'], b: [], shared: ['file:///gem/shared.rb'], sharedUsers: ['file:///a/main.rb', 'file:///b/main.rb', 'file:///gem/shared.rb'] });
});
test('trusted Bundler probe resolves a local path gem without booting the Rails app', async t => {
	const root = await fixture(t); await fs.mkdir(path.join(root, 'dependency/lib'), { recursive: true }); await fs.mkdir(path.join(root, 'config/initializers'), { recursive: true });
	await fs.writeFile(path.join(root, 'dependency/lib/lifecycle_fixture.rb'), 'class LifecycleFixture\nend\n');
	await fs.writeFile(path.join(root, 'dependency/lifecycle_fixture.gemspec'), 'Gem::Specification.new { |s| s.name = "lifecycle_fixture"; s.version = "1.0.0"; s.summary = "Fixture"; s.authors = ["Test"]; s.files = ["lib/lifecycle_fixture.rb"] }\n');
	await fs.writeFile(path.join(root, 'Gemfile'), 'source "https://rubygems.org"\ngem "lifecycle_fixture", path: "dependency"\n');
	await fs.writeFile(path.join(root, 'Gemfile.lock'), 'PATH\n  remote: dependency\n  specs:\n    lifecycle_fixture (1.0.0)\n\nGEM\n  remote: https://rubygems.org/\n  specs:\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  lifecycle_fixture!\n');
	await fs.writeFile(path.join(root, 'config/initializers/marker.rb'), `File.write(${JSON.stringify(path.join(root, 'booted'))}, 'unsafe')`);
	const runtime = await resolveRuntime({ cwd: root, configuredPath: process.env.RUBY_STUDIO_RUBY || 'ruby', trusted: true });
	const result = await resolveDependencies(runtime, await detectProject(root), extensionPath, new AbortController().signal); const gem = result.dependencies.find(item => item.name === 'lifecycle_fixture');
	assert.deepEqual({ bundle: result.bundle, source: gem?.source, root: gem?.requireRoots[0] }, { bundle: 'ready', source: 'path', root: path.join(root, 'dependency/lib') }); await assert.rejects(fs.access(path.join(root, 'booted')), { code: 'ENOENT' });
});

async function bundleFixture(t, manifest = 'Gemfile') {
	const root = await fixture(t); const external = await fixture(t);
	await fs.mkdir(path.join(external, 'dependency/lib'), { recursive: true });
	await fs.writeFile(path.join(external, 'dependency/lifecycle_fixture.gemspec'), 'Gem::Specification.new { |s| s.name = "lifecycle_fixture"; s.version = "1.0.0"; s.summary = "Fixture"; s.authors = ["Test"]; s.files = [] }\n');
	const gemfile = path.join(external, manifest); const lockfile = manifest === 'gems.rb' ? path.join(external, 'gems.locked') : gemfile + '.lock';
	await fs.writeFile(gemfile, 'gem "lifecycle_fixture", path: "dependency"\n');
	const lock = 'PATH\n  remote: dependency\n  specs:\n    lifecycle_fixture (1.0.0)\n\nGEM\n  specs:\n\nPLATFORMS\n  ruby\n\nDEPENDENCIES\n  lifecycle_fixture!\n';
	await fs.writeFile(lockfile, lock);
	const runtime = await resolveRuntime({ cwd: root, configuredPath: process.env.RUBY_STUDIO_RUBY || 'ruby', trusted: true });
	const probe = async env => resolveDependencies({ ...runtime, env: { ...runtime.env, BUNDLE_GEMFILE: gemfile, BUNDLE_USER_CONFIG: path.join(external, 'user/config'), ...env } }, await detectProject(root), extensionPath, new AbortController().signal);
	return { root, external, gemfile, lockfile, lock, runtime, probe };
}
test('custom Gemfile from the selected runtime ignores an unrelated workspace lockfile', async t => {
	const f = await bundleFixture(t, 'Custom Gemfile');
	await fs.writeFile(path.join(f.root, 'Gemfile.lock'), 'BUNDLED WITH\n   99.99.99\n');
	const result = await f.probe();
	assert.deepEqual({ bundle: result.bundle, path: result.dependencies.find(item => item.name === 'lifecycle_fixture')?.requireRoots[0], manifests: result.configurationFiles.filter(file => file === f.gemfile || file === f.lockfile) }, { bundle: 'ready', path: path.join(f.external, 'dependency/lib'), manifests: [f.gemfile, f.lockfile] });
});
test('missing selected Bundler reports recovery paths without disclosing configuration values', async t => {
	const f = await bundleFixture(t); await fs.writeFile(f.lockfile, f.lock + '\nBUNDLED WITH\n   99.99.99\n');
	const result = await f.probe({ BUNDLE_APP_CONFIG: path.join(f.external, 'local'), BUNDLE_RUBYGEMS__ORG: 'private-token-for-test' });
	assert.deepEqual({ bundle: result.bundle, files: result.configurationFiles, disclosed: JSON.stringify(result).includes('private-token-for-test') }, { bundle: 'missing-bundler', files: [f.gemfile, f.lockfile, path.join(f.external, 'local/config'), path.join(f.external, 'user/config')], disclosed: false });
});
test('explicit BUNDLER_VERSION takes precedence over a different locked version', async t => {
	const f = await bundleFixture(t);
	const { execFile } = require('node:child_process'); const { promisify } = require('node:util');
	const { stdout } = await promisify(execFile)(f.runtime.ruby, ['-rbundler', '-e', 'print Bundler::VERSION'], { cwd: f.root, env: f.runtime.env });
	await fs.writeFile(f.lockfile, f.lock + '\nBUNDLED WITH\n   99.99.99\n');
	assert.equal((await f.probe({ BUNDLER_VERSION: stdout.trim() })).bundle, 'ready');
});
test('gems.rb selects gems.locked and appears in static project facts', async t => {
	const f = await bundleFixture(t, 'gems.rb');
	await fs.writeFile(path.join(f.external, 'Gemfile'), 'raise "gems.rb must take precedence"');
	const facts = await detectProject(f.external); const result = await f.probe({ BUNDLE_GEMFILE: '' });
	const selected = await resolveDependencies({ ...f.runtime, cwd: f.external, env: { ...f.runtime.env, BUNDLE_GEMFILE: '' } }, facts, extensionPath, new AbortController().signal);
	assert.deepEqual({ kind: facts.kind, bundled: facts.bundled, selected: selected.bundle, files: selected.configurationFiles.slice(0, 2), unset: result.bundle }, { kind: 'ruby', bundled: true, selected: 'ready', files: [f.gemfile, f.lockfile], unset: 'none' });
});
test('nested project inherits the nearest parent Gemfile when no local manifest exists', async t => {
	const f = await bundleFixture(t); const child = path.join(f.external, 'nested'); await fs.mkdir(child);
	const result = await resolveDependencies({ ...f.runtime, env: { ...f.runtime.env, BUNDLE_GEMFILE: '' } }, await detectProject(child), extensionPath, new AbortController().signal);
	assert.deepEqual({ bundle: result.bundle, manifest: result.configurationFiles[0] }, { bundle: 'ready', manifest: f.gemfile });
});
test('gems.locked participates in the static configuration fingerprint', async t => {
	const root = await fixture(t); await fs.writeFile(path.join(root, 'gems.rb'), ''); await fs.writeFile(path.join(root, 'gems.locked'), 'old');
	const before = await detectProject(root); await fs.writeFile(path.join(root, 'gems.locked'), 'new');
	assert.notEqual((await detectProject(root)).fingerprint, before.fingerprint);
});
