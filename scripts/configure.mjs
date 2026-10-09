// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { loadConfig } from './config.mjs';
const config = loadConfig();
console.log(`Configuration valid: ${config.businessName}, stack ${config.stackName}, region ${config.region}.`);
