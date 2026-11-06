import { defineConfig } from "oxfmt";

export default defineConfig({
  printWidth: 100,
  semi: true,
  singleQuote: false,
  trailingComma: "all",
  endOfLine: "lf",
  ignorePatterns: [
    "dist/**",
    "node_modules/**",
    "bench/out/**",
    "coverage/**",
    "pnpm-lock.yaml",
    ".git/**",
  ],
});
