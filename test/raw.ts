import { connect } from "node:net";
import type { Socket } from "node:net";

export interface RawClient {
  send(line: string, replies?: number): Promise<Array<string>>;
  isClosed(): boolean;
  close(): void;
}

export async function openRaw(host: string, port: number): Promise<RawClient> {
  const socket: Socket = connect({ host, port });
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve).once("error", reject);
  });
  let received = "";
  let closed = false;
  socket.on("data", (d) => (received += d.toString("latin1")));
  socket.on("close", () => (closed = true));
  socket.on("error", () => {});
  const send = async (line: string, replies = 1) => {
    const start = received.length;
    socket.write(`${line}\r\n`);
    for (let i = 0; i < 100; i++) {
      const got = received.slice(start).split("\r\n").filter(Boolean);
      if (got.length >= replies || closed) return got;
      await Bun.sleep(20);
    }
    throw new Error(`no reply to ${line}; got ${JSON.stringify(received.slice(start))}`);
  };
  return { send, isClosed: () => closed, close: () => socket.destroy() };
}
