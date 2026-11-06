import { defineConfig } from "oxlint";

export default defineConfig({
  plugins: ["typescript", "import", "unicorn", "oxc", "promise", "vitest"],
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
    "unicorn/prefer-node-protocol": "error",
    "no-await-in-loop": "off",
    "oxc/no-map-spread": "off",
    eqeqeq: "error",
  },
  ignorePatterns: ["dist/**", "node_modules/**", "bench/out/**"],
});
