import { serve } from "./gateway";
import type { Duplex } from "./database/socket";

const USAGE = "Duraredis speaks Redis over TCP, or over a WebSocket at this URL through the bridge: bun run bridge <this url>\n";
const encoder = new TextEncoder();

function bytesOf(data: unknown): Uint8Array {
  if (typeof data === "string") return encoder.encode(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError(`duraredis: unexpected WebSocket message ${Object.prototype.toString.call(data)}`);
}

function shut(ws: WebSocket, code: number) {
  if (ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) return;
  ws.close(code);
}

function duplexOf(ws: WebSocket): Duplex {
  let open = true;
  const readable = new ReadableStream<Uint8Array>({
    start(controller) {
      const end = (error?: Error) => {
        if (!open) return;
        open = false;
        if (error) controller.error(error);
        else controller.close();
      };
      ws.addEventListener("message", (event: MessageEvent) => {
        if (open) controller.enqueue(bytesOf(event.data as unknown));
      });
      ws.addEventListener("close", () => end());
      ws.addEventListener("error", () => end(new Error("duraredis: WebSocket error")));
    },
    cancel: () => {
      open = false;
      shut(ws, 1000);
    },
  });
  const writable = new WritableStream<Uint8Array>({
    write: (chunk: Uint8Array) => ws.send(chunk),
    close: () => shut(ws, 1000),
    abort: () => shut(ws, 1011),
  });
  return { readable, writable, close: async () => shut(ws, 1000) };
}

export function upgrade(request: Request, env: Env, ctx: ExecutionContext): Response {
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") return new Response(USAGE, { status: 426 });
  const [client, server] = Object.values(new WebSocketPair());
  server.binaryType = "arraybuffer";
  server.accept();
  const address = `${request.headers.get("CF-Connecting-IP") ?? ""}:0`;
  ctx.waitUntil(serve(duplexOf(server), address, env));
  return new Response(null, { status: 101, webSocket: client });
}
