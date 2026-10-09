// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
export default defineConfig({ plugins: [react()], resolve: { alias: { "@": path.resolve(import.meta.dirname, ".") } }, server: { host: "127.0.0.1", port: 4202, strictPort: true, proxy: { "/api": "http://127.0.0.1:4203" } }, preview: { host: "127.0.0.1", port: 4202, strictPort: true }, build: { outDir: "dist/web", emptyOutDir: true } });
