import { bytes } from "../resp/reply";

export function chunkOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new TypeError("duraredis: TCP sockets deliver byte chunks");
}

export const closeQuietly = (socket: Socket): Promise<void> => Promise.resolve().then(() => socket.close()).catch(() => {});

export async function refuse(socket: Socket, message: string) {
  const writer = socket.writable.getWriter();
  await writer.write(bytes(`-${message}\r\n`)).catch(() => {});
  await writer.close().catch(() => {});
  await closeQuietly(socket);
}
