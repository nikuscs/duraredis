import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import { join } from "node:path";

export interface Server {
  host: string;
  port: number;
  http: string;
  url(name: string): string;
  stop(): Promise<void>;
  restart(): Promise<void>;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
  if (!address || typeof address === "string") throw new Error("no free port");
  return address.port;
}

export async function startServer(mode: "default" | "test" = "default"): Promise<Server> {
  const [httpPort, inspectorPort, port] = [await freePort(), await freePort(), await freePort()];
  const state = await mkdtemp(join(tmpdir(), "duraredis-test-"));
  const args = ["wrangler", "dev", "--experimental-new-config", "--ip", "127.0.0.1", "--port", String(httpPort),
    "--inspector-port", String(inspectorPort), "--persist-to", state, ...(mode === "test" ? ["--env", "test"] : [])];

  const launch = async () => {
    const proc = Bun.spawn(["bunx", ...args], {
      stdout: "pipe", stderr: "pipe", env: { ...process.env, WRANGLER_SEND_METRICS: "false", DURAREDIS_PORT: String(port) },
    });
    let log = "";
    const isReady = () => log.includes("Ready on") && log.includes(`127.0.0.1:${httpPort}`);
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const decoder = new TextDecoder();
      for await (const chunk of stream) log += decoder.decode(chunk, { stream: true });
    };
    void read(proc.stdout);
    void read(proc.stderr);
    for (let i = 0; i < 600 && !isReady(); i++) {
      if (proc.exitCode !== null) break;
      await Bun.sleep(100);
    }
    if (isReady()) return proc;
    proc.kill();
    await proc.exited;
    throw new Error(`wrangler dev did not start:\n${log}`);
  };

  let proc = await launch().catch(async (error: unknown) => {
    await rm(state, { recursive: true, force: true });
    throw error;
  });
  const halt = async () => {
    proc.kill();
    await proc.exited;
  };
  const stop = async () => {
    await halt();
    await rm(state, { recursive: true, force: true });
  };
  const restart = async () => {
    await halt();
    proc = await launch();
  };
  const host = "127.0.0.1";
  return { host, port, http: `http://${host}:${httpPort}`, url: (name) => `redis://${name}:x@${host}:${port}`, stop, restart };
}
