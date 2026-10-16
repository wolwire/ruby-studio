/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const platforms = ['linux-x64', 'win32-x64', 'darwin-x64', 'darwin-arm64'];
export async function sha256(file) {
	const hash = createHash('sha256');
	for await (const chunk of createReadStream(file)) { hash.update(chunk); }
	return hash.digest('hex');
}

export function validateBuildRun(run, workflow, artifacts, repository) {
	if (run.status !== 'completed' || run.conclusion !== 'success') { throw new Error('The selected build run must have completed successfully on all platforms.'); }
	if (run.head_repository?.full_name?.toLowerCase() !== repository.toLowerCase() || !['push', 'workflow_dispatch'].includes(run.event)) { throw new Error('Release builds must come from this repository, through push or manual dispatch; PR/fork artifacts are not accepted.'); }
	if (workflow.path !== '.github/workflows/ruby-studio-build.yml' || !/^[a-f0-9]{40}$/.test(run.head_sha)) { throw new Error('The run is not a Ruby Studio Desktop build with a valid source commit.'); }
	return platforms.map(platform => {
		const name = `ruby-studio-${platform}-${run.head_sha}`;
		const matches = artifacts.filter(artifact => artifact.name === name && !artifact.expired);
		if (matches.length !== 1) { throw new Error(`Expected one unexpired tested distribution: ${name}`); }
		return { platform, name, id: matches[0].id };
	});
}

/** Validate downloads before any release or tag is created. Never execute them. */
export async function prepareRelease(downloads, destination, run, repository, tag) {
	await fs.mkdir(destination, { recursive: true });
	const files = [];
	let version;
	for (const platform of platforms) {
		const directory = path.join(downloads, platform);
		const names = await fs.readdir(directory);
		const infos = names.filter(name => name.endsWith('.build-info.json'));
		if (infos.length !== 1 || names.length !== 3 || !names.includes('SHA256SUMS')) { throw new Error(`Unexpected distribution files for ${platform}.`); }
		const info = JSON.parse(await fs.readFile(path.join(directory, infos[0]), 'utf8'));
		if (info.platform !== platform || info.sourceCommit !== run.head_sha || info.workingTreeDirty !== false || !/^[a-f0-9]{64}$/.test(info.nativeWorkerSha256 || '') || !/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(info.version || '')) { throw new Error(`Unverified or mismatched build provenance for ${platform}.`); }
		if (version && version !== info.version) { throw new Error('Platform packages have different app versions.'); }
		version = info.version;
		const base = `ruby-studio-${platform}-${info.version}-${run.head_sha.slice(0, 12)}`;
		const expected = [`${base}${platform === 'linux-x64' ? '.tar.gz' : '.zip'}`, `${base}.build-info.json`].sort();
		if (JSON.stringify(names.filter(name => name !== 'SHA256SUMS').sort()) !== JSON.stringify(expected)) { throw new Error(`Distribution filenames do not match build provenance for ${platform}.`); }
		const sums = (await fs.readFile(path.join(directory, 'SHA256SUMS'), 'utf8')).trim().split(/\r?\n/).map(line => {
			const match = /^([a-f0-9]{64})  ([^/\\\r\n]+)$/.exec(line);
			if (!match || !expected.includes(match[2])) { throw new Error(`Invalid checksum manifest for ${platform}.`); }
			return { hash: match[1], name: match[2] };
		});
		if (sums.length !== 2 || new Set(sums.map(sum => sum.name)).size !== 2) { throw new Error(`Incomplete checksum manifest for ${platform}.`); }
		for (const sum of sums) {
			const file = path.join(directory, sum.name);
			if (!(await fs.lstat(file)).isFile() || await sha256(file) !== sum.hash) { throw new Error(`Checksum mismatch or non-regular release asset: ${sum.name}`); }
			await fs.copyFile(file, path.join(destination, sum.name));
			files.push({ name: sum.name, sha256: sum.hash, platform, size: (await fs.stat(file)).size });
		}
	}
	const manifest = { name: 'Ruby Studio', tag, version, sourceCommit: run.head_sha, buildRunId: run.id, buildRunUrl: run.html_url, repository, platforms, files, signing: 'Development distributions; no Windows Authenticode or Apple Developer signing/notarization.' };
	const manifestFile = path.join(destination, 'release-manifest.json');
	await fs.writeFile(manifestFile, JSON.stringify(manifest, null, '\t') + '\n');
	const sums = [...files.map(file => `${file.sha256}  ${file.name}`), `${await sha256(manifestFile)}  release-manifest.json`];
	await fs.writeFile(path.join(destination, 'SHA256SUMS'), sums.sort().join('\n') + '\n');
	return manifest;
}
