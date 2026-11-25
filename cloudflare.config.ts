import { bindings, defineConfig, defineWorker, exports, triggers } from "@cloudflare/config";
import * as entrypoint from "./src/index.ts" with { type: "cf-worker" };

const duraredis = {
  name: "duraredis",
  compatibilityDate: "2026-11-19",
  entrypoint,
  exports: {
    RedisDO: exports.durableObject({ storage: "sqlite" }),
  },
};

const worker = defineWorker(({ mode }) => {
  const test = mode === "test";
  return {
    ...duraredis,
    triggers: [triggers.connect({ protocol: "tcp", port: Number(process.env.DURAREDIS_PORT ?? (test ? 6391 : 6380)), address: "localhost" })],
    env: {
      REDIS: bindings.durableObject({ worker: duraredis, exportName: "RedisDO" }),
      CONNECT_LIMIT: bindings.rateLimit({ namespace: "1001", simple: { limit: test ? 20 : 600, period: 60 } }),
      LIMITS: bindings.json({
        ttlSeconds: test ? 30 : 0,
        idleSeconds: test ? 6 : 3600,
        maxConnections: test ? 3 : 50,
        commandsPerSecond: test ? 100 : 5000,
      }),
    },
  };
});

export default defineConfig({ worker });
