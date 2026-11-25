import { WireClient } from "./wire";

export interface DockerCheck {
  available: boolean;
}

export interface RedisContainer {
  host: string;
  port: number;
  stop(): Promise<void>;
}

const dec = new TextDecoder();

export function checkDocker(): DockerCheck {
  try {
    const res = Bun.spawnSync(["docker", "info", "--format", "{{.ServerVersion}}"], { stdout: "pipe", stderr: "pipe" });
    return { available: res.exitCode === 0 };
  } catch {
    return { available: false };
  }
}

async function docker(...args: Array<string>) {
  const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { exitCode, stdout: stdout.trim(), stderr: stderr.trim() };
}

export async function startRedisContainer(image = "redis:8"): Promise<RedisContainer> {
  const host = "127.0.0.1";
  const run = await docker("run", "-d", "--rm", "-p", `${host}:0:6379`, image, "redis-server", "--save", "", "--appendonly", "no");
  if (run.exitCode !== 0) throw new Error(`Failed to start ${image}: ${run.stderr || run.stdout}`);
  const id = run.stdout;

  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    await docker("rm", "-f", id).catch(() => {});
  };

  try {
    const portInfo = await docker("port", id, "6379/tcp");
    const match = portInfo.exitCode === 0 ? portInfo.stdout.match(/:(\d+)\s*$/m) : null;
    if (!match) throw new Error(`Could not resolve port for ${id}: ${portInfo.stderr || portInfo.stdout}`);
    const port = Number(match[1]);

    let lastErr: unknown;
    for (let i = 0; i < 150; i++) {
      let client: WireClient | undefined;
      try {
        client = await WireClient.connect(host, port, 1000);
        if (dec.decode(await client.cmd("PING")) === "+PONG\r\n") return { host, port, stop };
      } catch (error: unknown) {
        lastErr = error;
      } finally {
        await client?.close();
      }
      await Bun.sleep(100);
    }

    const logs = await docker("logs", id).catch(() => ({ stdout: "", stderr: "" }));
    throw new Error(`${image} failed readiness on ${host}:${port} (${String(lastErr)}):\n${logs.stdout}\n${logs.stderr}`);
  } catch (error) {
    await stop();
    throw error;
  }
}
