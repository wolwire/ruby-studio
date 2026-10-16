/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validateBuildRun, prepareRelease, sha256 } from './lib/ruby-studio-release.mjs';

async function main() {
	const options = {};
	const args = process.argv.slice(2);
	if (args.includes('--help')) { console.log('Usage: node scripts/publish-ruby-studio.mjs --run-id ID --tag TAG --mode verify-only|draft|prerelease|release [--repo OWNER/REPO]\nPromotes all four tested distributions from one successful Ruby Studio Desktop run.'); return; }
	for (let index = 0; index < args.length; index += 2) {
		if (!['--run-id', '--tag', '--mode', '--repo'].includes(args[index]) || !args[index + 1] || options[args[index]]) { throw new Error('Invalid or duplicate release option. Use --help.'); }
		options[args[index]] = args[index + 1];
	}
	const runId = options['--run-id'];
	const tag = options['--tag'];
	const mode = options['--mode'] || 'draft';
	const repository = options['--repo'] || process.env.GITHUB_REPOSITORY;
	if (!/^\d+$/.test(runId || '') || !tag || !/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !['verify-only', 'draft', 'prerelease', 'release'].includes(mode)) { throw new Error('Provide a numeric build run ID, a valid repository, a tag and a supported release mode.'); }
	if (tag.startsWith('-')) { throw new Error('Release tags cannot start with a dash.'); }
	execFileSync('git', ['check-ref-format', `refs/tags/${tag}`], { stdio: 'pipe' });
	const gh = (args, capture = true) => execFileSync('gh', args, { encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit', env: process.env });
	const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || gh(['auth', 'token']).trim();
	async function api(endpoint, optional = false) {
		const response = await fetch(`https://api.github.com/repos/${repository}/${endpoint}`, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' } });
		if (optional && response.status === 404) { return undefined; }
		if (!response.ok) { throw new Error(`GitHub API ${endpoint} failed (${response.status}).`); }
		return response.json();
	}
	const run = await api(`actions/runs/${runId}`);
	const workflow = await api(`actions/workflows/${run.workflow_id}`);
	const artifacts = [];
	for (let page = 1; ; page++) {
		const result = await api(`actions/runs/${runId}/artifacts?per_page=100&page=${page}`);
		artifacts.push(...result.artifacts);
		if (result.artifacts.length < 100) { break; }
	}
	const selected = validateBuildRun(run, workflow, artifacts, repository);
	if (await api(`releases/tags/${encodeURIComponent(tag)}`, true) || await api(`git/ref/tags/${encodeURIComponent(tag)}`, true)) { throw new Error(`Tag or release ${tag} already exists. This pipeline never replaces releases or retags commits.`); }
	const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'ruby-studio-release-'));
	try {
		const downloads = path.join(temporary, 'downloads');
		for (const artifact of selected) {
			console.log(`Downloading tested ${artifact.platform} distribution from run ${runId}.`);
			gh(['run', 'download', runId, '--repo', repository, '--name', artifact.name, '--dir', path.join(downloads, artifact.platform)], false);
		}
		const destination = path.join(temporary, 'release');
		const manifest = await prepareRelease(downloads, destination, run, repository, tag);
		const names = (await fs.readdir(destination)).sort();
		const notes = `Ruby Studio ${tag}\n\nNative Windows x64, Linux x64, macOS Intel x64 and Apple Silicon arm64 distributions.\n\nBuilt and tested from commit ${run.head_sha}.\nBuild evidence: ${run.html_url}\n\nVerify downloads against SHA256SUMS. Build metadata and release-manifest.json record provenance.\n\nThese are development distributions without Windows Authenticode signing or Apple Developer signing/notarization. Install Ruby and project gems separately.\n`;
		if (mode === 'verify-only') {
			console.log(JSON.stringify({ verified: true, mode, tag, sourceCommit: manifest.sourceCommit, assets: names, buildRunUrl: run.html_url }, null, 2));
			if (process.env.GITHUB_STEP_SUMMARY) { await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `Verified all four platform packages from [build ${runId}](${run.html_url}). No release or tag was created.\n`); }
			return;
		}
		const notesFile = path.join(temporary, 'notes.md'); await fs.writeFile(notesFile, notes);
		// Assemble assets in a draft first. Publishing is the final operation, so
		// a partial upload cannot become a public release.
		gh(['release', 'create', tag, ...names.map(name => path.join(destination, name)), '--repo', repository, '--target', run.head_sha, '--title', `Ruby Studio ${tag}`, '--notes-file', notesFile, '--draft', ...(mode === 'prerelease' ? ['--prerelease'] : [])], false);
		const release = JSON.parse(gh(['release', 'view', tag, '--repo', repository, '--json', 'apiUrl']));
		const uploaded = await api(`releases/${release.apiUrl.split('/').at(-1)}/assets?per_page=100`);
		if (uploaded.length !== names.length) { throw new Error('Uploaded release asset count does not match; the release remains a draft.'); }
		for (const name of names) {
			const asset = uploaded.find(asset => asset.name === name);
			const file = path.join(destination, name);
			if (!asset || asset.size !== (await fs.stat(file)).size || asset.digest && asset.digest !== `sha256:${await sha256(file)}`) { throw new Error(`Uploaded asset verification failed: ${name}; the release remains a draft.`); }
		}
		if (mode !== 'draft') { gh(['release', 'edit', tag, '--repo', repository, '--draft=false', `--prerelease=${mode === 'prerelease'}`, `--latest=${mode === 'release'}`], false); }
		const published = JSON.parse(gh(['release', 'view', tag, '--repo', repository, '--json', 'url,isDraft,isPrerelease']));
		console.log(JSON.stringify(published, null, 2));
		if (process.env.GITHUB_STEP_SUMMARY) { await fs.appendFile(process.env.GITHUB_STEP_SUMMARY, `[Ruby Studio ${tag}](${published.url}) created in **${mode}** mode with ${names.length} verified assets from [build ${runId}](${run.html_url}).\n`); }
	} finally { await fs.rm(temporary, { recursive: true, force: true }); }
}
main().catch(error => { console.error(`Ruby Studio release: ${error.message}`); process.exitCode = 1; });
