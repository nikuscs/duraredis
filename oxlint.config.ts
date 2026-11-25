import cloudflare from "@cloudflare/oxlint-config";
import { defineConfig } from "oxlint";

export default defineConfig({
  extends: [cloudflare],
  env: cloudflare.env,
  rules: {
    "@nkzw/no-instanceof": "off",
    "curly": "off",
  },
  overrides: [
    { files: ["test/**"], rules: { "typescript/await-thenable": "off" } },
    { files: ["cloudflare.config.ts"], rules: { "import/no-namespace": "off" } },
  ],
  ignorePatterns: [...cloudflare.ignorePatterns, ".cloudflare/**", ".wrangler/**", "vendor/**"],
});
