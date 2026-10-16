/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { readApp, target } from './lib/ruby-studio-platform.mjs';

// Ad-hoc signatures repair the rebranded bundle's seals. They do not establish
// a Developer ID identity or notarization, and do not bypass Gatekeeper.
const [mode, directory] = process.argv.slice(2);
try {
	const host = target();
	if (host.platform !== 'darwin' || !['sign', 'verify'].includes(mode) || !directory) { throw new Error('Run on macOS: node scripts/sign-ruby-studio-macos.mjs sign|verify APP'); }
	const layout = readApp(path.resolve(directory));
	const worker = path.join(layout.resources, 'extensions/ruby-studio/native/bin', host.id, host.worker);
	const codesign = args => execFileSync('/usr/bin/codesign', args, { stdio: 'inherit' });
	if (mode === 'sign') {
		const { sign } = await import('../build/node_modules/@electron/osx-sign/dist/index.js');
		await sign({
			app: layout.bundle, platform: 'darwin', identity: '-', identityValidation: false,
			preAutoEntitlements: false, preEmbedProvisioningProfile: false,
			// Sign the worker before bundling so its provenance hash stays identical
			// to the worker tested directly. The parent seal covers it as a resource.
			ignore: file => path.resolve(file) === worker,
			optionsForFile: () => ({ hardenedRuntime: false, timestamp: 'none' })
		});
	}
	codesign(['--verify', '--deep', '--strict', '--verbose=2', layout.bundle]);
	codesign(['--verify', '--strict', '--verbose=2', worker]);
	for (const executable of [layout.executable, worker]) {
		execFileSync('/usr/bin/lipo', [executable, '-verify_arch', host.arch === 'arm64' ? 'arm64' : 'x86_64'], { stdio: 'inherit' });
	}
	console.log(`Verified ad-hoc macOS bundle and ${host.arch} native worker: ${layout.bundle}`);
} catch (error) { console.error(error); process.exitCode = 1; }
