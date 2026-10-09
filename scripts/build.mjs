// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { build } from 'esbuild';
import { build as buildWeb } from 'vite';
import { mkdir } from 'node:fs/promises';
import { loadConfig } from './config.mjs';
loadConfig({optional:true});
await buildWeb();
await mkdir('dist/lambda',{recursive:true});
await build({entryPoints:['server/lambda.mjs'],bundle:true,platform:'node',target:'node22',format:'esm',outfile:'dist/lambda/index.mjs',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}});
