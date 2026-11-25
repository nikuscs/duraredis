import { expect, test } from "bun:test";
import { describeDual } from "./dual";

describeDual("lists, sets, sorted sets, blocking and pub/sub vs redis:8", (run) => {
  test("lists", () => run(async (s) => {
    await s.script([
      ["RPUSH", "l", "a", "b", "c"], ["LPUSH", "l", "z", "y"], ["LRANGE", "l", "0", "-1"], ["LLEN", "l"],
      ["LINDEX", "l", "0"], ["LINDEX", "l", "-1"], ["LINDEX", "l", "99"], ["LINDEX", "l", "x"],
      ["LINSERT", "l", "BEFORE", "b", "x"], ["LINSERT", "l", "AFTER", "c", "w"], ["LINSERT", "l", "AFTER", "nope", "w"],
      ["LINSERT", "missing", "AFTER", "a", "w"], ["LINSERT", "l", "MIDDLE", "a", "w"], ["LRANGE", "l", "0", "-1"],
      ["LSET", "l", "1", "Z"], ["LSET", "l", "-1", "W"], ["LSET", "l", "99", "x"], ["LSET", "missing", "0", "x"],
      ["LRANGE", "l", "1", "3"], ["LRANGE", "l", "-3", "-1"], ["LRANGE", "l", "5", "1"], ["LRANGE", "l", "-100", "100"],
      ["RPUSH", "r", "a", "b", "a", "c", "a"], ["LREM", "r", "2", "a"], ["LRANGE", "r", "0", "-1"], ["LREM", "r", "-1", "a"],
      ["LREM", "r", "0", "zz"], ["LRANGE", "r", "0", "-1"], ["LPOS", "r", "b"], ["LPOS", "r", "nope"],
      ["RPUSH", "p", "a", "b", "c", "a", "b", "a"], ["LPOS", "p", "a", "RANK", "2"], ["LPOS", "p", "a", "RANK", "-1"],
      ["LPOS", "p", "a", "COUNT", "0"], ["LPOS", "p", "a", "COUNT", "2", "RANK", "-1"], ["LPOS", "p", "a", "MAXLEN", "3", "COUNT", "0"],
      ["LPOS", "p", "a", "RANK", "0"], ["LPOS", "p", "a", "COUNT", "-1"], ["LPOS", "missing", "a", "COUNT", "1"],
      ["LTRIM", "p", "1", "-2"], ["LRANGE", "p", "0", "-1"], ["LTRIM", "p", "9", "10"], ["EXISTS", "p"],
      ["LPOP", "l"], ["RPOP", "l"], ["LPOP", "l", "2"], ["RPOP", "l", "0"], ["LPOP", "l", "-1"], ["LPOP", "missing"], ["LPOP", "missing", "2"],
      ["LPUSHX", "missing", "a"], ["RPUSHX", "l", "q"], ["EXISTS", "missing"],
      ["RPUSH", "src", "1", "2", "3"], ["LMOVE", "src", "dst", "LEFT", "RIGHT"], ["LMOVE", "src", "dst", "RIGHT", "LEFT"],
      ["RPOPLPUSH", "src", "dst"], ["LRANGE", "dst", "0", "-1"], ["EXISTS", "src"], ["LMOVE", "src", "dst", "UP", "LEFT"],
      ["RPUSH", "self", "a", "b"], ["LMOVE", "self", "self", "LEFT", "RIGHT"], ["LRANGE", "self", "0", "-1"],
      ["LMPOP", "2", "none", "dst", "LEFT", "COUNT", "2"], ["LMPOP", "1", "dst", "RIGHT"], ["LMPOP", "0", "dst", "LEFT"],
      ["LMPOP", "1", "dst", "LEFT", "COUNT", "0"], ["LMPOP", "1", "none", "LEFT"],
      ["SET", "str", "x"], ["LPUSH", "str", "a"], ["LRANGE", "str", "0", "1"], ["TYPE", "dst"], ["OBJECT", "x"], ["OBJECT", "ENCODING", "dst"], ["OBJECT", "ENCODING", "str"], ["OBJECT", "ENCODING", "missing"],
    ]);
  }));

  test("sets", () => run(async (s) => {
    await s.script([
      ["SADD", "n", "3", "1", "2", "1"], ["SMEMBERS", "n"], ["SCARD", "n"], ["SISMEMBER", "n", "2"], ["SISMEMBER", "n", "9"],
      ["SMISMEMBER", "n", "1", "9", "3"], ["SADD", "w", "b", "a", "c"], ["SMEMBERS", "w"], ["SREM", "w", "a", "zz"], ["SMEMBERS", "w"],
      ["SADD", "x", "1", "2", "4"], ["SINTER", "n", "x"], ["SUNION", "n", "x"], ["SDIFF", "n", "x"], ["SINTER", "n", "missing"],
      ["SINTERSTORE", "dst", "n", "x"], ["SMEMBERS", "dst"], ["SUNIONSTORE", "dst", "n", "x"], ["SMEMBERS", "dst"],
      ["SDIFFSTORE", "dst", "missing", "n"], ["EXISTS", "dst"], ["SINTERCARD", "2", "n", "x"], ["SINTERCARD", "2", "n", "x", "LIMIT", "1"],
      ["SINTERCARD", "0", "n"], ["SINTERCARD", "3", "n"], ["SINTERCARD", "1", "n", "LIMIT", "-1"],
      ["SMOVE", "n", "x", "3"], ["SMOVE", "n", "x", "99"], ["SMEMBERS", "x"], ["SMOVE", "x", "x", "4"],
      ["SREM", "w", "b", "c"], ["EXISTS", "w"], ["SPOP", "missing"], ["SPOP", "missing", "2"], ["SRANDMEMBER", "missing"],
      ["SRANDMEMBER", "missing", "3"], ["SPOP", "n", "-1"], ["SET", "str", "v"], ["SADD", "str", "a"], ["SUNION", "n", "str"],
      ["SSCAN", "n", "0"], ["SSCAN", "missing", "0"], ["TYPE", "x"], ["OBJECT", "ENCODING", "x"], ["SADD", "x", "word"], ["OBJECT", "ENCODING", "x"],
    ]);
    await s.cmd("SADD", "one", "only");
    await s.cmd("SPOP", "one");
    await s.cmd("EXISTS", "one");
    const big = Array.from({ length: 200 }, (_, i) => `m${i}`);
    await s.cmd("SADD", "big", ...big);
    await s.unordered("SMEMBERS", "big");
    const [rv, dv] = await s.shape("SPOP", "big", "3");
    expect(dv.kind === "set" || dv.kind === "array" ? dv.items.length : -1).toBe(rv.kind === "set" || rv.kind === "array" ? rv.items.length : -2);
    await s.cmd("SCARD", "big");
  }));

  test("sorted sets", () => run(async (s) => {
    await s.script([
      ["ZADD", "z", "1", "a", "2", "b", "3", "c", "1.5", "d", "-inf", "lo", "+inf", "hi"], ["ZCARD", "z"],
      ["ZRANGE", "z", "0", "-1"], ["ZRANGE", "z", "0", "-1", "WITHSCORES"], ["ZREVRANGE", "z", "0", "2", "WITHSCORES"],
      ["ZSCORE", "z", "d"], ["ZSCORE", "z", "hi"], ["ZSCORE", "z", "nope"], ["ZMSCORE", "z", "a", "nope", "lo"],
      ["ZRANK", "z", "c"], ["ZREVRANK", "z", "c"], ["ZRANK", "z", "c", "WITHSCORE"], ["ZRANK", "z", "nope", "WITHSCORE"],
      ["ZRANGEBYSCORE", "z", "(1", "3"], ["ZRANGEBYSCORE", "z", "-inf", "+inf", "WITHSCORES", "LIMIT", "1", "2"],
      ["ZREVRANGEBYSCORE", "z", "3", "(1"], ["ZRANGEBYSCORE", "z", "x", "1"], ["ZCOUNT", "z", "(1", "+inf"],
      ["ZRANGE", "z", "(1", "3", "BYSCORE"], ["ZRANGE", "z", "3", "(1", "BYSCORE", "REV", "WITHSCORES"],
      ["ZRANGE", "z", "0", "-1", "LIMIT", "0", "1"], ["ZRANGE", "z", "-", "+", "BYLEX", "WITHSCORES"],
      ["ZADD", "lex", "0", "a", "0", "b", "0", "c", "0", "d"], ["ZRANGEBYLEX", "lex", "[b", "(d"], ["ZRANGEBYLEX", "lex", "-", "+", "LIMIT", "1", "2"],
      ["ZREVRANGEBYLEX", "lex", "+", "[b"], ["ZLEXCOUNT", "lex", "(a", "+"], ["ZRANGEBYLEX", "lex", "b", "c"], ["ZRANGE", "lex", "[b", "[c", "BYLEX"],
      ["ZINCRBY", "z", "0.1", "a"], ["ZINCRBY", "z", "1", "new"], ["ZADD", "z", "INCR", "5", "a"], ["ZADD", "z", "NX", "INCR", "5", "a"],
      ["ZADD", "z", "XX", "CH", "10", "a", "20", "zz"], ["ZADD", "z", "GT", "CH", "1", "b", "9", "c"], ["ZADD", "z", "LT", "0", "c"],
      ["ZADD", "z", "NX", "XX", "1", "a"], ["ZADD", "z", "GT", "LT", "1", "a"], ["ZADD", "z", "NX", "GT", "1", "a"], ["ZADD", "z", "INCR", "1", "a", "2", "b"],
      ["ZADD", "z", "x", "a"], ["ZADD", "z", "1"], ["ZADD", "z", "nan", "a"], ["ZADD", "z", "+inf", "hi"], ["ZINCRBY", "z", "-inf", "hi"],
      ["ZRANGE", "z", "0", "-1", "WITHSCORES"], ["ZREM", "z", "a", "nope"], ["ZPOPMIN", "z"], ["ZPOPMAX", "z", "2"], ["ZPOPMIN", "z", "0"],
      ["ZPOPMIN", "missing"], ["ZPOPMAX", "z", "-1"],
      ["ZADD", "s1", "1", "a", "2", "b"], ["ZADD", "s2", "10", "b", "20", "c"], ["SADD", "plain", "a", "c"],
      ["ZUNIONSTORE", "u", "2", "s1", "s2"], ["ZRANGE", "u", "0", "-1", "WITHSCORES"],
      ["ZUNIONSTORE", "u", "2", "s1", "s2", "WEIGHTS", "2", "0.5", "AGGREGATE", "MAX"], ["ZRANGE", "u", "0", "-1", "WITHSCORES"],
      ["ZINTERSTORE", "i", "2", "s1", "s2"], ["ZRANGE", "i", "0", "-1", "WITHSCORES"], ["ZINTERSTORE", "i", "2", "s1", "plain", "AGGREGATE", "MIN"],
      ["ZRANGE", "i", "0", "-1", "WITHSCORES"], ["ZDIFFSTORE", "df", "2", "s1", "s2"], ["ZRANGE", "df", "0", "-1", "WITHSCORES"],
      ["ZUNION", "2", "s1", "s2", "WITHSCORES"], ["ZINTER", "2", "s1", "s2"], ["ZDIFF", "2", "s2", "s1", "WITHSCORES"],
      ["ZINTERCARD", "2", "s1", "s2"], ["ZINTERCARD", "2", "s1", "s2", "LIMIT", "0"], ["ZUNIONSTORE", "u", "0", "s1"],
      ["ZUNIONSTORE", "u", "2", "s1"], ["ZUNIONSTORE", "u", "1", "s1", "WEIGHTS", "x"], ["ZUNIONSTORE", "u", "1", "s1", "AGGREGATE", "AVG"],
      ["ZRANGESTORE", "rs", "s2", "0", "0"], ["ZRANGE", "rs", "0", "-1", "WITHSCORES"],
      ["ZADD", "rm", "1", "a", "2", "b", "3", "c", "4", "d", "5", "e"], ["ZREMRANGEBYRANK", "rm", "0", "1"], ["ZREMRANGEBYSCORE", "rm", "(3", "4"],
      ["ZRANGE", "rm", "0", "-1"], ["ZADD", "rl", "0", "a", "0", "b", "0", "c"], ["ZREMRANGEBYLEX", "rl", "[a", "(c"], ["ZRANGE", "rl", "0", "-1"],
      ["ZMPOP", "2", "none", "s2", "MAX", "COUNT", "5"], ["ZMPOP", "1", "none", "MIN"], ["EXISTS", "s2"],
      ["ZSCAN", "s1", "0"], ["ZRANDMEMBER", "missing"], ["ZRANDMEMBER", "missing", "2", "WITHSCORES"],
      ["ZADD", "f", "0.1", "a", "1e20", "b", "123456789.25", "c", "-0.000001", "d", "1e-10", "e", "100000000", "g", "12345678", "h"],
      ["ZRANGE", "f", "0", "-1", "WITHSCORES"], ["ZSCORE", "f", "b"], ["SET", "str", "v"], ["ZADD", "str", "1", "a"], ["ZUNIONSTORE", "u", "1", "str"],
    ]);
  }));

  test("blocking pops serve the oldest waiter and time out", () => run(async (s) => {
    const a = await s.peer();
    const b = await s.peer();
    await a.send("BLPOP", "q", "0");
    await b.send("BRPOP", "q", "other", "0");
    await Bun.sleep(100);
    await s.cmd("RPUSH", "q", "one", "two");
    await a.next("BLPOP served first");
    await b.next("BRPOP served second");
    await s.cmd("LLEN", "q");
    await a.cmd("BLPOP", "empty", "0.1");
    await a.cmd("BLPOP", "q", "-1");
    await a.cmd("BLPOP", "q", "x");
    await b.send("BLMOVE", "src", "dst", "LEFT", "RIGHT", "0");
    await Bun.sleep(100);
    await s.cmd("LPUSH", "src", "v");
    await b.next("BLMOVE served");
    await s.cmd("LRANGE", "dst", "0", "-1");
    await a.send("BZPOPMIN", "zq", "0");
    await Bun.sleep(100);
    await s.cmd("ZADD", "zq", "2", "b", "1", "a");
    await a.next("BZPOPMIN served");
    await b.send("BLMPOP", "0", "2", "l1", "l2", "RIGHT", "COUNT", "2");
    await Bun.sleep(100);
    await s.cmd("RPUSH", "l2", "x", "y", "z");
    await b.next("BLMPOP served");
    await s.script([["MULTI"], ["BLPOP", "none", "0"], ["EXEC"]]);
  }));

  test("pub/sub", () => run(async (s) => {
    const sub = await s.peer();
    await sub.cmd("SUBSCRIBE", "news", "sport");
    await sub.next("second subscribe reply");
    await sub.cmd("PSUBSCRIBE", "n*");
    await s.cmd("PUBLISH", "news", "hello");
    await sub.next("message");
    await sub.next("pmessage");
    await s.cmd("PUBLISH", "nothing", "x");
    await sub.next("pmessage only");
    await s.cmd("PUBSUB", "NUMSUB", "news", "none");
    await s.cmd("PUBSUB", "NUMPAT");
    await s.unordered("PUBSUB", "CHANNELS");
    await s.cmd("PUBSUB", "CHANNELS", "s*");
    if (s.proto === 2) {
      await sub.cmd("GET", "x");
      await sub.cmd("PING");
      await sub.cmd("PING", "hi");
    }
    await sub.cmd("UNSUBSCRIBE", "news");
    await sub.cmd("PUNSUBSCRIBE");
    await sub.cmd("UNSUBSCRIBE");
    await sub.cmd("UNSUBSCRIBE");
    await sub.cmd("PING");
    await sub.cmd("SSUBSCRIBE", "shard");
    await s.cmd("SPUBLISH", "shard", "m");
    await sub.next("smessage");
    await s.cmd("PUBSUB", "SHARDNUMSUB", "shard");
    await sub.cmd("SUNSUBSCRIBE");
    await sub.cmd("SUBSCRIBE");
    await s.cmd("PUBSUB", "NOPE");
    await s.script([["MULTI"], ["SUBSCRIBE", "inside"], ["EXEC"]]);
  }));
});
