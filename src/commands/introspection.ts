import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { keyless } from "./types";
import type { Ctx, Spec, Table } from "./types";

export const CONNECTION_COMMANDS = [
  "multi", "exec", "discard", "watch", "unwatch", "reset",
  "subscribe", "unsubscribe", "psubscribe", "punsubscribe", "ssubscribe", "sunsubscribe",
];

const CONNECTION_SPEC: Pick<Spec, "arity" | "flags"> = { arity: -1, flags: ["noscript"] };

function info(table: Table, name: string): Reply {
  const spec = table[name] ?? CONNECTION_SPEC;
  const [first, last, step] = spec.keys ?? [0, 0, 0];
  return r.array([r.bulk(name), r.int(spec.arity), r.set(spec.flags.map((f) => r.simple(f))), r.int(first), r.int(last), r.int(step),
    r.set([]), r.array([]), r.array([]), r.array([])]);
}

export function commandSpec(table: () => Table): Spec {
  return keyless(-1, [], (_: Ctx, args: Array<Uint8Array>) => {
    const commands = table();
    const names = [...Object.keys(commands), ...CONNECTION_COMMANDS];
    const sub = args.length > 1 ? text(args[1]).toUpperCase() : "";
    if (sub === "") return r.array(names.map((n) => info(commands, n)));
    if (sub === "COUNT") return r.int(names.length);
    if (sub === "LIST") return r.bulks(names);
    if (sub === "DOCS") return r.map([]);
    if (sub !== "INFO") throw new RedisError(`ERR unknown subcommand '${text(args[1])}'. Try COMMAND HELP.`);
    return r.array(args.slice(2).map((a) => {
      const name = text(a).toLowerCase();
      return names.includes(name) ? info(commands, name) : r.nilArray;
    }));
  });
}
