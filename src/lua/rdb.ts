import { RdbWriter, verifyDumpPayload } from "../store/rdb/codec";

export { crc64 } from "../store/rdb/codec";

const RDB_OPCODE_FUNCTION2 = 245;
const RDB_OPCODE_FUNCTION_PRE_GA = 246;

export function dumpFunctions(codes: Array<Uint8Array>): Uint8Array {
  const writer = new RdbWriter();
  for (const code of codes) {
    writer.u8(RDB_OPCODE_FUNCTION2);
    writer.blobString(code);
  }
  return writer.finishDump();
}

export type DumpParseResult =
  | { ok: true; codes: Array<Uint8Array> }
  | { ok: false; error: string };

export function parseFunctionsDump(payload: Uint8Array): DumpParseResult {
  const verified = verifyDumpPayload(payload);
  if (!verified) return { ok: false, error: "ERR DUMP payload version or checksum are wrong" };
  const { reader } = verified;
  const codes: Array<Uint8Array> = [];
  while (!reader.eof) {
    const type = reader.u8();
    if (type === RDB_OPCODE_FUNCTION_PRE_GA) return { ok: false, error: "ERR Pre-GA function format not supported" };
    if (type !== RDB_OPCODE_FUNCTION2) return { ok: false, error: "ERR given type is not a function" };
    try {
      codes.push(reader.string());
    } catch {
      return { ok: false, error: "ERR Failed loading library payload" };
    }
  }
  return { ok: true, codes };
}
