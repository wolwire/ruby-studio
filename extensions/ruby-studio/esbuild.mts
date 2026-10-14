/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import * as path from 'node:path';
import { run } from '../esbuild-extension-common.mts';
await run({ platform: 'node', entryPoints: { extension: path.join(import.meta.dirname, 'src/extension.ts') }, srcDir: path.join(import.meta.dirname, 'src'), outdir: path.join(import.meta.dirname, 'dist') }, process.argv);
