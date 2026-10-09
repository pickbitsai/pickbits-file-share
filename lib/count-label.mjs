// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
export const countLabel = (count, singular = 'item', plural = `${singular}s`) => `${count} ${count === 1 ? singular : plural}`;
