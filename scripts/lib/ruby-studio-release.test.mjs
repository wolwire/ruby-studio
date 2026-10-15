/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { platforms, sha256, validateBuildRun, prepareRelease } from './ruby-studio-release.mjs';

const repository = 'owner/ruby-studio';
const run = { id: 42, status: 'completed', conclusion: 'success', head_sha: 'a'.repeat(40), head_repository: { full_name: repository }, event: 'push', html_url: 'https://github.com/owner/ruby-studio/actions/runs/42' };
const workflow = { path: '.github/workflows/ruby-studio-build.yml' };
const artifacts = platforms.map((platform, id) => ({ id, name: `ruby-studio-${platform}-${run.head_sha}`, expired: false }));

test('release gate requires a successful trusted four-platform build', () => {
	assert.deepEqual(validateBuildRun(run, workflow, artifacts, repository).map(artifact => artifact.platform), platforms);
	for (const changes of [{ conclusion: 'failure' }, { status: 'in_progress' }, { event: 'pull_request' }, { head_repository: { full_name: 'fork/ruby-studio' } }]) { assert.throws(() => validateBuildRun({ ...run, ...changes }, workflow, artifacts, repository)); }
	assert.throws(() => validateBuildRun(run, { path: '.github/workflows/other.yml' }, artifacts, repository));
	assert.throws(() => validateBuildRun(run, workflow, artifacts.slice(1), repository));
	assert.throws(() => validateBuildRun(run, workflow, artifacts.map(artifact => ({ ...artifact, expired: true })), repository));
});

async function fixture(t) {
	const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ruby-studio-release-test-'));
	t.after(() => fs.rm(directory, { recursive: true, force: true }));
	const downloads = path.join(directory, 'downloads');
	for (const platform of platforms) {
		const folder = path.join(downloads, platform); await fs.mkdir(folder, { recursive: true });
		const base = `ruby-studio-${platform}-1.123.0-${run.head_sha.slice(0, 12)}`;
		const archive = `${base}${platform === 'linux-x64' ? '.tar.gz' : '.zip'}`;
		const info = `${base}.build-info.json`;
		await fs.writeFile(path.join(folder, archive), `Fixture distribution for ${platform}`);
		await fs.writeFile(path.join(folder, info), JSON.stringify({ version: '1.123.0', platform, sourceCommit: run.head_sha, workingTreeDirty: false, nativeWorkerSha256: 'b'.repeat(64) }));
		await checksums(folder);
	}
	return { downloads, destination: path.join(directory, 'release') };
}
async function checksums(directory) {
	const names = (await fs.readdir(directory)).filter(name => name !== 'SHA256SUMS');
	await fs.writeFile(path.join(directory, 'SHA256SUMS'), (await Promise.all(names.map(async name => `${await sha256(path.join(directory, name))}  ${name}\n`))).join(''));
}

test('verified platform packages produce ten unique release assets with one combined checksum manifest', async t => {
	const { downloads, destination } = await fixture(t);
	const manifest = await prepareRelease(downloads, destination, run, repository, 'v0.1.0');
	const names = await fs.readdir(destination);
	assert.deepEqual({ source: manifest.sourceCommit, platforms: manifest.platforms, distributions: manifest.files.length, assets: names.length }, { source: run.head_sha, platforms, distributions: 8, assets: 10 });
	for (const line of (await fs.readFile(path.join(destination, 'SHA256SUMS'), 'utf8')).trim().split('\n')) {
		const [hash, name] = line.split('  '); assert.equal(await sha256(path.join(destination, name)), hash);
	}
});

test('corrupted downloaded archives cannot become release assets', async t => {
	const { downloads, destination } = await fixture(t);
	const folder = path.join(downloads, platforms[0]);
	const archive = (await fs.readdir(folder)).find(name => name.endsWith('.tar.gz'));
	await fs.appendFile(path.join(folder, archive), 'corruption');
	await assert.rejects(prepareRelease(downloads, destination, run, repository, 'v0.1.0'), /Checksum mismatch/);
});

test('valid checksums do not permit dirty or mismatched build provenance', async t => {
	const { downloads, destination } = await fixture(t);
	const folder = path.join(downloads, platforms[0]);
	const infoFile = path.join(folder, (await fs.readdir(folder)).find(name => name.endsWith('.json')));
	const info = JSON.parse(await fs.readFile(infoFile, 'utf8'));
	for (const changes of [{ workingTreeDirty: true }, { sourceCommit: 'c'.repeat(40) }, { platform: 'win32-x64' }]) {
		await fs.writeFile(infoFile, JSON.stringify({ ...info, ...changes })); await checksums(folder);
		await assert.rejects(prepareRelease(downloads, destination, run, repository, 'v0.1.0'), /provenance/);
	}
});

test('duplicate checksum entries and unexpected files are rejected', async t => {
	const { downloads, destination } = await fixture(t);
	const folder = path.join(downloads, platforms[0]);
	const sums = path.join(folder, 'SHA256SUMS');
	const first = (await fs.readFile(sums, 'utf8')).split('\n')[0];
	await fs.writeFile(sums, `${first}\n${first}\n`);
	await assert.rejects(prepareRelease(downloads, destination, run, repository, 'v0.1.0'), /Incomplete checksum/);
	await fs.writeFile(path.join(folder, 'unexpected.exe'), '');
	await assert.rejects(prepareRelease(downloads, destination, run, repository, 'v0.1.0'), /Unexpected distribution/);
});
