import { getRuntime } from "../lua/runtime";
import { r, RedisError, text } from "../resp/reply";
import type { Reply } from "../resp/reply";
import { opt } from "./args";
import type { Ctx, Table } from "./types";

const SCRIPT_HELP = [
  "SCRIPT <subcommand> [<arg> [value] [opt] ...]. Subcommands are:",
  "DEBUG (YES|SYNC|NO)",
  "    Set the debug mode for subsequent scripts executed.",
  "EXISTS <sha1> [<sha1> ...]",
  "    Return information about the existence of the scripts in the script cache.",
  "FLUSH [ASYNC|SYNC]",
  "    Flush the Lua scripts cache. Very dangerous on replicas.",
  "    When called without the optional mode argument, the behavior is determined by the",
  "    lazyfree-lazy-user-flush configuration directive. Valid modes are:",
  "    * ASYNC: Asynchronously flush the scripts cache.",
  "    * SYNC: Synchronously flush the scripts cache.",
  "KILL",
  "    Kill the currently executing Lua script.",
  "LOAD <script>",
  "    Load a script into the scripts cache without executing it.",
  "HELP",
  "    Print this help.",
];

const FUNCTION_HELP = [
  "FUNCTION <subcommand> [<arg> [value] [opt] ...]. Subcommands are:",
  "LOAD [REPLACE] <FUNCTION CODE>",
  "    Create a new library with the given library name and code.",
  "DELETE <LIBRARY NAME>",
  "    Delete the given library.",
  "LIST [LIBRARYNAME PATTERN] [WITHCODE]",
  "    Return general information on all the libraries:",
  "    * Library name",
  "    * The engine used to run the Library",
  "    * Functions list",
  "    * Library code (if WITHCODE is given)",
  "    It also possible to get only function that matches a pattern using LIBRARYNAME argument.",
  "STATS",
  "    Return information about the current function running:",
  "    * Function name",
  "    * Command used to run the function",
  "    * Duration in MS that the function is running",
  "    If no function is running, return nil",
  "    In addition, returns a list of available engines.",
  "KILL",
  "    Kill the current running function.",
  "FLUSH [ASYNC|SYNC]",
  "    Delete all the libraries.",
  "    When called without the optional mode argument, the behavior is determined by the",
  "    lazyfree-lazy-user-flush configuration directive. Valid modes are:",
  "    * ASYNC: Asynchronously flush the libraries.",
  "    * SYNC: Synchronously flush the libraries.",
  "DUMP",
  "    Return a serialized payload representing the current libraries, can be restored using FUNCTION RESTORE command",
  "RESTORE <PAYLOAD> [FLUSH|APPEND|REPLACE]",
  "    Restore the libraries represented by the given payload, it is possible to give a restore policy to",
  "    control how to handle existing libraries (default APPEND):",
  "    * FLUSH: delete all existing libraries.",
  "    * APPEND: appends the restored libraries to the existing libraries. On collision, abort.",
  "    * REPLACE: appends the restored libraries to the existing libraries, On collision, replace the old",
  "      libraries with the new libraries (notice that even on this option there is a chance of failure",
  "      in case of functions name collision with another library).",
  "HELP",
  "    Print this help.",
];

function scriptCmd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const rawSub = text(args[1]);
  const sub = rawSub.toUpperCase();
  if (sub === "HELP") {
    if (args.length !== 2) return r.error("ERR wrong number of arguments for 'script|help' command");
    return r.array(SCRIPT_HELP.map((line) => r.simple(line)));
  }
  if (sub === "FLUSH") {
    if (args.length > 3) return r.error("ERR SCRIPT FLUSH only support SYNC|ASYNC option");
    if (args.length === 3) {
      const mode = opt(args[2]);
      if (mode !== "SYNC" && mode !== "ASYNC") return r.error("ERR SCRIPT FLUSH only support SYNC|ASYNC option");
    }
    return getRuntime(ctx).scriptFlush(ctx);
  }
  if (sub === "EXISTS") {
    if (args.length < 3) return r.error("ERR wrong number of arguments for 'script|exists' command");
    return getRuntime(ctx).scriptExists(args.slice(2));
  }
  if (sub === "LOAD") {
    if (args.length !== 3) return r.error("ERR wrong number of arguments for 'script|load' command");
    return getRuntime(ctx).scriptLoad(ctx, args[2]);
  }
  if (sub === "KILL") {
    if (args.length !== 2) return r.error("ERR wrong number of arguments for 'script|kill' command");
    return r.error("NOTBUSY No scripts in execution right now.");
  }
  if (sub === "DEBUG") {
    if (args.length !== 3) return r.error("ERR wrong number of arguments for 'script|debug' command");
    if (text(args[2]).toUpperCase() === "NO") return r.ok;
    throw new RedisError("ERR duraredis: the Lua debugger is not supported");
  }
  return r.error(`ERR unknown subcommand '${rawSub}'. Try SCRIPT HELP.`);
}

function functionLoadCmd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length < 3) return r.error("ERR wrong number of arguments for 'function|load' command");
  let replace = false;
  let pos = 2;
  while (pos < args.length - 1) {
    const raw = text(args[pos++]);
    if (raw.toUpperCase() === "REPLACE") {
      replace = true;
      continue;
    }
    return r.error(`ERR Unknown option given: ${raw}`);
  }
  return getRuntime(ctx).functionLoad(ctx, args[pos], replace);
}

function functionListCmd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  let withCode = false;
  let pattern: Uint8Array | null = null;
  for (let i = 2; i < args.length; i++) {
    const raw = text(args[i]);
    const upper = raw.toUpperCase();
    if (!withCode && upper === "WITHCODE") {
      withCode = true;
      continue;
    }
    if (!pattern && upper === "LIBRARYNAME") {
      if (i >= args.length - 1) return r.error("ERR library name argument was not given");
      pattern = args[++i];
      continue;
    }
    return r.error(`ERR Unknown argument ${raw}`);
  }
  return getRuntime(ctx).functionList(pattern, withCode);
}

function functionRestoreCmd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  if (args.length < 3) return r.error("ERR wrong number of arguments for 'function|restore' command");
  if (args.length > 4) {
    return r.error(`ERR unknown subcommand or wrong number of arguments for '${text(args[1])}'. Try FUNCTION HELP.`);
  }
  let policy: "APPEND" | "REPLACE" | "FLUSH" = "APPEND";
  if (args.length === 4) {
    const p = opt(args[3]);
    if (p === "APPEND" || p === "REPLACE" || p === "FLUSH") policy = p;
    else return r.error("ERR Wrong restore policy given, value should be either FLUSH, APPEND or REPLACE.");
  }
  return getRuntime(ctx).functionRestore(ctx, args[2], policy);
}

function functionCmd(ctx: Ctx, args: Array<Uint8Array>): Reply {
  const rawSub = text(args[1]);
  const sub = rawSub.toUpperCase();
  switch (sub) {
    case "LOAD":
      return functionLoadCmd(ctx, args);
    case "DELETE":
      if (args.length !== 3) return r.error("ERR wrong number of arguments for 'function|delete' command");
      return getRuntime(ctx).functionDelete(ctx, text(args[2]));
    case "LIST":
      return functionListCmd(ctx, args);
    case "FLUSH":
      if (args.length > 3) {
        return r.error(`ERR unknown subcommand or wrong number of arguments for '${rawSub}'. Try FUNCTION HELP.`);
      }
      if (args.length === 3) {
        const mode = opt(args[2]);
        if (mode !== "SYNC" && mode !== "ASYNC") return r.error("ERR FUNCTION FLUSH only supports SYNC|ASYNC option");
      }
      return getRuntime(ctx).functionFlush(ctx);
    case "STATS":
      if (args.length !== 2) return r.error("ERR wrong number of arguments for 'function|stats' command");
      return getRuntime(ctx).functionStats();
    case "KILL":
      if (args.length !== 2) return r.error("ERR wrong number of arguments for 'function|kill' command");
      return r.error("NOTBUSY No scripts in execution right now.");
    case "DUMP":
      if (args.length !== 2) return r.error("ERR wrong number of arguments for 'function|dump' command");
      return getRuntime(ctx).functionDump();
    case "RESTORE":
      return functionRestoreCmd(ctx, args);
    case "HELP":
      if (args.length !== 2) {
        return r.error("ERR wrong number of arguments for 'function|help' command");
      }
      return r.array(FUNCTION_HELP.map((line) => r.simple(line)));
    default:
      return r.error(`ERR unknown subcommand '${rawSub}'. Try FUNCTION HELP.`);
  }
}

export const scripting: Table = {
  eval: { arity: -3, flags: ["write", "noscript"], run: (ctx, args) => getRuntime(ctx).evalScript(ctx, args, false, false) },
  evalsha: { arity: -3, flags: ["write", "noscript"], run: (ctx, args) => getRuntime(ctx).evalScript(ctx, args, true, false) },
  eval_ro: { arity: -3, flags: ["readonly", "noscript"], run: (ctx, args) => getRuntime(ctx).evalScript(ctx, args, false, true) },
  evalsha_ro: { arity: -3, flags: ["readonly", "noscript"], run: (ctx, args) => getRuntime(ctx).evalScript(ctx, args, true, true) },
  fcall: { arity: -3, flags: ["write", "noscript"], run: (ctx, args) => getRuntime(ctx).fcall(ctx, args, false) },
  fcall_ro: { arity: -3, flags: ["readonly", "noscript"], run: (ctx, args) => getRuntime(ctx).fcall(ctx, args, true) },
  script: { arity: -2, flags: ["noscript"], run: scriptCmd },
  function: { arity: -2, flags: ["noscript"], run: functionCmd },
};
