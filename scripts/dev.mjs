// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import http from 'node:http';
import { createServer } from 'vite';
import { createApi } from '../server/api.mjs';
import { nodeHandler } from '../server/http.mjs';
import { loadConfig } from './config.mjs';
import { configEnvironment } from '../lib/config.mjs';
const config=loadConfig({optional:true});
const env={...process.env,...(config?configEnvironment(config):{}),APP_ORIGIN:'http://127.0.0.1:4202',...(config?{AWS_REGION:config.region}:{})};
const api=createApi({env});
const server=http.createServer(nodeHandler(api,{origin:env.APP_ORIGIN}));
const vite=await createServer();
try {
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(4203,'127.0.0.1',resolve);});
  await vite.listen();vite.printUrls();
} catch(error) {server.close();await vite.close();throw error;}
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{server.close();server.closeAllConnections();await vite.close();});
