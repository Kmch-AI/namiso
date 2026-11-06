import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "import", "unicorn", "oxc", "promise", "vitest"],
  env: {
    node: true,
    es2024: true,
  },
  options: {
    typeAware: true,
    typeCheck: true,
    denyWarnings: true,
    reportUnusedDisableDirectives: "error",
  },
  categories: {
    correctness: "error",
    suspicious: "warn",
    perf: "warn",
  },
  rules: {
    "no-console": "error",
    "no-debugger": "error",
    "no-explicit-any": "error",
    "typescript/no-explicit-any": "error",
    "typescript/no-non-null-assertion": "error",
    "typescript/consistent-type-imports": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error",
    "typescript/await-thenable": "error",
    "typescript/no-unnecessary-type-assertion": "error",
    // Branded IDs, parsed payloads, and storage rows use assertions at validated boundaries.
    "typescript/no-unsafe-type-assertion": "off",
    "typescript/consistent-return": "error",
    "typescript/no-for-in-array": "error",
    "typescript/no-array-delete": "error",
    "typescript/no-duplicate-type-constituents": "error",
    "typescript/no-redundant-type-constituents": "error",
    "typescript/only-throw-error": "error",
    "typescript/prefer-promise-reject-errors": "error",
    "unicorn/prefer-node-protocol": "error",
    "no-await-in-loop": "off",
    "oxc/no-map-spread": "off",
    eqeqeq: "error",
  },
  ignorePatterns: ["dist/**", "node_modules/**", "bench/out/**", "coverage/**"],
});
