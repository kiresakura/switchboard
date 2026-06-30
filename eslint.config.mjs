import nextConfig from "eslint-config-next";

const sharedRules = {
  "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
  "@typescript-eslint/no-explicit-any": "warn",
  "react-hooks/exhaustive-deps": "warn",
  // React 19 strict rules — data-fetching patterns need Suspense refactor
  "react-hooks/set-state-in-effect": "warn",
  "react-hooks/purity": "warn",
  "react-hooks/immutability": "warn",
  "prefer-const": "warn",
  "no-console": ["warn", { allow: ["warn", "error"] }],
};

const eslintConfig = [
  ...nextConfig,
  {
    rules: sharedRules,
  },
  {
    files: ["workers/**/*.ts"],
    rules: sharedRules,
  },
  {
    ignores: [
      "node_modules/",
      ".next/",
      "public/sw.js",
    ],
  },
];

export default eslintConfig;
