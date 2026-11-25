import { test } from "bun:test";
import { describeDual } from "./dual";

describeDual("hyperloglog vs redis:8", (run) => {
  test("PFADD, PFCOUNT, PFMERGE, PFDEBUG, PFSELFTEST", () => run(async (s) => {
    await s.script([
      ["PFADD", "h0"], ["GET", "h0"], ["PFADD", "h0"], ["PFCOUNT", "h0"], ["GET", "h0"],
      ["PFDEBUG", "ENCODING", "h0"], ["PFDEBUG", "DECODE", "h0"],
      ["PFADD", "h1", "a", "b", "c"], ["GET", "h1"], ["PFCOUNT", "h1"], ["GET", "h1"],
      ["PFADD", "h1", "a"], ["GET", "h1"],
      ["PFADD", "h1", "d", "e", "f", "g", "h", "i", "j"], ["GET", "h1"],
      ["PFDEBUG", "DECODE", "h1"], ["PFCOUNT", "h1"], ["GET", "h1"],
      ["PFCOUNT", "missing"], ["PFCOUNT", "missing1", "missing2"], ["PFCOUNT", "h1", "missing"],
      ["PFADD", "h2", "c", "d", "e", "f", "x", "y"], ["PFCOUNT", "h1", "h2"], ["GET", "h1"],
      ["PFMERGE", "hm", "h1", "h2"], ["GET", "hm"], ["PFDEBUG", "ENCODING", "hm"], ["PFCOUNT", "hm"], ["GET", "hm"],
      ["PFMERGE", "hm_empty"], ["GET", "hm_empty"], ["PFCOUNT", "hm_empty"],
      ["PFMERGE", "hm_miss", "m1", "m2"], ["GET", "hm_miss"], ["PFCOUNT", "hm_miss"],
      ["PFMERGE", "hm_exist", "h1"], ["PFMERGE", "hm_exist", "h2"], ["PFCOUNT", "hm_exist"],
      ["PFDEBUG", "TODENSE", "h0"], ["PFDEBUG", "ENCODING", "h0"], ["PFDEBUG", "TODENSE", "h0"],
      ["PFDEBUG", "DECODE", "h0"], ["GET", "h0"],
      ["PFMERGE", "hm_ds", "h0", "h1"], ["PFDEBUG", "ENCODING", "hm_ds"], ["PFCOUNT", "hm_ds"],
      ["PFDEBUG", "GETREG", "h1"], ["PFDEBUG", "ENCODING", "h1"],
      ["PFSELFTEST"],
    ]);

    const batch1 = Array.from({ length: 200 }, (_, i) => `elem${i + 1}`);
    await s.cmd("PFADD", "hbig", ...batch1);
    await s.script([["PFDEBUG", "ENCODING", "hbig"], ["GET", "hbig"], ["PFCOUNT", "hbig"], ["GET", "hbig"]]);

    const batch2 = Array.from({ length: 1800 }, (_, i) => `elem${i + 201}`);
    await s.cmd("PFADD", "hbig", ...batch2);
    await s.script([["PFDEBUG", "ENCODING", "hbig"], ["STRLEN", "hbig"], ["GET", "hbig"], ["PFCOUNT", "hbig"], ["GET", "hbig"]]);

    const batch3 = Array.from({ length: 3000 }, (_, i) => `elem${i + 2001}`);
    await s.cmd("PFADD", "hbig", ...batch3);
    await s.script([["PFCOUNT", "hbig"], ["GET", "hbig"]]);
  }));

  test("HLL validation and error replies", () => run(async (s) => {
    await s.script([
      ["SET", "nothll", "hello"],
      ["PFADD", "nothll", "a"], ["PFCOUNT", "nothll"], ["PFCOUNT", "h_ok", "nothll"],
      ["PFMERGE", "hm", "nothll"], ["PFMERGE", "nothll", "h_ok"],
      ["PFDEBUG", "ENCODING", "nothll"], ["PFDEBUG", "DECODE", "nothll"],
      ["PFDEBUG", "TODENSE", "nothll"], ["PFDEBUG", "GETREG", "nothll"],
      ["SET", "short_hyll", "HYLL"], ["PFCOUNT", "short_hyll"],
      ["SET", "bad_enc", new Uint8Array([0x48, 0x59, 0x4c, 0x4c, 0x02, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
      ["PFCOUNT", "bad_enc"],
      ["SET", "bad_dense", new Uint8Array([0x48, 0x59, 0x4c, 0x4c, 0x00, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])],
      ["PFCOUNT", "bad_dense"],
      ["PFDEBUG", "ENCODING", "missing"], ["PFDEBUG", "DECODE", "missing"],
      ["PFDEBUG", "TODENSE", "missing"], ["PFDEBUG", "GETREG", "missing"],
      ["PFADD", "h1", "a"], ["PFDEBUG", "BAD", "h1"], ["PFDEBUG"],
      ["LPUSH", "lst", "a"], ["PFADD", "lst", "a"], ["PFCOUNT", "lst"],
      ["PFMERGE", "hm", "lst"], ["PFMERGE", "lst", "h1"], ["PFDEBUG", "ENCODING", "lst"],
    ]);
  }));
});
