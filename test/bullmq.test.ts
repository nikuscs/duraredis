import { describe, expect, test } from "bun:test";
import { Queue, QueueEvents, Worker } from "bullmq";
import type { Job } from "bullmq";
import { freshDb, serverHost, serverPort } from "./setup";

function connectionFor(db: string) {
  return {
    host: serverHost(),
    port: serverPort(),
    username: db,
    password: "x",
    maxRetriesPerRequest: null,
  };
}

describe("BullMQ end-to-end against Duraredis", () => {
  test("processes jobs, delays, retries, and emits completed/failed events", async () => {
    const db = freshDb("bullmq");
    const connection = connectionFor(db);
    const queueName = "tasks";
    const queue = new Queue(queueName, { connection });
    const queueEvents = new QueueEvents(queueName, { connection });

    const completedEvents: Array<{ jobId: string; returnvalue: string }> = [];
    const failedEvents: Array<{ jobId: string; failedReason: string }> = [];
    queueEvents.on("completed", ({ jobId, returnvalue }) => {
      completedEvents.push({ jobId, returnvalue });
    });
    queueEvents.on("failed", ({ jobId, failedReason }) => {
      failedEvents.push({ jobId, failedReason });
    });

    const flakyAttempts = new Map<string, number>();
    const worker = new Worker<{ a?: number; b?: number }>(
      queueName,
      async (job: Job<{ a?: number; b?: number }>) => {
        if (job.name === "sum") return (job.data.a ?? 0) + (job.data.b ?? 0);
        if (job.name === "delayed") return "after-delay";
        if (job.name === "flaky") {
          const id = job.id ?? "";
          const attempt = (flakyAttempts.get(id) ?? 0) + 1;
          flakyAttempts.set(id, attempt);
          if (attempt < 3) throw new Error(`try-${attempt}`);
          return "recovered";
        }
        if (job.name === "doomed") throw new Error("boom");
        return null;
      },
      { connection },
    );

    try {
      await Promise.all([queue.waitUntilReady(), queueEvents.waitUntilReady(), worker.waitUntilReady()]);

      const j1 = await queue.add("sum", { a: 2, b: 3 });
      const j2 = await queue.add("sum", { a: 10, b: 20 });
      expect(await j1.waitUntilFinished(queueEvents)).toBe(5);
      expect(await j2.waitUntilFinished(queueEvents)).toBe(30);

      const started = Date.now();
      const delayed = await queue.add("delayed", {}, { delay: 250 });
      expect(await delayed.waitUntilFinished(queueEvents)).toBe("after-delay");
      expect(Date.now() - started).toBeGreaterThanOrEqual(200);

      const flaky = await queue.add("flaky", {}, { attempts: 3, backoff: { type: "fixed", delay: 50 } });
      expect(await flaky.waitUntilFinished(queueEvents)).toBe("recovered");
      expect(flakyAttempts.get(flaky.id ?? "")).toBe(3);

      const doomed = await queue.add("doomed", {}, { attempts: 2, backoff: { type: "fixed", delay: 50 } });
      await expect(doomed.waitUntilFinished(queueEvents)).rejects.toThrow(/boom/);

      await Bun.sleep(50);
      expect(completedEvents.map((e) => e.jobId)).toContain(j1.id ?? "");
      expect(completedEvents.map((e) => e.jobId)).toContain(j2.id ?? "");
      expect(completedEvents.map((e) => e.jobId)).toContain(delayed.id ?? "");
      expect(completedEvents.map((e) => e.jobId)).toContain(flaky.id ?? "");
      expect(failedEvents.some((e) => e.jobId === (doomed.id ?? "") && e.failedReason === "boom")).toBe(true);
    } finally {
      await worker.close();
      await queueEvents.close();
      await queue.close();
    }
  });

  test("runs repeatable jobs via job scheduler", async () => {
    const db = freshDb("bullmq-rep");
    const connection = connectionFor(db);
    const queueName = "sched";
    const queue = new Queue(queueName, { connection });
    const queueEvents = new QueueEvents(queueName, { connection });

    let runs = 0;
    const worker = new Worker(
      queueName,
      async () => {
        runs += 1;
        return runs;
      },
      { connection },
    );

    try {
      await Promise.all([queue.waitUntilReady(), queueEvents.waitUntilReady(), worker.waitUntilReady()]);
      await queue.upsertJobScheduler("tick-sched", { every: 150, limit: 2 }, { name: "tick", data: { v: 1 } });

      for (let i = 0; i < 100 && runs < 2; i++) await Bun.sleep(50);
      expect(runs).toBeGreaterThanOrEqual(2);
    } finally {
      await worker.close();
      await queueEvents.close();
      await queue.close();
    }
  });
});
