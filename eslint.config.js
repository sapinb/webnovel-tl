// /home/sapinb/Code/novels/aio/eslint.config.js
const globals = require('globals');
const tseslint = require('typescript-eslint');
const eslintPluginPrettierRecommended = require('eslint-plugin-prettier/recommended');
const js = require('@eslint/js');

module.exports = [
  // 1. Global ignores (combines .eslintignore and old ignorePatterns)
  {
    ignores: [
      'node_modules/',
      'dist/',
      'coverage/',
      '*.log',
      '.eslintrc.js',     // Old file, ensure it's deleted
      'eslint.config.js', // This ESLint config file itself
      'jest.config.js',   // Jest config file
      // any other patterns from your old .eslintignore
    ],
  },

  // 2. ESLint's recommended JavaScript rules (applies to all files not ignored)
  js.configs.recommended,

  // 3. TypeScript specific configurations
  // Use tseslint.config to compose TypeScript specific parts.
  // recommendedTypeChecked is an array, so spread its contents.
  ...tseslint.config({
    files: ['**/*.ts'], // Apply to all TypeScript files
    extends: [
      ...tseslint.configs.recommendedTypeChecked, // For type-aware linting rules
      // You could also use/add:
      // ...tseslint.configs.strictTypeChecked,
      // ...tseslint.configs.stylisticTypeChecked,
    ],
    languageOptions: {
      parserOptions: {
        project: true, // Automatically find tsconfig.json
        tsconfigRootDir: __dirname, // Assumes eslint.config.js is at project root
        ecmaVersion: 2020, // From your old parserOptions
        sourceType: 'module', // From your old parserOptions
      },
      globals: { // Globals for all TS files (mostly Node environment)
        ...globals.node,
      },
    },
    rules: {
      // Override the default 'no-unused-vars' rule from recommendedTypeChecked
      // to allow unused variables, arguments, and caught errors prefixed with an underscore.
      '@typescript-eslint/no-unused-vars': [
        'error', // or 'warn' if you prefer
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
      // Add any custom rules from your old .eslintrc.js here
    },
  }),

  // 4. Jest specific globals for test files
  {
    files: [
      'tests/**/*.ts', // Common test file patterns
      'src/**/*.test.ts',
      'src/**/*.spec.ts',
      '**/__tests__/**/*.ts', // From your jest.config.js
    ],
    languageOptions: {
      globals: {
        ...globals.jest,
      },
    },
    // If you use eslint-plugin-jest, configure it here:
    // plugins: { jest: require('eslint-plugin-jest') },
    // rules: { ...require('eslint-plugin-jest').configs.recommended.rules },
  },

  // 5. Prettier configuration (must be the last one in the array to override styling rules)
  // eslintPluginPrettierRecommended is a pre-configured object that includes
  // eslint-config-prettier (to turn off conflicting ESLint rules) and
  // eslint-plugin-prettier (to run Prettier as an ESLint rule).
  eslintPluginPrettierRecommended,
];
