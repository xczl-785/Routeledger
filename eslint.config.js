const js = require("@eslint/js");
const globals = require("globals");
const tsPlugin = require("@typescript-eslint/eslint-plugin");
const tsParser = require("@typescript-eslint/parser");

module.exports = [
  {
    ignores: ["node_modules", "**/dist/**", "coverage", "packages/*/tsconfig.tsbuildinfo"]
  },
  {
    files: ["eslint.config.js"],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        ...globals.node
      }
    }
  },
  js.configs.recommended,
  {
    files: ["packages/**/*.ts", "packages/**/*.tsx"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: ["./packages/*/tsconfig.json"],
        tsconfigRootDir: __dirname
      },
      globals: {
        ...globals.node
      }
    },
    plugins: {
      "@typescript-eslint": tsPlugin
    },
    rules: {
      "no-undef": "off",
      "no-unused-vars": "off",
      "@typescript-eslint/no-unused-vars": "error",
      "@typescript-eslint/consistent-type-imports": "error"
    }
  },
  {
    files: ["vitest.config.ts", "packages/*/vite.config.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        tsconfigRootDir: __dirname
      },
      globals: {
        ...globals.node
      }
    },
    rules: {
      "no-undef": "off"
    }
  },
  {
    files: ["prototypes/**/*.{js,mjs}"],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.browser
      }
    }
  }
];
