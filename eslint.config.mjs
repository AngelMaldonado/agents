import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

export default tseslint.config(
	{ ignores: ['**/node_modules/**', '**/dist/**', '.codegraph/**', '.release/**', '.tools/**', 'whatsapp/**'] },
	js.configs.recommended,
	...tseslint.configs.recommended,
	{
		files: ['**/*.{js,mjs,cjs,ts,tsx}'],
		languageOptions: { globals: { ...globals.browser, ...globals.node, Bun: 'readonly' } },
		rules: {
			// Existing boundary/fixture payloads use any. Runtime validation and tsc remain mandatory.
			'@typescript-eslint/no-explicit-any': 'off',
			'@typescript-eslint/no-unused-vars': [
				'error',
				{ argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none', ignoreRestSiblings: true },
			],
			'no-empty': ['error', { allowEmptyCatch: true }],
			'@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
			'no-constant-condition': ['error', { checkLoops: false }],
		},
	},
);
