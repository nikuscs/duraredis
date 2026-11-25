import { expect, test } from "bun:test";
import { describeDual } from "./dual";
import type { Pair } from "./dual";
import type { RespArg, RespValue } from "./wire";

const dec = new TextDecoder();

function asNumber(v: RespValue): number {
  if (v.kind === "double") return Number(v.value);
  if (v.kind === "bulk") return Number(dec.decode(v.value));
  throw new Error(`Expected double/bulk, got ${v.kind}`);
}

async function checkCloseArrays(s: Pair, args: Array<RespArg>, check: (r: Array<RespValue>, d: Array<RespValue>) => void) {
  const [rv, dv] = await s.shape(...args);
  expect(rv.kind).toBe("array");
  expect(dv.kind).toBe("array");
  if (rv.kind === "array" && dv.kind === "array") check(rv.items, dv.items);
}

describeDual("geo vs redis:8", (run) => {
  test("GEOADD, GEOPOS, GEOHASH, GEODIST and zset interop", () => run(async (s) => {
    await s.script([
      ["GEOADD", "g", "13.361389", "38.115556", "Palermo", "15.087269", "37.502669", "Catania"],
      ["ZRANGE", "g", "0", "-1", "WITHSCORES"],
      ["GEOADD", "g", "NX", "13.5", "38.2", "Palermo", "12.496366", "41.902782", "Rome"],
      ["GEOADD", "g", "XX", "13.5", "38.2", "Palermo", "9.1900", "45.4642", "Milan"],
      ["GEOADD", "g", "XX", "CH", "13.361389", "38.115556", "Palermo"],
      ["GEOADD", "g", "CH", "13.361389", "38.115556", "Palermo"],
      ["GEOADD", "g", "180", "85.05112878", "MaxCorner", "-180", "-85.05112878", "MinCorner", "-0", "-0", "Zero", "-122.4194", "37.7749", "SF"],
      ["ZRANGE", "g", "0", "-1", "WITHSCORES"],
      ["GEOPOS", "g", "Palermo", "Catania", "MaxCorner", "MinCorner", "SF", "missing"],
      ["GEOPOS", "missing", "Palermo"], ["GEOPOS", "g"],
    ]);
    await checkCloseArrays(s, ["GEOPOS", "g", "Zero"], (ri, di) => {
      expect(ri.length).toBe(1);
      expect(di.length).toBe(1);
      if (ri[0].kind === "array" && di[0].kind === "array") {
        expect(Math.abs(asNumber(ri[0].items[0]) - asNumber(di[0].items[0]))).toBeLessThan(1e-12);
        expect(Math.abs(asNumber(ri[0].items[1]) - asNumber(di[0].items[1]))).toBeLessThan(1e-12);
      }
    });
    await s.script([
      ["GEOHASH", "g", "Palermo", "Catania", "MaxCorner", "MinCorner", "Zero", "SF", "missing"],
      ["GEOHASH", "missing", "Palermo"], ["GEOHASH", "g"],
      ["GEODIST", "g", "Palermo", "Catania"],
      ["GEODIST", "g", "Palermo", "Catania", "km"],
      ["GEODIST", "g", "Palermo", "Catania", "KM"],
      ["GEODIST", "g", "Palermo", "Catania", "mi"],
      ["GEODIST", "g", "Palermo", "Catania", "ft"],
      ["GEODIST", "g", "Palermo", "Palermo"],
      ["GEODIST", "g", "Zero", "MinCorner", "km"],
      ["GEODIST", "g", "Zero", "MaxCorner", "km"],
      ["GEODIST", "g", "MinCorner", "MaxCorner", "km"],
      ["GEODIST", "g", "Palermo", "missing"],
      ["GEODIST", "missing", "Palermo", "Catania"],
      ["ZADD", "gz", "-1", "neg", "0", "zero", "4503599627370495", "max52", "4503599627370496", "over52", "100.5", "frac"],
      ["GEOPOS", "gz", "neg", "zero", "max52", "over52", "frac"],
      ["GEOHASH", "gz", "neg", "zero", "max52", "over52", "frac"],
      ["GEODIST", "gz", "zero", "max52"],
      ["GEOADD", "g", "NX", "XX", "1", "2", "a"],
      ["GEOADD", "g", "181", "0", "bad"],
      ["GEOADD", "g", "0", "85.05112879", "bad"],
      ["GEOADD", "g", "0", "-86", "bad"],
      ["GEOADD", "g", "inf", "0", "bad"],
      ["GEOADD", "g", "nan", "0", "bad"],
      ["GEOADD", "g", "x", "0", "bad"],
      ["GEOADD", "g", "13", "38"],
      ["GEODIST", "g", "Palermo", "Catania", "badunit"],
      ["GEODIST", "g", "Palermo", "Catania", "km", "extra"],
    ]);
  }));

  test("GEORADIUS, GEORADIUSBYMEMBER, GEOSEARCH and GEOSEARCHSTORE", () => run(async (s) => {
    await s.script([
      ["GEOADD", "g", "13.361389", "38.115556", "Palermo", "15.087269", "37.502669", "Catania", "12.496366", "41.902782", "Rome", "9.1900", "45.4642", "Milan", "-122.4194", "37.7749", "SF", "0", "0", "Zero", "-180", "-85.05112878", "MinCorner", "180", "85.05112878", "MaxCorner"],
      ["GEORADIUS", "g", "15", "37", "200", "km", "WITHDIST", "WITHCOORD", "WITHHASH", "ASC"],
      ["GEORADIUS", "g", "15", "37", "200", "km", "WITHHASH", "WITHCOORD", "WITHDIST", "DESC"],
      ["GEORADIUS", "g", "15", "37", "200", "km", "COUNT", "1"],
      ["GEORADIUS", "g", "15", "37", "200", "km", "COUNT", "1", "ANY"],
      ["GEORADIUS", "g", "15", "37", "200", "km", "STORE", "out1"], ["ZRANGE", "out1", "0", "-1", "WITHSCORES"],
      ["GEORADIUS", "g", "15", "37", "200", "km", "STOREDIST", "out2"],
    ]);
    await checkCloseArrays(s, ["ZRANGE", "out2", "0", "-1", "WITHSCORES"], (ri, di) => {
      expect(di.length).toBe(ri.length);
      if (s.proto === 2) {
        for (let i = 0; i < ri.length; i += 2) {
          expect(ri[i]).toEqual(di[i]);
          expect(Math.abs(asNumber(ri[i + 1]) - asNumber(di[i + 1]))).toBeLessThan(1e-11);
        }
      } else {
        for (let i = 0; i < ri.length; i++) {
          const rPair = ri[i];
          const dPair = di[i];
          if (rPair.kind === "array" && dPair.kind === "array") {
            expect(rPair.items[0]).toEqual(dPair.items[0]);
            expect(Math.abs(asNumber(rPair.items[1]) - asNumber(dPair.items[1]))).toBeLessThan(1e-11);
          }
        }
      }
    });
    await s.script([
      ["GEORADIUS", "g", "15", "37", "200", "km", "STORE", "s1", "STOREDIST", "s2"], ["EXISTS", "s1"],
    ]);
    await checkCloseArrays(s, ["ZRANGE", "s2", "0", "-1", "WITHSCORES"], (ri, di) => {
      expect(di.length).toBe(ri.length);
    });
    await s.script([
      ["SET", "out1", "old"], ["GEORADIUS", "g", "10", "10", "1", "m", "STORE", "out1"], ["EXISTS", "out1"],
      ["GEORADIUS_RO", "g", "15", "37", "200", "km", "WITHDIST", "ASC"],
      ["GEORADIUS_RO", "g", "15", "37", "200", "km", "STORE", "out4"],
      ["GEORADIUSBYMEMBER", "g", "Palermo", "200", "km", "WITHDIST", "ASC"],
      ["GEORADIUSBYMEMBER_RO", "g", "Palermo", "200", "km", "WITHDIST", "ASC"],
      ["GEORADIUSBYMEMBER", "g", "missing", "200", "km"],
      ["GEORADIUSBYMEMBER", "missing", "Palermo", "200", "km"],
      ["GEORADIUSBYMEMBER_RO", "g", "Palermo", "200", "km", "STOREDIST", "out5"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYRADIUS", "200", "km", "ASC", "WITHCOORD", "WITHDIST", "WITHHASH"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYRADIUS", "500", "km", "WITHDIST"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYRADIUS", "500", "km", "COUNT", "2", "DESC"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYRADIUS", "500", "km", "COUNT", "2", "ANY"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYRADIUS", "200000", "km", "ASC", "WITHDIST"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYRADIUS", "inf", "km"],
      ["GEOSEARCH", "g", "FROMMEMBER", "Palermo", "BYBOX", "400", "400", "km", "ASC", "WITHDIST"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYBOX", "400", "100", "km", "ASC", "WITHDIST"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYBOX", "100", "400", "km", "ASC", "WITHDIST"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYRADIUS", "0", "km"],
      ["GEOSEARCH", "g", "FROMMEMBER", "Catania", "BYBOX", "0", "100", "km"],
      ["GEOSEARCH", "g", "FROMMEMBER", "missing", "BYRADIUS", "200", "km"],
      ["GEOSEARCH", "missing", "FROMMEMBER", "Palermo", "BYRADIUS", "200", "km"],
      ["GEOSEARCHSTORE", "dst1", "g", "FROMLONLAT", "15", "37", "BYRADIUS", "200", "km", "ASC"], ["ZRANGE", "dst1", "0", "-1", "WITHSCORES"],
      ["GEOSEARCHSTORE", "dst2", "g", "FROMLONLAT", "15", "37", "BYRADIUS", "200", "km", "STOREDIST"],
    ]);
    await checkCloseArrays(s, ["ZRANGE", "dst2", "0", "-1", "WITHSCORES"], (ri, di) => {
      expect(di.length).toBe(ri.length);
    });
    await s.script([
      ["GEOSEARCHSTORE", "dst1", "missing", "FROMMEMBER", "nope", "BYRADIUS", "1", "m"], ["EXISTS", "dst1"],
      ["GEOSEARCHSTORE", "dst1", "g", "FROMMEMBER", "nope", "BYRADIUS", "1", "m"],
      ["GEOADD", "gt", "0", "0", "a", "1", "0", "b", "-1", "0", "c", "0", "1", "d", "0", "-1", "e"],
      ["GEOSEARCH", "gt", "FROMLONLAT", "0", "0", "BYRADIUS", "200", "km", "WITHDIST"],
      ["GEOSEARCH", "gt", "FROMLONLAT", "0", "0", "BYRADIUS", "200", "km", "COUNT", "3", "ANY"],
      ["GEOSEARCH", "gt", "FROMLONLAT", "0", "0", "BYRADIUS", "200", "km", "ASC", "WITHDIST"],
      ["GEOSEARCH", "gt", "FROMLONLAT", "0", "0", "BYRADIUS", "200", "km", "DESC", "WITHDIST"],
      ["GEORADIUS", "g", "15", "37", "200", "km", "COUNT", "0"],
      ["GEORADIUS", "g", "15", "37", "200", "km", "ANY"],
      ["GEORADIUS", "g", "15", "37", "200", "km", "WITHDIST", "STORE", "out3"],
      ["GEOSEARCHSTORE", "dst3", "g", "FROMLONLAT", "15", "37", "BYRADIUS", "200", "km", "WITHDIST"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYRADIUS", "-1", "km"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYRADIUS", "nan", "km"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYBOX", "-1", "10", "km"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYBOX", "nan", "10", "km"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYBOX", "10", "nan", "km"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "BYRADIUS", "200", "km", "BYBOX", "10", "10", "km"],
      ["GEOSEARCH", "g", "FROMLONLAT", "15", "37", "FROMMEMBER", "Palermo", "BYRADIUS", "200", "km"],
      ["LPUSH", "lst", "a"], ["GEOADD", "lst", "1", "2", "a"], ["GEOPOS", "lst", "a"], ["GEOHASH", "lst", "a"],
      ["GEODIST", "lst", "a", "b"], ["GEORADIUS", "lst", "1", "2", "10", "km"],
      ["GEOSEARCH", "lst", "FROMLONLAT", "1", "2", "BYRADIUS", "10", "km"],
      ["GEOSEARCHSTORE", "lst", "g", "FROMLONLAT", "15", "37", "BYRADIUS", "200", "km"], ["TYPE", "lst"],
    ]);
  }));
});
