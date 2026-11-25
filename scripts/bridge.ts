import type { Socket } from "bun";

interface Link {
  ws: WebSocket;
  early: Array<Uint8Array>;
  pending: Array<Uint8Array>;
}

const [target, portArg = "6380"] = process.argv.slice(2);
if (!target) {
  process.stderr.write("usage: bun run bridge <https://your-worker.workers.dev> [local port]\n");
  process.exit(1);
}
const url = target.replace(/^http/, "ws");

function flush(socket: Socket<Link>) {
  const { pending } = socket.data;
  while (pending.length) {
    const chunk = pending[0];
    const written = socket.write(chunk);
    if (written === chunk.length) pending.shift();
    else {
      pending[0] = chunk.subarray(written);
      return;
    }
  }
}

function open(socket: Socket<Link>) {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  socket.data = { ws, early: [], pending: [] };
  ws.addEventListener("open", () => {
    for (const chunk of socket.data.early) ws.send(chunk);
    socket.data.early = [];
  });
  ws.addEventListener("message", (event: MessageEvent) => {
    const data: unknown = event.data;
    socket.data.pending.push(data instanceof ArrayBuffer ? new Uint8Array(data) : new TextEncoder().encode(String(data)));
    flush(socket);
  });
  ws.addEventListener("close", () => socket.end());
  ws.addEventListener("error", () => socket.end());
}

Bun.listen<Link>({
  hostname: "127.0.0.1",
  port: Number(portArg),
  socket: {
    open,
    data(socket, chunk) {
      const { ws, early } = socket.data;
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
      else early.push(chunk.slice());
    },
    drain: flush,
    close(socket) {
      socket.data.ws.close();
    },
  },
});

process.stdout.write(`Duraredis bridge: redis://<database>:<password>@127.0.0.1:${portArg} -> ${url}\n`);
