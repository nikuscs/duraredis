import { bloomCommands } from "../probabilistic/bloom";
import { cmsCommands } from "../probabilistic/cms";
import { cuckooCommands } from "../probabilistic/cuckoo";
import { tdigestCommands } from "../probabilistic/tdigest";
import { topkCommands } from "../probabilistic/topk";
import { spec } from "./types";
import type { Table } from "./types";

export const probabilistic: Table = {
  "bf.add": spec(3, ["write"], (ctx, args) => bloomCommands.bfAdd(ctx, args, false)),
  "bf.card": spec(2, ["readonly", "fast"], bloomCommands.bfCard),
  "bf.debug": spec(2, ["readonly", "fast"], bloomCommands.bfDebug),
  "bf.exists": spec(3, ["readonly", "fast"], (ctx, args) => bloomCommands.bfExists(ctx, args, false)),
  "bf.info": spec(-2, ["readonly", "fast"], bloomCommands.bfInfo),
  "bf.insert": spec(-4, ["write"], bloomCommands.bfInsert),
  "bf.loadchunk": spec(4, ["write"], bloomCommands.bfLoadchunk),
  "bf.madd": spec(-3, ["write"], (ctx, args) => bloomCommands.bfAdd(ctx, args, true)),
  "bf.mexists": spec(-3, ["readonly", "fast"], (ctx, args) => bloomCommands.bfExists(ctx, args, true)),
  "bf.reserve": spec(-4, ["write"], bloomCommands.bfReserve),
  "bf.scandump": spec(3, ["readonly", "fast"], bloomCommands.bfScandump),

  "cf.add": spec(3, ["write"], (ctx, args) => cuckooCommands.cfAdd(ctx, args, false)),
  "cf.addnx": spec(3, ["write"], (ctx, args) => cuckooCommands.cfAdd(ctx, args, true)),
  "cf.compact": spec(2, ["readonly", "fast"], cuckooCommands.cfCompact),
  "cf.count": spec(3, ["readonly", "fast"], (ctx, args) => cuckooCommands.cfCheck(ctx, args, false, true)),
  "cf.debug": spec(2, ["readonly", "fast"], cuckooCommands.cfDebug),
  "cf.del": spec(3, ["write", "fast"], cuckooCommands.cfDel),
  "cf.exists": spec(3, ["readonly", "fast"], (ctx, args) => cuckooCommands.cfCheck(ctx, args, false, false)),
  "cf.info": spec(2, ["readonly", "fast"], cuckooCommands.cfInfo),
  "cf.insert": spec(-4, ["write"], (ctx, args) => cuckooCommands.cfInsert(ctx, args, false)),
  "cf.insertnx": spec(-4, ["write"], (ctx, args) => cuckooCommands.cfInsert(ctx, args, true)),
  "cf.loadchunk": spec(4, ["write"], cuckooCommands.cfLoadchunk),
  "cf.mexists": spec(-3, ["readonly", "fast"], (ctx, args) => cuckooCommands.cfCheck(ctx, args, true, false)),
  "cf.reserve": spec(-3, ["write"], cuckooCommands.cfReserve),
  "cf.scandump": spec(3, ["readonly", "fast"], cuckooCommands.cfScandump),

  "cms.incrby": spec(-4, ["write"], cmsCommands.cmsIncrBy),
  "cms.info": spec(2, ["readonly", "fast"], cmsCommands.cmsInfo),
  "cms.initbydim": spec(-4, ["write"], (ctx, args) => cmsCommands.cmsCreate(ctx, args, true)),
  "cms.initbyprob": spec(-4, ["write"], (ctx, args) => cmsCommands.cmsCreate(ctx, args, false)),
  "cms.merge": spec(-4, ["write"], cmsCommands.cmsMerge),
  "cms.query": spec(-3, ["readonly"], cmsCommands.cmsQuery),

  "topk.add": spec(-3, ["write"], topkCommands.topkAdd),
  "topk.count": spec(-3, ["readonly"], topkCommands.topkCount),
  "topk.incrby": spec(-4, ["write"], topkCommands.topkIncrby),
  "topk.info": spec(2, ["readonly", "fast"], topkCommands.topkInfo),
  "topk.list": spec(-2, ["readonly"], topkCommands.topkList),
  "topk.query": spec(-3, ["readonly"], topkCommands.topkQuery),
  "topk.reserve": spec(-3, ["write"], topkCommands.topkReserve),

  "tdigest.add": spec(-3, ["write"], tdigestCommands.tdigestAdd),
  "tdigest.byrank": spec(-3, ["readonly", "fast"], (ctx, args) => tdigestCommands.tdigestByRank(ctx, args, false)),
  "tdigest.byrevrank": spec(-3, ["readonly", "fast"], (ctx, args) => tdigestCommands.tdigestByRank(ctx, args, true)),
  "tdigest.cdf": spec(-3, ["readonly", "fast"], tdigestCommands.tdigestCdf),
  "tdigest.create": spec(-2, ["write"], tdigestCommands.tdigestCreate),
  "tdigest.info": spec(2, ["readonly", "fast"], tdigestCommands.tdigestInfo),
  "tdigest.max": spec(2, ["readonly", "fast"], (ctx, args) => tdigestCommands.tdigestMinMax(ctx, args, true)),
  "tdigest.merge": spec(-4, ["write"], tdigestCommands.tdigestMerge),
  "tdigest.min": spec(2, ["readonly", "fast"], (ctx, args) => tdigestCommands.tdigestMinMax(ctx, args, false)),
  "tdigest.quantile": spec(-3, ["readonly", "fast"], tdigestCommands.tdigestQuantile),
  "tdigest.rank": spec(-3, ["readonly", "fast"], (ctx, args) => tdigestCommands.tdigestRank(ctx, args, false)),
  "tdigest.reset": spec(2, ["write"], tdigestCommands.tdigestReset),
  "tdigest.revrank": spec(-3, ["readonly", "fast"], (ctx, args) => tdigestCommands.tdigestRank(ctx, args, true)),
  "tdigest.trimmed_mean": spec(4, ["readonly"], tdigestCommands.tdigestTrimmedMean),
};
