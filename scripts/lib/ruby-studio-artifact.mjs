/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const [mode, app, destination] = process.argv.slice(2);
const json = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const executable = file => { fs.accessSync(file, fs.constants.X_OK); return file; };
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
try {
	if (!['verify', 'metadata', 'record-build'].includes(mode) || !app) { throw new Error('Usage: node scripts/lib/ruby-studio-artifact.mjs verify|metadata|record-build APP [DESTINATION]'); }
	const product = json(path.join(app, 'resources/app/product.json'));
	const extensionRoot = path.join(app, 'resources/app/extensions/ruby-studio');
	const extension = json(path.join(extensionRoot, 'package.json'));
	const application = executable(path.join(app, product.applicationName));
	const entry = path.resolve(extensionRoot, extension.main);
	if (!entry.startsWith(`${extensionRoot}${path.sep}`) || !fs.statSync(entry).isFile()) { throw new Error(`Packaged extension entry point is missing: ${entry}`); }
	const worker = executable(path.join(extensionRoot, 'native/bin/linux-x64/ruby-studio-lexer'));
	const builtWorker = path.join(source, 'extensions/ruby-studio/native/bin/linux-x64/ruby-studio-lexer');
	if (fs.existsSync(builtWorker) && digest(worker) !== digest(builtWorker)) { throw new Error('Packaged native worker differs from the current built worker. Rebuild the desktop app.'); }
	if (mode === 'verify') {
		console.log(`Verified ${application}, extension ${extension.version}, executable native worker ${digest(worker)}.`);
	} else {
		if (mode === 'metadata' && !destination) { throw new Error('A metadata destination is required.'); }
		const git = args => execFileSync('git', args, { cwd: source, encoding: 'utf8' }).trim();
		const receipt = path.join(app, 'ruby-studio-build.json');
		if (mode === 'record-build' && product.commit && product.commit !== git(['rev-parse', 'HEAD'])) { throw new Error('Packaged product commit differs from this checkout. Repackage the desktop before recording provenance.'); }
		const build = { name: product.nameLong, version: json(path.join(app, 'resources/app/package.json')).version, platform: 'linux-x64', sourceCommit: git(['rev-parse', 'HEAD']), workingTreeDirty: !!git(['status', '--porcelain']), builtAt: new Date().toISOString(), node: process.version, extensionVersion: extension.version, nativeWorkerSha256: digest(worker), rootLockfileSha256: digest(path.join(source, 'package-lock.json')), buildLockfileSha256: digest(path.join(source, 'build/package-lock.json')) };
		const metadata = mode === 'record-build' ? build : { ...(fs.existsSync(receipt) ? json(receipt) : { name: product.nameLong, version: build.version, platform: build.platform, sourceCommit: null, builtAt: null, nativeWorkerSha256: digest(worker) }), packagedAt: new Date().toISOString(), packagingCheckoutCommit: git(['rev-parse', 'HEAD']), validation: 'See the accompanying build/test logs. Packaging alone does not run tests.' };
		fs.writeFileSync(mode === 'record-build' ? receipt : destination, `${JSON.stringify(metadata, null, '\t')}\n`);
	}
} catch (error) { console.error(`Ruby Studio artifact: ${error.message}`); process.exitCode = 1; }
