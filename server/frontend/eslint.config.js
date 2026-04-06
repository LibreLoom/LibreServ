import js from "@eslint/js";
import globals from "globals";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import { defineConfig, globalIgnores } from "eslint/config";

export default defineConfig([
  // Skip linting build output to keep runs fast.
  globalIgnores(["dist"]),
  {
    files: ["**/*.{js,jsx}"],
    // Base + React rules for the app bundle.
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: "latest",
        ecmaFeatures: { jsx: true },
        sourceType: "module",
      },
    },
    rules: {
      // Allow _unused patterns for deliberate unused values.
      "no-unused-vars": [
        "error",
        { argsIgnorePattern: "^[A-Z_]", varsIgnorePattern: "^[A-Z_]" },
      ],
      // refs are intentionally accessed during render for the useAnimatedHeight hook pattern
      "react-hooks/refs": "off",
    },
  },
  {
    // Test files get vitest globals.
    files: ["**/*.test.{js,jsx}", "src/test/**"],
    languageOptions: {
      globals: {
        ...globals.browser,
        vi: "readonly",
        describe: "readonly",
        it: "readonly",
        expect: "readonly",
        beforeEach: "readonly",
        afterEach: "readonly",
        beforeAll: "readonly",
        afterAll: "readonly",
      },
    },
  },
  {
    // Script utilities run in Node, not the browser.
    files: ["scripts/**/*.js"],
    languageOptions: {
      globals: globals.node,
    },
  },
]);
