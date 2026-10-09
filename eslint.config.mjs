// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Mark Pickering and PICKBITS LLC. Part of PickBits File Share.
import js from '@eslint/js';
import ts from 'typescript-eslint';
import globals from 'globals';
import hooks from 'eslint-plugin-react-hooks';
export default ts.config(
  { ignores: ['node_modules/**', 'dist/**', '.test-tmp/**', '.demo-data/**', '.tmp/**', 'infra/generated/**', 'vendor/**'] },
  js.configs.recommended,
  ...ts.configs.recommended,
  { languageOptions: { globals: { ...globals.node, ...globals.browser } }, rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true }] } },
  { files: ['**/*.mjs'], rules: { '@typescript-eslint/no-unused-vars': 'off', 'no-control-regex': 'off' } },
  { files: ['app/**/*.tsx', 'hooks/**/*.ts'], plugins: { 'react-hooks': hooks }, rules: { 'react-hooks/rules-of-hooks': 'error' } },
  { files: ['components/ui/**/*.tsx'], rules: { '@typescript-eslint/no-unused-vars': 'off' } }
);
