import js from "@eslint/js";
import tseslint from "typescript-eslint";
import globals from "globals";

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      ".wrangler/**",
      ".omc/**",
      ".framework-baseline/**",
      // wrangler types 生成檔（內含範例 hex 常數與自帶 eslint-disable）
      "worker-configuration.d.ts",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: { ...globals.node, ...globals.worker },
    },
    rules: {
      // 01-CLAUDE §4/§5：型別安全——as any 預算 0（guard 亦鎖），例外走 eslint-disable 註明理由
      "@typescript-eslint/no-explicit-any": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
);
