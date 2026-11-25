import { geo } from "./geo";
import { hashes } from "./hashes";
import { himports } from "./himport";
import { hyperloglog } from "./hyperloglog";
import { commandSpec } from "./introspection";
import { keys } from "./keys";
import { jsonCommands } from "./json";
import { lists } from "./lists";
import { moves } from "./moves";
import { adminCommands } from "./admin";
import { arrays } from "./arrays";
import { bitmaps } from "./bitmaps";
import { dumps } from "./dump";
import { objects } from "./object";
import { probabilistic } from "./probabilistic";
import { pubsub } from "./pubsub";
import { scripting } from "./scripting";
import { server } from "./server";
import { sets } from "./sets";
import { sorting } from "./sort";
import { streams } from "./streams";
import { strings } from "./strings";
import { stringExtensions } from "./strings-ex";
import { timeseries } from "./timeseries";
import type { Table } from "./types";
import { vectorset } from "./vectorset";
import { zsets } from "./zsets";

export const COMMANDS: Table = {
  ...server, ...keys, ...strings, ...stringExtensions, ...bitmaps, ...hyperloglog, ...hashes, ...himports, ...lists, ...sets, ...zsets, ...moves, ...sorting, ...geo, ...streams, ...pubsub, ...objects, ...scripting,
  ...jsonCommands, ...probabilistic, ...timeseries, ...vectorset, ...arrays, ...dumps,
  ...adminCommands(() => COMMANDS),
  command: commandSpec(() => COMMANDS),
};
