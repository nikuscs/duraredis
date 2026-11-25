import {
  decodeMercator,
  encodeMercatorScore,
  GEO_LAT_MAX,
  GEO_LAT_MIN,
  GEO_LONG_MAX,
  GEO_LONG_MIN,
  geohashDistance,
  geohashString,
  inRadius,
  inRectangle,
  scoreToBits,
  searchRanges,
} from "../geo/geohash";
import { r, RedisError } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { TYPE } from "../store/schema";
import { ERR, float, int, opt, toFloat } from "./args";
import { spec } from "./types";
import type { Ctx, Table } from "./types";
import { put, score, select, store, zsetId } from "./zsets";
import type { Entry } from "./zsets";

const UNITS = new Map<string, number>([
  ["M", 1],
  ["KM", 1000],
  ["FT", 0.3048],
  ["MI", 1609.34],
]);

type SortOrder = "NONE" | "ASC" | "DESC";

interface GeoHit {
  member: Uint8Array;
  score: number;
  lon: number;
  lat: number;
  dist: number;
}

interface SearchPlan {
  fromMember: Uint8Array | null;
  lon: number;
  lat: number;
  shape: "radius" | "box";
  radiusM: number;
  widthM: number;
  heightM: number;
  unitScale: number;
  sort: SortOrder;
  count: number;
  any: boolean;
  withDist: boolean;
  withHash: boolean;
  withCoord: boolean;
  storeKey: Uint8Array | null;
  storeDist: boolean;
}

function fmtCoord(n: number): string {
  if (Number.isFinite(n)) return n.toFixed(6);
  return n > 0 ? "inf" : "-inf";
}

function parseLonLat(lonArg: Uint8Array, latArg: Uint8Array): [number, number] {
  const lon = float(lonArg);
  const lat = float(latArg);
  if (lon < GEO_LONG_MIN || lon > GEO_LONG_MAX || lat < GEO_LAT_MIN || lat > GEO_LAT_MAX) {
    throw new RedisError(`ERR invalid longitude,latitude pair ${fmtCoord(lon)},${fmtCoord(lat)}`);
  }
  return [lon, lat];
}

function parseUnit(arg: Uint8Array): number {
  const scale = UNITS.get(opt(arg));
  if (scale === undefined) throw new RedisError("ERR unsupported unit provided. please use M, KM, FT, MI");
  return scale;
}

function parseGeoFloat(arg: Uint8Array, label: string): number {
  const n = toFloat(arg);
  if (n === undefined) throw new RedisError(`ERR need numeric ${label}`);
  return n;
}

function geoadd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const key = args[1];
  let nx = false;
  let xx = false;
  let ch = false;
  let i = 2;
  for (; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "NX") nx = true;
    else if (o === "XX") xx = true;
    else if (o === "CH") ch = true;
    else break;
  }
  if (nx && xx) throw new RedisError(ERR.syntax);
  const rest = args.length - i;
  if (rest === 0 || rest % 3 !== 0) throw new RedisError(ERR.syntax);
  const items: Array<{ score: number; member: Uint8Array }> = [];
  for (; i < args.length; i += 3) {
    const [lon, lat] = parseLonLat(args[i], args[i + 1]);
    items.push({ score: encodeMercatorScore(lon, lat), member: args[i + 2] });
  }
  const existing = zsetId(ctx, key);
  if (existing === undefined && xx) return r.int(0);
  const id = existing ?? ctx.ks.create(key, TYPE.zset);
  let added = 0;
  let changed = 0;
  for (const item of items) {
    const cur = score(ctx, id, item.member);
    if (cur === undefined ? xx : nx) continue;
    if (cur === item.score) continue;
    put(ctx, key, id, item.member, item.score);
    if (cur === undefined) added++;
    else changed++;
  }
  if (added || changed) ctx.ks.onChange(key);
  return r.int(ch ? added + changed : added);
}

function geodist(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length > 5) throw new RedisError(ERR.syntax);
  const scale = args.length === 5 ? parseUnit(args[4]) : 1;
  const id = zsetId(ctx, args[1]);
  if (id === undefined) return r.nil;
  const s1 = score(ctx, id, args[2]);
  const s2 = score(ctx, id, args[3]);
  if (s1 === undefined || s2 === undefined) return r.nil;
  const [lon1, lat1] = decodeMercator(scoreToBits(s1));
  const [lon2, lat2] = decodeMercator(scoreToBits(s2));
  return r.bulk((geohashDistance(lon1, lat1, lon2, lat2) / scale).toFixed(4));
}

function geohash(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const id = zsetId(ctx, args[1]);
  return r.bulks(
    args.slice(2).map((m) => {
      const s = id === undefined ? undefined : score(ctx, id, m);
      if (s === undefined) return null;
      const [lon, lat] = decodeMercator(scoreToBits(s));
      return geohashString(lon, lat);
    }),
  );
}

function geopos(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const id = zsetId(ctx, args[1]);
  return r.array(
    args.slice(2).map((m) => {
      const s = id === undefined ? undefined : score(ctx, id, m);
      if (s === undefined) return r.nilArray;
      const [lon, lat] = decodeMercator(scoreToBits(s));
      return r.array([r.double(lon), r.double(lat)]);
    }),
  );
}

interface SearchOpts {
  sort: SortOrder;
  count: number;
  any: boolean;
  withDist: boolean;
  withHash: boolean;
  withCoord: boolean;
  storeKey: Uint8Array | null;
  storeDist: boolean;
}

function parseSearchOpts(args: Array<Uint8Array>, start: number, allowStore: boolean, storeCompatError: string): SearchOpts {
  let sort: SortOrder = "NONE";
  let count = 0;
  let any = false;
  let withDist = false;
  let withHash = false;
  let withCoord = false;
  let storeKey: Uint8Array | null = null;
  let storeDist = false;
  for (let i = start; i < args.length; i++) {
    const o = opt(args[i]);
    if (o === "WITHCOORD") withCoord = true;
    else if (o === "WITHDIST") withDist = true;
    else if (o === "WITHHASH") withHash = true;
    else if (o === "ASC") sort = "ASC";
    else if (o === "DESC") sort = "DESC";
    else if (o === "ANY") any = true;
    else if (o === "COUNT" && i + 1 < args.length) {
      count = int(args[++i]);
      if (count <= 0) throw new RedisError("ERR COUNT must be > 0");
    } else if (allowStore && o === "STORE" && i + 1 < args.length) {
      storeKey = args[++i];
      storeDist = false;
    } else if (allowStore && o === "STOREDIST" && i + 1 < args.length) {
      storeKey = args[++i];
      storeDist = true;
    } else throw new RedisError(ERR.syntax);
  }
  if (any && count === 0) throw new RedisError("ERR the ANY argument requires COUNT argument");
  if (storeKey && (withDist || withHash || withCoord)) throw new RedisError(storeCompatError);
  return { sort, count, any, withDist, withHash, withCoord, storeKey, storeDist };
}

function geoRadius(ctx: Ctx, args: Array<Uint8Array>, byMember: boolean, readonly: boolean): Reply {
  let i = 2;
  let fromMember: Uint8Array | null = null;
  let lon = 0;
  let lat = 0;
  if (byMember) {
    fromMember = args[i++];
  } else {
    [lon, lat] = parseLonLat(args[i], args[i + 1]);
    i += 2;
  }
  const radius = parseGeoFloat(args[i++], "radius");
  if (radius < 0) throw new RedisError("ERR radius cannot be negative");
  const unitScale = parseUnit(args[i++]);
  const opts = parseSearchOpts(
    args,
    i,
    !readonly,
    "ERR STORE option in GEORADIUS is not compatible with WITHDIST, WITHHASH and WITHCOORD options",
  );
  return executeSearch(ctx, args[1], {
    fromMember,
    lon,
    lat,
    shape: "radius",
    radiusM: radius * unitScale,
    widthM: 0,
    heightM: 0,
    unitScale,
    ...opts,
  });
}

function geoSearch(ctx: Ctx, args: Array<Uint8Array>, storing: boolean): Reply {
  const srcKey = storing ? args[2] : args[1];
  const storeKey = storing ? args[1] : null;
  let i = storing ? 3 : 2;
  let fromMember: Uint8Array | null = null;
  let lon = 0;
  let lat = 0;
  let fromKind: "member" | "lonlat" | null = null;
  let shape: "radius" | "box" | null = null;
  let radiusM = 0;
  let widthM = 0;
  let heightM = 0;
  let unitScale = 1;
  let sort: SortOrder = "NONE";
  let count = 0;
  let any = false;
  let withDist = false;
  let withHash = false;
  let withCoord = false;
  let storeDist = false;
  while (i < args.length) {
    const o = opt(args[i]);
    if (o === "FROMMEMBER" && (fromKind === null || fromKind === "member") && i + 1 < args.length) {
      fromKind = "member";
      fromMember = args[++i];
      i++;
    } else if (o === "FROMLONLAT" && (fromKind === null || fromKind === "lonlat") && i + 2 < args.length) {
      fromKind = "lonlat";
      [lon, lat] = parseLonLat(args[i + 1], args[i + 2]);
      i += 3;
    } else if (o === "BYRADIUS" && (shape === null || shape === "radius") && i + 2 < args.length) {
      shape = "radius";
      const radius = parseGeoFloat(args[i + 1], "radius");
      if (radius < 0) throw new RedisError("ERR radius cannot be negative");
      unitScale = parseUnit(args[i + 2]);
      radiusM = radius * unitScale;
      i += 3;
    } else if (o === "BYBOX" && (shape === null || shape === "box") && i + 3 < args.length) {
      shape = "box";
      const w = parseGeoFloat(args[i + 1], "width");
      const h = parseGeoFloat(args[i + 2], "height");
      if (w < 0 || h < 0) throw new RedisError("ERR height or width cannot be negative");
      unitScale = parseUnit(args[i + 3]);
      widthM = w * unitScale;
      heightM = h * unitScale;
      i += 4;
    } else if (o === "ASC") {
      sort = "ASC";
      i++;
    } else if (o === "DESC") {
      sort = "DESC";
      i++;
    } else if (o === "COUNT" && i + 1 < args.length) {
      count = int(args[++i]);
      if (count <= 0) throw new RedisError("ERR COUNT must be > 0");
      i++;
    } else if (o === "ANY") {
      any = true;
      i++;
    } else if (o === "WITHCOORD") {
      withCoord = true;
      i++;
    } else if (o === "WITHDIST") {
      withDist = true;
      i++;
    } else if (o === "WITHHASH") {
      withHash = true;
      i++;
    } else if (storing && o === "STOREDIST") {
      storeDist = true;
      i++;
    } else {
      throw new RedisError(ERR.syntax);
    }
  }
  if (!fromKind || !shape) throw new RedisError(ERR.syntax);
  if (any && count === 0) throw new RedisError("ERR the ANY argument requires COUNT argument");
  if (storing && (withDist || withHash || withCoord)) {
    throw new RedisError("ERR GEOSEARCHSTORE is not compatible with WITHDIST, WITHHASH and WITHCOORD options");
  }
  return executeSearch(ctx, srcKey, {
    fromMember,
    lon,
    lat,
    shape,
    radiusM,
    widthM,
    heightM,
    unitScale,
    sort,
    count,
    any,
    withDist,
    withHash,
    withCoord,
    storeKey,
    storeDist,
  });
}

function executeSearch(ctx: Ctx, srcKey: Uint8Array, plan: SearchPlan): Reply {
  const sort: SortOrder = plan.count > 0 && !plan.any && plan.sort === "NONE" ? "ASC" : plan.sort;
  const id = zsetId(ctx, srcKey);
  if (id === undefined) {
    if (plan.storeKey) {
      ctx.ks.delete(plan.storeKey);
      return r.int(0);
    }
    return r.array([]);
  }
  let centerLon = plan.lon;
  let centerLat = plan.lat;
  if (plan.fromMember) {
    const s = score(ctx, id, plan.fromMember);
    if (s === undefined) throw new RedisError("ERR could not decode requested zset member");
    [centerLon, centerLat] = decodeMercator(scoreToBits(s));
  }
  const halfW = plan.shape === "radius" ? plan.radiusM : plan.widthM / 2;
  const halfH = plan.shape === "radius" ? plan.radiusM : plan.heightM / 2;
  const estRadius = plan.shape === "radius" ? plan.radiusM : Math.hypot(halfW, halfH);
  const ranges = searchRanges(centerLon, centerLat, halfW, halfH, estRadius);
  const hits: Array<GeoHit> = [];
  for (const [min, max] of ranges) {
    const entries = select(ctx, id, {
      by: "score",
      min: { value: min, exclusive: false },
      max: { value: max, exclusive: true },
      rev: false,
      offset: 0,
      count: -1,
    });
    for (const e of entries) {
      const [elon, elat] = decodeMercator(scoreToBits(e.score));
      const dist =
        plan.shape === "radius"
          ? inRadius(centerLon, centerLat, elon, elat, plan.radiusM)
          : inRectangle(plan.widthM, plan.heightM, centerLon, centerLat, elon, elat);
      if (dist === null) continue;
      hits.push({ member: e.member, score: e.score, lon: elon, lat: elat, dist });
      if (plan.count > 0 && plan.any && hits.length >= plan.count) break;
    }
    if (plan.count > 0 && plan.any && hits.length >= plan.count) break;
  }
  if (sort === "ASC") hits.sort((a, b) => a.dist - b.dist);
  else if (sort === "DESC") hits.sort((a, b) => b.dist - a.dist);
  const finalHits = plan.count > 0 && hits.length > plan.count ? hits.slice(0, plan.count) : hits;
  if (plan.storeKey) {
    const stored: Array<Entry> = finalHits.map((h) => ({
      member: h.member,
      score: plan.storeDist ? h.dist / plan.unitScale : h.score,
    }));
    return store(ctx, plan.storeKey, stored);
  }
  if (!plan.withDist && !plan.withHash && !plan.withCoord) return r.bulks(finalHits.map((h) => h.member));
  return r.array(
    finalHits.map((h) => {
      const items: Array<Reply> = [r.bulk(h.member)];
      if (plan.withDist) items.push(r.bulk((h.dist / plan.unitScale).toFixed(4)));
      if (plan.withHash) items.push(r.int(BigInt(Math.trunc(h.score))));
      if (plan.withCoord) items.push(r.array([r.double(h.lon), r.double(h.lat)]));
      return r.array(items);
    }),
  );
}

export const geo: Table = {
  geoadd: spec(-5, ["write"], geoadd),
  geodist: spec(-4, ["readonly"], geodist),
  geohash: spec(-2, ["readonly"], geohash),
  geopos: spec(-2, ["readonly"], geopos),
  georadius: spec(-6, ["write"], (ctx, args) => geoRadius(ctx, args, false, false)),
  georadius_ro: spec(-6, ["readonly"], (ctx, args) => geoRadius(ctx, args, false, true)),
  georadiusbymember: spec(-5, ["write"], (ctx, args) => geoRadius(ctx, args, true, false)),
  georadiusbymember_ro: spec(-5, ["readonly"], (ctx, args) => geoRadius(ctx, args, true, true)),
  geosearch: spec(-7, ["readonly"], (ctx, args) => geoSearch(ctx, args, false)),
  geosearchstore: spec(-8, ["write"], (ctx, args) => geoSearch(ctx, args, true), [1, 2, 1]),
};
