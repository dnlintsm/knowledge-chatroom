import js from "@eslint/js";
import tseslint from "typescript-eslint";
import reactHooks from "eslint-plugin-react-hooks";
import globals from "globals";

export default tseslint.config(
  {
    ignores: ["**/node_modules/**", ".next/**", "next-env.d.ts", "preview/**", "test-results*/**", "playwright-report/**", "coverage/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.browser, ...globals.node } },
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" }],
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    // The starter's dynamic A2UI renderer accepts an SDK-defined property bag.
    // Keep this exception local; workspace and backend code must use typed values.
    files: ["src/app/declarative-generative-ui/renderers.tsx"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
);
