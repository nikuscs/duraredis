import { chunkOf } from "./socket";

const PREFIX = "DURAREDIS-CLIENT ";
const MAX_LENGTH = 128;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export const preamble = (client: string): Uint8Array => encoder.encode(`${PREFIX}${client}\n`);

export interface Opened {
  client: string;
  rest: Uint8Array;
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

export async function readPreamble(reader: ReadableStreamDefaultReader): Promise<Opened | undefined> {
  let buffered: Uint8Array = new Uint8Array(0);
  for (;;) {
    const end = buffered.indexOf(10);
    if (end >= 0) {
      const line = decoder.decode(buffered.subarray(0, end));
      if (!line.startsWith(PREFIX)) return undefined;
      return { client: line.slice(PREFIX.length), rest: buffered.subarray(end + 1) };
    }
    if (buffered.length > MAX_LENGTH) return undefined;
    const next: ReadableStreamReadResult<unknown> = await reader.read();
    if (next.done) return undefined;
    buffered = concat(buffered, chunkOf(next.value));
  }
}
