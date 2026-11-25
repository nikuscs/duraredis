import { test } from "bun:test";
import { describeDual } from "./dual";

describeDual("Redis 8 core commands vs redis:8", (run) => {
  test("string conditions, digests, MSETEX and INCREX", () => run(async (s) => {
    const long = "x".repeat(3000);
    await s.script([
      ["SET", "k", "v"], ["SET", "k", "w", "IFEQ", "v"], ["GET", "k"], ["SET", "k", "z", "IFEQ", "nope"], ["SET", "k", "z", "IFNE", "w"],
      ["SET", "k", "z", "IFNE", "nope"], ["SET", "nokey", "z", "IFEQ", "v"], ["SET", "nokey", "z", "IFNE", "v"], ["DIGEST", "k"],
      ["SET", "k", "q", "IFDEQ", "54a7d9dde88eadb0"], ["GET", "k"], ["SET", "k", "r", "IFDEQ", "9555e8555c62dcfd"], ["SET", "k", "r", "IFDNE", "9555E8555C62DCFD"],
      ["SET", "k", "q", "IFDNE", "0000"], ["SET", "k", "q", "IFEQ", "z", "NX"], ["SET", "k", "q", "IFEQ", "z", "IFNE", "z"], ["SET", "k", "s", "IFEQ", "r", "GET"],
      ["HSET", "hh", "a", "1"], ["SET", "hh", "x", "IFEQ", "1"], ["SET", "k", "q", "IFDEQ", "XYZ"], ["DIGEST", "nokey"], ["DIGEST", "hh"],
      ["SET", "e", ""], ["DIGEST", "e"], ["SET", "long", long], ["DIGEST", "long"], ["SET", "n", "5"], ["DIGEST", "n"],
      ["DELEX", "missing"], ["SET", "a", "v"], ["DELEX", "a", "IFEQ", "x"], ["DELEX", "a", "IFEQ", "v"], ["SET", "a", "v"], ["DELEX", "a", "IFNE", "v"],
      ["DELEX", "a", "IFDEQ", "39d8c4b1a1b8c4a7"], ["DELEX", "a", "IFDNE", "39d8c4b1a1b8c4a7"], ["SET", "a", "v"], ["DELEX", "a", "FOO", "x"],
      ["DELEX", "a", "IFDEQ", "zz"], ["DELEX", "a", "ifeq", "v"], ["DELEX", "hh", "IFDEQ", "zz"], ["DELEX", "hh", "IFEQ", "v", "IFNE", "v"], ["DELEX", "hh", "IFEQ"], ["DELEX", "hh"],
      ["MSETEX", "2", "a", "1", "b", "2"], ["TTL", "a"], ["MSETEX", "2", "a", "1", "b", "2", "EX", "100"], ["TTL", "b"], ["MSETEX", "2", "a", "1", "c", "3", "NX"],
      ["MSETEX", "1", "c", "3", "NX", "EX", "50"], ["TTL", "c"], ["MSETEX", "2", "a", "1", "c", "3", "XX"], ["TTL", "c"], ["MSETEX", "1", "b", "9", "XX", "KEEPTTL"], ["TTL", "b"],
      ["MSETEX", "1", "a", "9", "EX", "0"], ["MSETEX", "0", "a", "1"], ["MSETEX", "2", "a", "1"], ["MSETEX", "x", "a", "1"], ["MSETEX", "1", "a", "1", "NX", "XX"],
      ["MSETEX", "1", "a", "1", "EX", "1", "PX", "1"], ["MSETEX", "1", "a", "1", "EX", "10", "EX", "10"], ["HSET", "hh", "f", "v"], ["MSETEX", "1", "hh", "v"], ["TYPE", "hh"],
      ["MSETEX", "2", "a", "1", "a", "2"], ["GET", "a"], ["MSETEX", "1", "a", "1", "FOO"],
      ["SET", "n", "5"], ["INCREX", "n"], ["INCREX", "n", "BYINT", "10"], ["INCREX", "n", "BYFLOAT", "1.5"], ["SET", "f", "1.5"], ["INCREX", "f", "BYFLOAT", "1.25"],
      ["INCREX", "f"], ["INCREX", "newkey"], ["INCREX", "nk2", "BYINT", "5", "EX", "100"], ["TTL", "nk2"], ["INCREX", "nk2", "BYINT", "1", "ENX", "EX", "5"], ["TTL", "nk2"],
      ["INCREX", "nk2", "PERSIST"], ["TTL", "nk2"], ["INCREX", "nk2", "ENX", "EX", "30"], ["TTL", "nk2"], ["INCREX", "nk2", "BYINT", "100", "UBOUND", "50"],
      ["INCREX", "nk2", "BYINT", "100", "UBOUND", "50", "SATURATE"], ["INCREX", "nk2", "BYINT", "-1000", "LBOUND", "0"], ["INCREX", "nk2", "BYINT", "-1000", "LBOUND", "0", "SATURATE"],
      ["SET", "big", "9223372036854775807"], ["INCREX", "big"], ["INCREX", "big", "SATURATE"], ["INCREX", "n", "BYINT", "1", "BYFLOAT", "1"], ["INCREX", "n", "BYINT", "x"],
      ["INCREX", "n", "BYFLOAT", "x"], ["INCREX", "n", "ENX"], ["INCREX", "n", "ENX", "PERSIST"], ["SET", "s", "abc"], ["INCREX", "s"], ["INCREX", "s", "BYFLOAT", "1"],
      ["INCREX", "nk3", "BYFLOAT", "0.1", "EX", "0"], ["INCREX", "n", "BYINT", "1", "EX", "-1"], ["INCREX", "n", "LBOUND", "10", "UBOUND", "5"],
      ["INCREX", "n", "BYFLOAT", "1", "UBOUND", "1.5", "SATURATE"], ["INCREX", "n", "BYINT", "1", "UBOUND", "1.5"], ["INCREX", "n", "BYFLOAT", "1", "LBOUND", "x"],
      ["INCREX", "hh"], ["INCREX", "n", "BYFLOAT", "0.1", "LBOUND", "-1e3", "UBOUND", "1e3"], ["INCREX", "n", "FOO"],
    ]);
  }));

  test("multi-element list and sorted set moves", () => run(async (s) => {
    await s.script([
      ["RPUSH", "qa", "a", "b", "c", "d"], ["LMOVEM", "qa", "qb", "LEFT", "RIGHT"], ["LMOVEM", "qa", "qb", "LEFT", "RIGHT", "COUNT", "2", "BULK"],
      ["LRANGE", "qb", "0", "-1"], ["LMOVEM", "qa", "qb", "LEFT", "RIGHT", "COUNT", "5", "BULK"], ["EXISTS", "qa"],
      ["RPUSH", "qc", "a", "b", "c", "d"], ["LMOVEM", "qc", "qd", "LEFT", "LEFT", "COUNT", "3", "OBO"], ["LRANGE", "qd", "0", "-1"],
      ["RPUSH", "qe", "a", "b", "c", "d"], ["LMOVEM", "qe", "qf", "RIGHT", "LEFT", "COUNT", "3", "BULK"], ["LRANGE", "qf", "0", "-1"],
      ["RPUSH", "qs", "a", "b", "c", "d"], ["LMOVEM", "qs", "qt", "RIGHT", "RIGHT", "COUNT", "3", "OBO"], ["LRANGE", "qt", "0", "-1"],
      ["RPUSH", "qg", "1", "2"], ["LMOVEM", "qg", "qh", "LEFT", "RIGHT", "EXACTLY", "3", "BULK"], ["LMOVEM", "qg", "qh", "LEFT", "RIGHT", "EXACTLY", "2", "BULK"],
      ["LMOVEM", "missing", "qh", "LEFT", "RIGHT"], ["LMOVEM", "missing", "qh", "LEFT", "RIGHT", "COUNT", "2", "BULK"], ["LMOVEM", "qh", "qx", "LEFT", "RIGHT", "COUNT", "0", "BULK"],
      ["RPUSH", "qi", "a", "b", "c"], ["LMOVEM", "qi", "qi", "LEFT", "RIGHT", "COUNT", "2", "BULK"], ["LRANGE", "qi", "0", "-1"],
      ["LMOVEM", "qi", "qi", "LEFT", "RIGHT", "COUNT", "2", "OBO"], ["LRANGE", "qi", "0", "-1"], ["SET", "str", "v"], ["LMOVEM", "qi", "str", "LEFT", "RIGHT"],
      ["LMOVEM", "qi", "qj", "UP", "RIGHT"], ["LMOVEM", "qi", "qj", "LEFT", "RIGHT", "COUNT", "x", "BULK"], ["LMOVEM", "qi", "qj", "LEFT", "RIGHT", "BULK", "COUNT", "1"],
      ["LMOVEM", "qi", "qj", "LEFT", "RIGHT", "COUNT", "1"], ["LMOVEM", "qi", "qj", "LEFT", "RIGHT", "COUNT", "1", "BULK", "OBO"],
      ["BLMOVEM", "none", "qz", "LEFT", "RIGHT", "0.1", "COUNT", "2", "BULK"], ["BLMOVEM", "none", "qz", "LEFT", "RIGHT", "-1"],
      ["ZADD", "za", "1", "a", "2", "b", "3", "c", "4", "d"], ["ZMOVE", "za", "zb", "MIN"], ["ZMOVE", "za", "zb", "MAX", "COUNT", "2"], ["ZRANGE", "zb", "0", "-1", "WITHSCORES"],
      ["ZMOVE", "za", "zb", "BYSCORE", "0", "10"], ["EXISTS", "za"], ["ZADD", "zc", "1", "a", "2", "b", "3", "c", "4", "d"], ["ZMOVE", "zc", "zd", "BYSCORE", "2", "3", "COUNT", "1"],
      ["ZMOVE", "zc", "zd", "BYSCORE", "(1", "+inf"], ["ZMOVE", "zc", "zd", "BYSCORE", "10", "20"], ["ZMOVE", "missing", "zd", "MIN"], ["ZMOVE", "zc", "zd", "MIN", "COUNT", "0"],
      ["ZMOVE", "zc", "zd", "BYSCORE", "x", "1"], ["ZADD", "ze", "5", "a"], ["ZADD", "zf", "1", "a"], ["ZMOVE", "ze", "zf", "MIN"], ["ZRANGE", "zf", "0", "-1", "WITHSCORES"],
      ["ZADD", "zg", "1", "a", "2", "b", "3", "c"], ["ZMOVEMEMBER", "zg", "zh", "MEMBERS", "2", "a", "zz"], ["ZADD", "zh", "9", "b"],
      ["ZMOVEMEMBER", "zg", "zh", "NX", "MEMBERS", "2", "b", "c"], ["ZRANGE", "zh", "0", "-1", "WITHSCORES"], ["ZMOVEMEMBER", "zg", "zh", "XX", "MEMBERS", "1", "b"],
      ["ZMOVEMEMBER", "zg", "zh", "MEMBERS", "1", "nope"], ["EXISTS", "zg"], ["ZMOVEMEMBER", "missing", "zh", "MEMBERS", "1", "a"], ["ZMOVEMEMBER", "zh", "zh", "MEMBERS", "1", "a"],
      ["ZMOVEMEMBER", "zh", "zz", "MEMBERS", "0"], ["ZMOVEMEMBER", "zh", "zz", "NX", "XX", "MEMBERS", "1", "a"], ["BZMOVE", "none", "zz", "MIN", "0.1"],
      ["BZMOVE", "none", "zz", "MIN", "0.1", "COUNT", "2"], ["ZADD", "zi", "1", "a", "2", "b"], ["BZMOVE", "zi", "zj", "MAX", "0", "COUNT", "5"], ["ZADD", "zk", "1", "a"],
      ["ZMOVE", "zk", "zk", "MIN"], ["ZMOVE", "zk", "str", "MIN"], ["ZADD", "u1", "1", "a", "2", "b"], ["ZADD", "u2", "5", "b", "6", "c"],
      ["ZUNION", "2", "u1", "u2", "AGGREGATE", "COUNT", "WITHSCORES"], ["ZINTER", "2", "u1", "u2", "AGGREGATE", "COUNT", "WITHSCORES"],
      ["ZUNION", "2", "u1", "u2", "WEIGHTS", "2", "3", "AGGREGATE", "COUNT", "WITHSCORES"], ["ZUNIONSTORE", "u3", "2", "u1", "u2", "AGGREGATE", "COUNT"], ["ZRANGE", "u3", "0", "-1", "WITHSCORES"],
    ]);
    const waiter = await s.peer();
    await waiter.send("BLMOVEM", "bq", "bd", "LEFT", "RIGHT", "0", "EXACTLY", "2", "BULK");
    await Bun.sleep(100);
    await s.cmd("RPUSH", "bq", "x");
    await s.cmd("RPUSH", "bq", "y", "z");
    await waiter.next("BLMOVEM served once two elements exist");
    await waiter.send("BZMOVE", "bz", "bzd", "MIN", "0", "COUNT", "2");
    await Bun.sleep(100);
    await s.cmd("ZADD", "bz", "3", "c", "1", "a", "2", "b");
    await waiter.next("BZMOVE served");
    await s.cmd("ZRANGE", "bzd", "0", "-1", "WITHSCORES");
  }));

  test("hash field expiry", () => run(async (s) => {
    await s.script([
      ["HSET", "h", "a", "1", "b", "2", "c", "3"],
      ["HEXPIRE", "h", "100", "FIELDS", "2", "a", "zz"], ["HEXPIRE", "h", "100", "NX", "FIELDS", "2", "a", "b"],
      ["HEXPIRE", "h", "0", "FIELDS", "1", "c"], ["HEXISTS", "h", "c"], ["HTTL", "h", "FIELDS", "3", "a", "b", "c"],
      ["HTTL", "nokey", "FIELDS", "1", "a"], ["HEXPIRE", "nokey", "10", "FIELDS", "1", "a"], ["HPERSIST", "h", "FIELDS", "2", "a", "c"],
      ["HEXPIRE", "h", "10", "FIELDS", "3", "a"], ["HEXPIRE", "h", "10", "FIELDS", "0"], ["HEXPIRE", "h", "10", "FIELD", "1", "a"],
      ["HEXPIRE", "h", "-1", "FIELDS", "1", "a"], ["HEXPIRE", "h", "100", "FIELDS", "1", "a", "b"], ["HEXPIRE", "h", "100", "FIELDS", "x", "a"],
      ["HEXPIRE", "h", "100", "XX", "FIELDS", "1", "a"], ["HEXPIRE", "h", "100", "GT", "FIELDS", "1", "a"], ["HEXPIRE", "h", "100", "LT", "FIELDS", "1", "a"],
      ["HEXPIRE", "h", "200", "GT", "FIELDS", "1", "a"], ["HEXPIRE", "h", "50", "LT", "FIELDS", "1", "a"], ["HEXPIRE", "h", "100", "NX", "XX", "FIELDS", "1", "a"],
      ["HEXPIRE", "h", "x", "FIELDS", "1", "a"], ["HEXPIRE", "h", "9999999999999999", "FIELDS", "1", "a"], ["HPEXPIREAT", "h", "1", "FIELDS", "1", "b"],
      ["HGETALL", "h"], ["HINCRBY", "h", "a", "5"], ["HTTL", "h", "FIELDS", "1", "a"], ["HSET", "h", "a", "7"], ["HTTL", "h", "FIELDS", "1", "a"],
      ["SET", "str", "v"], ["HEXPIRE", "str", "10", "FIELDS", "1", "a"], ["HTTL", "str", "FIELDS", "1", "a"],
      ["HGETDEL", "h", "FIELDS", "2", "a", "nope"], ["EXISTS", "h"], ["HGETDEL", "h", "FIELDS", "0"], ["HGETDEL", "nokey", "FIELDS", "1", "a"],
      ["HSETEX", "h2", "EX", "100", "FIELDS", "2", "a", "1", "b", "2"], ["HSETEX", "h2", "FNX", "EX", "100", "FIELDS", "1", "a", "9"],
      ["HSETEX", "h2", "FXX", "KEEPTTL", "FIELDS", "1", "a", "9"], ["HTTL", "h2", "FIELDS", "1", "a"], ["HGETEX", "h2", "PERSIST", "FIELDS", "1", "a"],
      ["HTTL", "h2", "FIELDS", "2", "a", "b"], ["HGETEX", "h2", "EX", "5", "FIELDS", "2", "a", "zz"], ["HTTL", "h2", "FIELDS", "1", "a"],
      ["OBJECT", "ENCODING", "h2"], ["HGETEX", "h2", "EX", "0", "FIELDS", "1", "a"], ["HGETALL", "h2"], ["HSETEX", "h2", "EX", "0", "FIELDS", "1", "a", "1"],
      ["HGETALL", "h2"], ["HGETEX", "h2", "EX", "10", "PX", "10", "FIELDS", "1", "b"], ["HGETEX", "h2", "FIELDS", "1", "a", "b"], ["HGETEX", "h2"],
      ["HSETEX", "h2", "FIELDS", "1", "a"], ["HSETEX", "h2", "FNX", "FXX", "FIELDS", "1", "a", "1"], ["HSETEX", "h2", "EX", "10", "KEEPTTL", "FIELDS", "1", "a", "1"],
      ["HSETEX", "h2", "FIELDS", "2", "a", "1"], ["HSETEX", "h2", "EX", "-1", "FIELDS", "1", "a", "1"], ["HGETEX", "h2", "EX", "-1", "FIELDS", "1", "a"],
    ]);
  }));

  test("hash fields expire on their own", () => run(async (s) => {
    await s.script([["HSET", "h", "a", "1", "b", "2"], ["HPEXPIRE", "h", "100", "FIELDS", "1", "a"]]);
    await Bun.sleep(200);
    await s.script([["HGETALL", "h"], ["HLEN", "h"], ["HPEXPIRE", "h", "50", "FIELDS", "1", "b"]]);
    await Bun.sleep(1500);
    await s.script([["EXISTS", "h"], ["HLEN", "h"]]);
  }));

  test("set member expiry and cardinality", () => run(async (s) => {
    await s.script([
      ["SADDEX", "s1", "EX", "100", "MEMBERS", "2", "a", "b"], ["SADDEX", "s1", "MEMBERS", "1", "c"], ["STTL", "s1", "MEMBERS", "4", "a", "b", "c", "zz"],
      ["SADD", "s1", "b"], ["STTL", "s1", "MEMBERS", "1", "b"], ["SEXPIRE", "s1", "50", "MEMBERS", "1", "c"], ["SPERSIST", "s1", "MEMBERS", "2", "c", "zz"],
      ["OBJECT", "ENCODING", "s1"], ["SADDEX", "s1", "FNX", "MEMBERS", "1", "q"], ["SADDEX"], ["SADDEX", "s1", "EX", "0", "MEMBERS", "1", "z"],
      ["SISMEMBER", "s1", "z"], ["SADD", "n", "1", "2", "3"], ["SEXPIRE", "n", "100", "MEMBERS", "1", "1"], ["OBJECT", "ENCODING", "n"], ["SMEMBERS", "n"],
      ["SADDEX", "s2", "MEMBERS", "2", "a", "b"], ["SADDEX", "s2", "MEMBERS", "2", "a", "b"], ["SADDEX", "s2", "MEMBERS", "2", "a", "c"],
      ["SADDEX", "s2", "MNX", "EX", "10", "MEMBERS", "1", "a"], ["SADDEX", "s2", "MNX", "EX", "10", "MEMBERS", "1", "d"],
      ["SADDEX", "s2", "MXX", "EX", "10", "MEMBERS", "2", "a", "zz"], ["SADDEX", "s2", "MXX", "EX", "100", "MEMBERS", "2", "a", "b"],
      ["STTL", "s2", "MEMBERS", "3", "a", "b", "d"], ["SADDEX", "s2", "KEEPTTL", "MEMBERS", "1", "a"], ["STTL", "s2", "MEMBERS", "1", "a"],
      ["SADDEX", "s2", "MEMBERS", "1", "a"], ["STTL", "s2", "MEMBERS", "1", "a"], ["SADDEX", "s2", "EX", "0", "MEMBERS", "2", "a", "new"], ["SMEMBERS", "s2"],
      ["SADDEX", "s2", "MNX", "MXX", "MEMBERS", "1", "a"], ["SADDEX", "s2", "EX", "1", "PX", "1", "MEMBERS", "1", "a"], ["SADDEX", "s2", "EX", "-1", "MEMBERS", "1", "a"],
      ["HSET", "o", "a", "1", "b", "2", "c", "3", "d", "4"], ["HEXPIRE", "o", "100", "FIELDS", "1", "c"], ["HEXPIRE", "o", "50", "FIELDS", "1", "d"],
      ["HGETALL", "o"], ["HPERSIST", "o", "FIELDS", "1", "d"], ["HKEYS", "o"], ["HEXPIRE", "o", "100", "FIELDS", "1", "a"], ["HKEYS", "o"], ["HSET", "o", "c", "9"], ["HKEYS", "o"],
      ["SDIFFCARD", "2", "s2", "nokey"], ["SUNIONCARD", "2", "s2", "s2", "LIMIT", "1"], ["SDIFFCARD", "3", "s2"], ["SDIFFCARD", "s1", "nokey"],
      ["SADDEX", "s2", "MEMBERS", "0"], ["SADDEX", "nokey", "MXX", "MEMBERS", "1", "a"], ["EXISTS", "nokey"], ["SINTERCARD", "2", "s1", "s2"],
    ]);
  }));
  test("LCS", () => run(async (s) => {
    await s.script([
      ["SET", "k1", "ohmytext"], ["SET", "k2", "mynewtext"], ["LCS", "k1", "k2"], ["LCS", "k1", "k2", "LEN"], ["LCS", "k1", "k2", "IDX"],
      ["LCS", "k1", "k2", "IDX", "MINMATCHLEN", "4", "WITHMATCHLEN"], ["LCS", "k1", "k2", "IDX", "WITHMATCHLEN", "MINMATCHLEN", "-3"], ["LCS", "k1", "missing"],
      ["LCS", "missing", "k2", "IDX"], ["LCS", "k1", "k2", "IDX", "LEN"], ["LCS", "k1", "k2", "FOO"], ["LCS", "k1", "k2", "MINMATCHLEN"], ["LCS", "k1", "k2", "MINMATCHLEN", "x"],
      ["SET", "a", "rhythmalgorithmabcabcabc"], ["SET", "b", "logarithmcbacbacba"], ["LCS", "a", "b"], ["LCS", "a", "b", "IDX", "WITHMATCHLEN"],
      ["SET", "c", "aaaa"], ["SET", "d", "aa"], ["LCS", "c", "d", "IDX"], ["LCS", "d", "c", "IDX", "WITHMATCHLEN"],
      ["HSET", "h", "f", "v"], ["LCS", "h", "k1"], ["LCS", "k1", "h", "LEN"],
    ]);
  }));

  test("SORT and SORT_RO", () => run(async (s) => {
    await s.script([
      ["RPUSH", "l", "3", "1", "2", "10"], ["SORT", "l"], ["SORT", "l", "DESC"], ["SORT", "l", "LIMIT", "1", "2"], ["SORT", "l", "LIMIT", "-1", "2"], ["SORT", "l", "LIMIT", "0", "-1"],
      ["SORT", "l", "ALPHA"], ["SORT", "l", "ALPHA", "DESC", "LIMIT", "0", "3"],
      ["MSET", "w_1", "30", "w_2", "10", "w_3", "20", "o_1", "one", "o_2", "two"], ["SORT", "l", "BY", "w_*"], ["SORT", "l", "BY", "w_*", "GET", "#", "GET", "o_*"],
      ["SORT", "l", "BY", "nosort"], ["SORT", "l", "BY", "nosort", "GET", "o_*", "DESC"], ["SORT", "l", "BY", "w_*", "STORE", "out"], ["LRANGE", "out", "0", "-1"],
      ["HSET", "h_1", "f", "5"], ["HSET", "h_2", "f", "1"], ["SORT", "l", "BY", "h_*->f", "GET", "h_*->f", "GET", "#"], ["SORT", "l", "BY", "w_*", "ALPHA"],
      ["SADD", "s", "b", "a", "c"], ["SORT", "s", "ALPHA"], ["SORT", "s", "ALPHA", "STORE", "sout"], ["LRANGE", "sout", "0", "-1"], ["SORT", "s"],
      ["ZADD", "z", "3", "x", "1", "y", "2", "w"], ["SORT", "z", "BY", "nosort"], ["SORT", "z", "ALPHA", "DESC"], ["SORT", "z", "BY", "nosort", "LIMIT", "1", "1"],
      ["SORT_RO", "l"], ["SORT_RO", "l", "STORE", "x"], ["SORT", "missing"], ["SORT", "missing", "STORE", "out"], ["EXISTS", "out"],
      ["SET", "str", "1"], ["SORT", "str"], ["SORT", "l", "FOO"], ["SORT", "l", "LIMIT", "1"], ["SORT", "l", "BY", "missing_*"], ["SORT", "l", "GET", "missing_*"],
      ["RPUSH", "nums", "1.5", "-2", "1e2", "inf"], ["SORT", "nums"], ["SORT", "nums", "DESC"],
    ]);
  }));
  test("HIMPORT fieldsets", () => run(async (s) => {
    const long = "x".repeat(80);
    await s.script([
      ["HIMPORT", "PREPARE", "fs", "b", "a", "c"], ["HIMPORT", "PREPARE", "fs", "x"], ["HIMPORT", "SET", "h", "fs", "1", "2", "3"], ["HIMPORT", "PREPARE", "fs", "b", "a", "c"],
      ["HIMPORT", "SET", "h", "fs", "2", "1", "3"], ["HGETALL", "h"], ["OBJECT", "ENCODING", "h"], ["HDEL", "h", "a"], ["HSET", "h", "d", "4"], ["HSET", "h", "a", "1"],
      ["HGETALL", "h"], ["HKEYS", "h"], ["HVALS", "h"], ["OBJECT", "ENCODING", "h"], ["HSET", "h", "zz", long], ["OBJECT", "ENCODING", "h"],
      ["HSET", "old", "z", "1"], ["EXPIRE", "old", "100"], ["HIMPORT", "SET", "old", "fs", "7", "8", "9"], ["TTL", "old"], ["HGETALL", "old"], ["OBJECT", "ENCODING", "old"],
      ["HEXPIRE", "old", "100", "FIELDS", "1", "a"], ["OBJECT", "ENCODING", "old"], ["HIMPORT", "SET", "h", "fs", "1", "2"], ["HIMPORT", "SET", "h", "nofs", "1"],
      ["HIMPORT", "PREPARE", "dup", "a", "a"], ["HIMPORT", "PREPARE", "dup"], ["SET", "str", "1"], ["HIMPORT", "SET", "str", "fs", "1", "2", "3"], ["HIMPORT", "SET", "str", "nofs", "1"], ["HIMPORT", "SET", "str", "fs", "1"],
      ["HIMPORT", "SET", "h", "fs"], ["HIMPORT", "DISCARD", "fs"], ["HIMPORT", "DISCARD", "fs"], ["HIMPORT", "PREPARE", "p", "x"], ["HIMPORT", "PREPARE", "q", "y"],
      ["HIMPORT", "DISCARDALL"], ["HIMPORT", "DISCARDALL", "x"], ["HIMPORT", "FOO"], ["HIMPORT"], ["HIMPORT", "PREPARE", "r", "a"], ["RESET"], ["HIMPORT", "DISCARD", "r"],
      ["HIMPORT", "PREPARE", "t", "f"], ["HIMPORT", "SET", "tc", "t", "v"], ["COPY", "tc", "tc2"], ["OBJECT", "ENCODING", "tc2"], ["RENAME", "tc", "tc3"], ["OBJECT", "ENCODING", "tc3"],
      ["HDEL", "tc3", "f"], ["EXISTS", "tc3"], ["HSET", "tc3", "f", "v"], ["OBJECT", "ENCODING", "tc3"],
    ]);
  }));
  test("admin commands", () => run(async (s) => {
    await s.script([
      ["SET", "k", "v"], ["MOVE", "k", "0"], ["MOVE", "k", "99"], ["MOVE", "k", "x"], ["SWAPDB", "0", "0"], ["SWAPDB", "0", "x"], ["SWAPDB", "x", "0"], ["ROLE"],
      ["SLOWLOG", "FOO"], ["SLOWLOG", "RESET"], ["LATENCY", "FOO"], ["LATENCY", "GRAPH", "command"], ["LATENCY", "HISTORY", "command"], ["MEMORY", "USAGE", "nokey"],
      ["MEMORY", "USAGE", "k", "FOO"], ["MEMORY", "FOO"], ["ACL", "GENPASS", "0"], ["ACL", "GENPASS", "5000"], ["ACL", "CAT", "nope"], ["ACL", "LOG", "x"], ["ACL", "LOG", "RESET"],
      ["ACL", "FOO"], ["CLUSTER", "INFO"], ["READONLY"], ["READWRITE"], ["ASKING"], ["WAITAOF", "0", "0", "0"], ["WAITAOF", "1", "0", "0"], ["WAITAOF", "x", "0", "0"],
      ["CLIENT", "NO-EVICT", "on"], ["CLIENT", "GETREDIR"], ["CLIENT", "TRACKINGINFO"], ["CLIENT", "CACHING", "yes"], ["CLIENT", "PAUSE", "x"], ["CLIENT", "UNPAUSE"],
      ["CLIENT", "REPLY", "ON"], ["CLIENT", "TRACKING", "OFF"], ["MODULE", "FOO"], ["SAVE"],
    ]);
    await s.shape("ACL", "GENPASS");
    await s.shape("ACL", "CAT");
    await s.shape("MEMORY", "USAGE", "k");
  }));
  test("hash encoding thresholds", () => run(async (s) => {
    const fields = Array.from({ length: 200 }, (_, i) => [`f${i}`, "v"]).flat();
    await s.script([["HSET", "big", ...fields], ["OBJECT", "ENCODING", "big"], ["DUMP", "big"]]);
  }));
});
