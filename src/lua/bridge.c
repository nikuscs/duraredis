#include <ctype.h>
#include <emscripten.h>
#include <limits.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#include "fpconv_dtoa.h"
#include "lauxlib.h"
#include "lua.h"
#include "lualib.h"
#include "rand.h"

LUALIB_API int luaopen_cjson(lua_State *L);
LUALIB_API int luaopen_struct(lua_State *L);
LUALIB_API int luaopen_cmsgpack(lua_State *L);
LUALIB_API int luaopen_bit(lua_State *L);

__attribute__((import_module("env"), import_name("host_now_ms")))
extern double host_now_ms(void);

__attribute__((import_module("env"), import_name("host_redis_call")))
extern int host_redis_call(const uint8_t *req, uint32_t req_len, int resp_ver, uint32_t *out_ptr, uint32_t *out_len);

__attribute__((import_module("env"), import_name("host_acl_check_cmd")))
extern int host_acl_check_cmd(const uint8_t *req, uint32_t req_len);

__attribute__((import_module("env"), import_name("host_register_function")))
extern int host_register_function(const char *name, uint32_t name_len, const char *desc, uint32_t desc_len, int has_desc, uint32_t flags, int lua_ref);

#define REDIS_VERSION_STR "8.12.0"
#define REDIS_VERSION_NUM_VAL 0x00080C00

#define REGISTRY_RUN_CTX "__RUN_CTX__"
#define REGISTRY_LOAD_CTX "__LIBRARY_CTX__"
#define REGISTRY_ERROR_HANDLER "__ERROR_HANDLER__"
#define REGISTRY_LIBRARY_API "__LIBRARY_API__"
#define REGISTRY_GLOBALS_API "__GLOBALS_API__"

#define FLAG_NO_WRITES (1u << 0)
#define FLAG_ALLOW_OOM (1u << 1)
#define FLAG_ALLOW_STALE (1u << 2)
#define FLAG_NO_CLUSTER (1u << 3)
#define FLAG_ALLOW_CROSS_SLOT (1u << 4)

#define PROPAGATE_NONE 0
#define PROPAGATE_AOF 1
#define PROPAGATE_REPL 2

#define LL_DEBUG 0
#define LL_VERBOSE 1
#define LL_NOTICE 2
#define LL_WARNING 3

typedef struct {
  char *data;
  size_t len;
  size_t cap;
} StrBuf;

typedef struct {
  const char *funcname;
  int is_eval;
  int script_resp;
  int client_resp;
  double start_ms;
  double timeout_ms;
  int timed_out;
} RunCtx;

typedef struct {
  double start_ms;
  double timeout_ms;
  int timed_out;
} LoadCtx;

typedef struct {
  const char *p;
  const char *end;
} RespReader;

typedef struct {
  char *msg;
  char *source;
  char *line;
  int ignore_stats;
} ErrInfo;

static lua_State *g_eval = NULL;
static lua_State *g_func = NULL;
static StrBuf g_out = {NULL, 0, 0};
static long g_gc_count = 0;

static void sb_ensure(StrBuf *sb, size_t extra) {
  size_t need = sb->len + extra + 1;
  if (need <= sb->cap) return;
  size_t cap = sb->cap ? sb->cap : 256;
  while (cap < need) cap *= 2;
  char *next = realloc(sb->data, cap);
  if (!next) abort();
  sb->data = next;
  sb->cap = cap;
}

static void sb_reset(StrBuf *sb) {
  sb->len = 0;
  if (sb->data) sb->data[0] = '\0';
}

static void sb_append(StrBuf *sb, const char *s, size_t len) {
  if (len == 0) return;
  sb_ensure(sb, len);
  memcpy(sb->data + sb->len, s, len);
  sb->len += len;
  sb->data[sb->len] = '\0';
}

static void sb_append_cstr(StrBuf *sb, const char *s) {
  sb_append(sb, s, strlen(s));
}

static void sb_append_char(StrBuf *sb, char c) {
  sb_ensure(sb, 1);
  sb->data[sb->len++] = c;
  sb->data[sb->len] = '\0';
}

static void sb_append_sanitized(StrBuf *sb, const char *s, size_t len) {
  sb_ensure(sb, len);
  for (size_t i = 0; i < len; i++) {
    char c = s[i];
    sb->data[sb->len++] = (c == '\r' || c == '\n') ? ' ' : c;
  }
  sb->data[sb->len] = '\0';
}

static char *xstrdup_len(const char *s, size_t len) {
  char *p = malloc(len + 1);
  if (!p) abort();
  if (len) memcpy(p, s, len);
  p[len] = '\0';
  return p;
}

static int ll_to_str(char *buf, size_t cap, long long val) {
  return snprintf(buf, cap, "%lld", val);
}

static int double_to_ll(double d, long long *out) {
  if (isnan(d)) return 0;
  if (d < (double)(-LLONG_MAX / 2) || d > (double)(LLONG_MAX / 2)) return 0;
  long long ll = (long long)d;
  if ((double)ll == d) {
    *out = ll;
    return 1;
  }
  return 0;
}

static int double_to_str(char *buf, size_t cap, double d) {
  if (isnan(d)) return snprintf(buf, cap, "nan");
  if (isinf(d)) return snprintf(buf, cap, d < 0 ? "-inf" : "inf");
  if (d == 0.0) return snprintf(buf, cap, (1.0 / d < 0) ? "-0" : "0");
  long long lv;
  if (double_to_ll(d, &lv)) return ll_to_str(buf, cap, lv);
  int len = fpconv_dtoa(d, buf);
  buf[len] = '\0';
  return len;
}

static long long lua_number_to_ll(double d) {
  if (isnan(d)) return 0;
  if (d >= 9223372036854775808.0) return LLONG_MAX;
  if (d <= -9223372036854775808.0) return LLONG_MIN;
  return (long long)d;
}

static void sb_append_ll_prefix(StrBuf *sb, char prefix, long long val) {
  char buf[48];
  int len = snprintf(buf, sizeof(buf), "%c%lld\r\n", prefix, val);
  sb_append(sb, buf, (size_t)len);
}

static void sb_append_bulk(StrBuf *sb, const char *s, size_t len) {
  sb_append_ll_prefix(sb, '$', (long long)len);
  sb_append(sb, s, len);
  sb_append(sb, "\r\n", 2);
}

static void sb_patch_deferred_len(StrBuf *sb, size_t pos, char prefix, long long count) {
  char tmp[32];
  int tlen = snprintf(tmp, sizeof(tmp), "%c%lld\r\n", prefix, count);
  size_t slot = 24;
  if ((size_t)tlen > slot) return;
  size_t diff = slot - (size_t)tlen;
  memcpy(sb->data + pos, tmp, (size_t)tlen);
  if (diff > 0) {
    memmove(sb->data + pos + tlen, sb->data + pos + slot, sb->len - (pos + slot));
    sb->len -= diff;
    sb->data[sb->len] = '\0';
  }
}

static size_t sb_begin_deferred(StrBuf *sb) {
  size_t pos = sb->len;
  char pad[24];
  memset(pad, ' ', sizeof(pad));
  sb_append(sb, pad, sizeof(pad));
  return pos;
}

static void save_registry_ptr(lua_State *L, const char *name, void *ptr) {
  lua_pushstring(L, name);
  if (ptr) lua_pushlightuserdata(L, ptr);
  else lua_pushnil(L);
  lua_settable(L, LUA_REGISTRYINDEX);
}

static void *get_registry_ptr(lua_State *L, const char *name) {
  lua_pushstring(L, name);
  lua_gettable(L, LUA_REGISTRYINDEX);
  if (lua_isnil(L, -1)) {
    lua_pop(L, 1);
    return NULL;
  }
  void *ptr = (void *)lua_topointer(L, -1);
  lua_pop(L, 1);
  return ptr;
}

static void sha1_transform(uint32_t state[5], const uint8_t buffer[64]) {
  uint32_t block[16];
  for (int i = 0; i < 16; i++) {
    block[i] = ((uint32_t)buffer[i * 4] << 24) |
               ((uint32_t)buffer[i * 4 + 1] << 16) |
               ((uint32_t)buffer[i * 4 + 2] << 8) |
               ((uint32_t)buffer[i * 4 + 3]);
  }
  uint32_t a = state[0], b = state[1], c = state[2], d = state[3], e = state[4];
  for (int i = 0; i < 80; i++) {
    uint32_t f, k;
    if (i >= 16) {
      uint32_t t = block[(i - 3) & 15] ^ block[(i - 8) & 15] ^ block[(i - 14) & 15] ^ block[i & 15];
      block[i & 15] = (t << 1) | (t >> 31);
    }
    if (i < 20) {
      f = (b & c) | ((~b) & d);
      k = 0x5A827999u;
    } else if (i < 40) {
      f = b ^ c ^ d;
      k = 0x6ED9EBA1u;
    } else if (i < 60) {
      f = (b & c) | (b & d) | (c & d);
      k = 0x8F1BBCDCu;
    } else {
      f = b ^ c ^ d;
      k = 0xCA62C1D6u;
    }
    uint32_t temp = ((a << 5) | (a >> 27)) + f + e + k + block[i & 15];
    e = d;
    d = c;
    c = (b << 30) | (b >> 2);
    b = a;
    a = temp;
  }
  state[0] += a;
  state[1] += b;
  state[2] += c;
  state[3] += d;
  state[4] += e;
}

static void compute_sha1hex(const uint8_t *data, uint32_t len, char *out41) {
  uint32_t state[5] = {0x67452301u, 0xEFCDAB89u, 0x98BADCFEu, 0x10325476u, 0xC3D2E1F0u};
  uint8_t buf[64];
  uint32_t i = 0;
  for (; i + 64 <= len; i += 64) sha1_transform(state, data + i);
  uint32_t rem = len - i;
  if (rem) memcpy(buf, data + i, rem);
  buf[rem++] = 0x80;
  if (rem > 56) {
    memset(buf + rem, 0, 64 - rem);
    sha1_transform(state, buf);
    rem = 0;
  }
  memset(buf + rem, 0, 56 - rem);
  uint64_t bits = (uint64_t)len * 8;
  for (int b = 0; b < 8; b++) buf[56 + b] = (uint8_t)((bits >> ((7 - b) * 8)) & 0xFFu);
  sha1_transform(state, buf);
  static const char hex[] = "0123456789abcdef";
  for (int w = 0; w < 5; w++) {
    for (int b = 0; b < 4; b++) {
      uint8_t byte = (uint8_t)((state[w] >> ((3 - b) * 8)) & 0xFFu);
      out41[(w * 4 + b) * 2] = hex[(byte >> 4) & 0xF];
      out41[(w * 4 + b) * 2 + 1] = hex[byte & 0xF];
    }
  }
  out41[40] = '\0';
}

static void push_error_raw(lua_State *L, const char *err, size_t len, int has_code) {
  const char *msg_start = err;
  size_t msg_len = len;
  const char *code_start = "ERR";
  size_t code_len = 3;
  if (has_code) {
    const char *sp = memchr(err, ' ', len);
    if (sp) {
      code_start = err;
      code_len = (size_t)(sp - err);
      msg_start = sp + 1;
      msg_len = len - (size_t)(msg_start - err);
    }
  }
  while (msg_len > 0 && (msg_start[msg_len - 1] == '\r' || msg_start[msg_len - 1] == '\n')) msg_len--;
  StrBuf sb = {NULL, 0, 0};
  sb_append(&sb, code_start, code_len);
  sb_append_char(&sb, ' ');
  sb_append(&sb, msg_start, msg_len);
  lua_newtable(L);
  lua_pushstring(L, "err");
  lua_pushlstring(L, sb.data, sb.len);
  lua_settable(L, -3);
  free(sb.data);
}

static void push_error_len(lua_State *L, const char *err, size_t len) {
  if (len > 0 && err[0] == '-') {
    push_error_raw(L, err + 1, len - 1, 1);
    return;
  }
  push_error_raw(L, err, len, 0);
}

static void push_error_cstr(lua_State *L, const char *err) {
  push_error_len(L, err, strlen(err));
}

static void extract_error_info(lua_State *L, ErrInfo *info) {
  memset(info, 0, sizeof(*info));
  if (lua_isstring(L, -1)) {
    size_t len = 0;
    const char *s = lua_tolstring(L, -1, &len);
    StrBuf sb = {NULL, 0, 0};
    sb_append_cstr(&sb, "ERR ");
    sb_append(&sb, s, len);
    info->msg = sb.data;
    return;
  }
  lua_getfield(L, -1, "err");
  if (lua_isstring(L, -1)) {
    size_t len = 0;
    const char *s = lua_tolstring(L, -1, &len);
    info->msg = xstrdup_len(s, len);
  }
  lua_pop(L, 1);

  lua_getfield(L, -1, "source");
  if (lua_isstring(L, -1)) {
    size_t len = 0;
    const char *s = lua_tolstring(L, -1, &len);
    info->source = xstrdup_len(s, len);
  }
  lua_pop(L, 1);

  lua_getfield(L, -1, "line");
  if (lua_isstring(L, -1)) {
    size_t len = 0;
    const char *s = lua_tolstring(L, -1, &len);
    info->line = xstrdup_len(s, len);
  }
  lua_pop(L, 1);

  lua_getfield(L, -1, "ignore_error_stats_update");
  if (lua_isboolean(L, -1)) info->ignore_stats = lua_toboolean(L, -1);
  lua_pop(L, 1);
}

static void discard_error_info(ErrInfo *info) {
  free(info->msg);
  free(info->source);
  free(info->line);
}

static int read_resp_line(RespReader *r, const char **start, size_t *len) {
  if (r->p >= r->end) return 0;
  const char *s = r->p + 1;
  const char *nl = s;
  while (nl + 1 < r->end && !(nl[0] == '\r' && nl[1] == '\n')) nl++;
  if (nl + 1 >= r->end) return 0;
  *start = s;
  *len = (size_t)(nl - s);
  r->p = nl + 2;
  return 1;
}

static long long parse_ll_slice(const char *s, size_t len) {
  char buf[32];
  size_t n = len < sizeof(buf) - 1 ? len : sizeof(buf) - 1;
  memcpy(buf, s, n);
  buf[n] = '\0';
  return strtoll(buf, NULL, 10);
}

static double parse_double_slice(const char *s, size_t len) {
  if (len == 3 && memcmp(s, "inf", 3) == 0) return INFINITY;
  if (len == 4 && memcmp(s, "-inf", 4) == 0) return -INFINITY;
  if (len == 3 && memcmp(s, "nan", 3) == 0) return NAN;
  char buf[64];
  size_t n = len < sizeof(buf) - 1 ? len : sizeof(buf) - 1;
  memcpy(buf, s, n);
  buf[n] = '\0';
  return strtod(buf, NULL);
}

static int resp_to_lua(lua_State *L, RespReader *r, int push) {
  if (r->p >= r->end) return 0;
  char prefix = r->p[0];
  const char *line = NULL;
  size_t len = 0;
  if (!read_resp_line(r, &line, &len)) return 0;
  if (push && !lua_checkstack(L, 5)) return 0;

  switch (prefix) {
    case ':':
      if (push) lua_pushnumber(L, (lua_Number)parse_ll_slice(line, len));
      return 1;
    case '$': {
      long long blen = parse_ll_slice(line, len);
      if (blen < 0) {
        if (push) lua_pushboolean(L, 0);
        return 1;
      }
      if (r->p + blen + 2 > r->end) return 0;
      if (push) lua_pushlstring(L, r->p, (size_t)blen);
      r->p += (size_t)blen + 2;
      return 1;
    }
    case '+':
      if (push) {
        lua_newtable(L);
        lua_pushstring(L, "ok");
        lua_pushlstring(L, line, len);
        lua_settable(L, -3);
      }
      return 1;
    case '-':
      if (push) {
        push_error_raw(L, line, len, 1);
        lua_pushstring(L, "ignore_error_stats_update");
        lua_pushboolean(L, 1);
        lua_settable(L, -3);
      }
      return 1;
    case '_':
      if (push) lua_pushnil(L);
      return 1;
    case '#':
      if (push) lua_pushboolean(L, len > 0 && line[0] == 't');
      return 1;
    case ',':
      if (push) {
        lua_newtable(L);
        lua_pushstring(L, "double");
        lua_pushnumber(L, parse_double_slice(line, len));
        lua_settable(L, -3);
      }
      return 1;
    case '(':
      if (push) {
        lua_newtable(L);
        lua_pushstring(L, "big_number");
        lua_pushlstring(L, line, len);
        lua_settable(L, -3);
      }
      return 1;
    case '=': {
      long long blen = parse_ll_slice(line, len);
      if (blen < 4 || r->p + blen + 2 > r->end) return 0;
      const char *payload = r->p;
      r->p += (size_t)blen + 2;
      if (push) {
        lua_newtable(L);
        lua_pushstring(L, "verbatim_string");
        lua_newtable(L);
        lua_pushstring(L, "string");
        lua_pushlstring(L, payload + 4, (size_t)(blen - 4));
        lua_settable(L, -3);
        lua_pushstring(L, "format");
        lua_pushlstring(L, payload, 3);
        lua_settable(L, -3);
        lua_settable(L, -3);
      }
      return 1;
    }
    case '*':
    case '>': {
      long long count = parse_ll_slice(line, len);
      if (count < 0) {
        if (push) lua_pushboolean(L, 0);
        return 1;
      }
      if (push) lua_newtable(L);
      for (long long j = 0; j < count; j++) {
        if (push) lua_pushnumber(L, (lua_Number)(j + 1));
        if (!resp_to_lua(L, r, push)) return 0;
        if (push) lua_settable(L, -3);
      }
      return 1;
    }
    case '%': {
      long long count = parse_ll_slice(line, len);
      if (push) {
        lua_newtable(L);
        lua_pushstring(L, "map");
        lua_newtable(L);
      }
      for (long long j = 0; j < count; j++) {
        if (!resp_to_lua(L, r, push)) return 0;
        if (!resp_to_lua(L, r, push)) return 0;
        if (push) lua_settable(L, -3);
      }
      if (push) lua_settable(L, -3);
      return 1;
    }
    case '~': {
      long long count = parse_ll_slice(line, len);
      if (push) {
        lua_newtable(L);
        lua_pushstring(L, "set");
        lua_newtable(L);
      }
      for (long long j = 0; j < count; j++) {
        if (!resp_to_lua(L, r, push)) return 0;
        if (push) {
          if (!lua_checkstack(L, 1)) return 0;
          lua_pushboolean(L, 1);
          lua_settable(L, -3);
        }
      }
      if (push) lua_settable(L, -3);
      return 1;
    }
    case '|': {
      long long count = parse_ll_slice(line, len);
      for (long long j = 0; j < count; j++) {
        if (!resp_to_lua(L, r, 0)) return 0;
        if (!resp_to_lua(L, r, 0)) return 0;
      }
      return resp_to_lua(L, r, push);
    }
    default:
      return 0;
  }
}

static void append_double_reply(StrBuf *sb, double d, int client_resp) {
  char buf[64];
  int dlen = double_to_str(buf, sizeof(buf), d);
  if (client_resp == 3) {
    sb_append_char(sb, ',');
    sb_append(sb, buf, (size_t)dlen);
    sb_append(sb, "\r\n", 2);
    return;
  }
  sb_append_bulk(sb, buf, (size_t)dlen);
}

static void append_verbatim_reply(StrBuf *sb, const char *s, size_t len, const char *fmt, int client_resp) {
  if (client_resp == 2) {
    sb_append_bulk(sb, s, len);
    return;
  }
  char ext[3] = {' ', ' ', ' '};
  for (int i = 0; i < 3 && fmt[i]; i++) ext[i] = fmt[i];
  sb_append_ll_prefix(sb, '=', (long long)(len + 4));
  sb_append(sb, ext, 3);
  sb_append_char(sb, ':');
  sb_append(sb, s, len);
  sb_append(sb, "\r\n", 2);
}

static void lua_to_resp(lua_State *L, StrBuf *sb, int script_resp, int client_resp, int depth) {
  if (depth > 2500 || !lua_checkstack(L, 4)) {
    sb_append_cstr(sb, "-ERR reached lua stack limit\r\n");
    lua_pop(L, 1);
    return;
  }

  int t = lua_type(L, -1);
  switch (t) {
    case LUA_TSTRING: {
      size_t len = 0;
      const char *s = lua_tolstring(L, -1, &len);
      sb_append_bulk(sb, s, len);
      lua_pop(L, 1);
      return;
    }
    case LUA_TBOOLEAN: {
      int b = lua_toboolean(L, -1);
      if (script_resp == 2) {
        if (b) sb_append_cstr(sb, ":1\r\n");
        else sb_append_cstr(sb, client_resp == 3 ? "_\r\n" : "$-1\r\n");
      } else {
        if (client_resp == 3) sb_append_cstr(sb, b ? "#t\r\n" : "#f\r\n");
        else sb_append_cstr(sb, b ? ":1\r\n" : ":0\r\n");
      }
      lua_pop(L, 1);
      return;
    }
    case LUA_TNUMBER: {
      long long lv = lua_number_to_ll(lua_tonumber(L, -1));
      sb_append_ll_prefix(sb, ':', lv);
      lua_pop(L, 1);
      return;
    }
    case LUA_TTABLE: {
      lua_pushstring(L, "err");
      lua_rawget(L, -2);
      if (lua_type(L, -1) == LUA_TSTRING) {
        lua_pop(L, 1);
        ErrInfo info;
        extract_error_info(L, &info);
        sb_append_char(sb, '-');
        if (info.msg) sb_append_sanitized(sb, info.msg, strlen(info.msg));
        sb_append(sb, "\r\n", 2);
        discard_error_info(&info);
        lua_pop(L, 1);
        return;
      }
      lua_pop(L, 1);

      lua_pushstring(L, "ok");
      lua_rawget(L, -2);
      if (lua_type(L, -1) == LUA_TSTRING) {
        size_t len = 0;
        const char *s = lua_tolstring(L, -1, &len);
        sb_append_char(sb, '+');
        sb_append_sanitized(sb, s, len);
        sb_append(sb, "\r\n", 2);
        lua_pop(L, 2);
        return;
      }
      lua_pop(L, 1);

      lua_pushstring(L, "double");
      lua_rawget(L, -2);
      if (lua_type(L, -1) == LUA_TNUMBER) {
        append_double_reply(sb, lua_tonumber(L, -1), client_resp);
        lua_pop(L, 2);
        return;
      }
      lua_pop(L, 1);

      lua_pushstring(L, "big_number");
      lua_rawget(L, -2);
      if (lua_type(L, -1) == LUA_TSTRING) {
        size_t len = 0;
        const char *s = lua_tolstring(L, -1, &len);
        if (client_resp == 2) {
          sb_append_ll_prefix(sb, '$', (long long)len);
          sb_append_sanitized(sb, s, len);
          sb_append(sb, "\r\n", 2);
        } else {
          sb_append_char(sb, '(');
          sb_append_sanitized(sb, s, len);
          sb_append(sb, "\r\n", 2);
        }
        lua_pop(L, 2);
        return;
      }
      lua_pop(L, 1);

      lua_pushstring(L, "verbatim_string");
      lua_rawget(L, -2);
      if (lua_type(L, -1) == LUA_TTABLE) {
        lua_pushstring(L, "format");
        lua_rawget(L, -2);
        if (lua_type(L, -1) == LUA_TSTRING) {
          const char *fmt = lua_tostring(L, -1);
          lua_pushstring(L, "string");
          lua_rawget(L, -3);
          if (lua_type(L, -1) == LUA_TSTRING) {
            size_t slen = 0;
            const char *str = lua_tolstring(L, -1, &slen);
            append_verbatim_reply(sb, str, slen, fmt, client_resp);
            lua_pop(L, 4);
            return;
          }
          lua_pop(L, 1);
        }
        lua_pop(L, 1);
      }
      lua_pop(L, 1);

      lua_pushstring(L, "map");
      lua_rawget(L, -2);
      if (lua_type(L, -1) == LUA_TTABLE) {
        long long maplen = 0;
        size_t pos = sb_begin_deferred(sb);
        lua_pushnil(L);
        while (lua_next(L, -2)) {
          lua_pushvalue(L, -2);
          lua_to_resp(L, sb, script_resp, client_resp, depth + 1);
          lua_to_resp(L, sb, script_resp, client_resp, depth + 1);
          maplen++;
        }
        if (client_resp == 3) sb_patch_deferred_len(sb, pos, '%', maplen);
        else sb_patch_deferred_len(sb, pos, '*', maplen * 2);
        lua_pop(L, 2);
        return;
      }
      lua_pop(L, 1);

      lua_pushstring(L, "set");
      lua_rawget(L, -2);
      if (lua_type(L, -1) == LUA_TTABLE) {
        long long setlen = 0;
        size_t pos = sb_begin_deferred(sb);
        lua_pushnil(L);
        while (lua_next(L, -2)) {
          lua_pop(L, 1);
          lua_pushvalue(L, -1);
          lua_to_resp(L, sb, script_resp, client_resp, depth + 1);
          setlen++;
        }
        sb_patch_deferred_len(sb, pos, client_resp == 3 ? '~' : '*', setlen);
        lua_pop(L, 2);
        return;
      }
      lua_pop(L, 1);

      long long mlen = 0;
      long long j = 1;
      size_t pos = sb_begin_deferred(sb);
      for (;;) {
        lua_pushnumber(L, (lua_Number)(j++));
        lua_rawget(L, -2);
        if (lua_type(L, -1) == LUA_TNIL) {
          lua_pop(L, 1);
          break;
        }
        lua_to_resp(L, sb, script_resp, client_resp, depth + 1);
        mlen++;
      }
      sb_patch_deferred_len(sb, pos, '*', mlen);
      lua_pop(L, 1);
      return;
    }
    default:
      sb_append_cstr(sb, client_resp == 3 ? "_\r\n" : "$-1\r\n");
      lua_pop(L, 1);
      return;
  }
}

static void sb_append_u32(StrBuf *sb, uint32_t v) {
  uint8_t b[4];
  b[0] = (uint8_t)(v & 0xFFu);
  b[1] = (uint8_t)((v >> 8) & 0xFFu);
  b[2] = (uint8_t)((v >> 16) & 0xFFu);
  b[3] = (uint8_t)((v >> 24) & 0xFFu);
  sb_append(sb, (const char *)b, 4);
}

static int pack_lua_args(lua_State *L, StrBuf *req, int pop_all) {
  int argc = lua_gettop(L);
  if (argc == 0) {
    push_error_cstr(L, "Please specify at least one argument for this redis lib call");
    return 0;
  }
  sb_append_u32(req, (uint32_t)argc);
  int ok = 1;
  for (int j = 0; j < argc; j++) {
    char dbuf[64];
    const char *s = NULL;
    size_t len = 0;
    if (lua_type(L, j + 1) == LUA_TNUMBER) {
      double num = lua_tonumber(L, j + 1);
      long long lv;
      if (double_to_ll(num, &lv)) {
        len = (size_t)ll_to_str(dbuf, sizeof(dbuf), lv);
      } else if (isnan(num)) {
        memcpy(dbuf, "nan", 4);
        len = 3;
      } else {
        len = (size_t)fpconv_dtoa(num, dbuf);
        dbuf[len] = '\0';
      }
      s = dbuf;
    } else {
      s = lua_tolstring(L, j + 1, &len);
      if (!s) {
        ok = 0;
        break;
      }
    }
    sb_append_u32(req, (uint32_t)len);
    sb_append(req, s, len);
  }
  if (pop_all) lua_pop(L, argc);
  if (!ok) {
    push_error_cstr(L, "Lua redis lib command arguments must be strings or integers");
    return 0;
  }
  return 1;
}

static int lua_redis_generic_command(lua_State *L, int raise_error) {
  RunCtx *rctx = get_registry_ptr(L, REGISTRY_RUN_CTX);
  if (!rctx) {
    push_error_cstr(L, "ERR redis.call can only be called inside a script");
    return raise_error ? lua_error(L) : 1;
  }
  StrBuf req = {NULL, 0, 0};
  if (!pack_lua_args(L, &req, 1)) {
    free(req.data);
    return raise_error ? lua_error(L) : 1;
  }
  uint32_t out_ptr = 0;
  uint32_t out_len = 0;
  int rc = host_redis_call((const uint8_t *)req.data, (uint32_t)req.len, rctx->script_resp, &out_ptr, &out_len);
  free(req.data);
  if (rc != 0 || out_ptr == 0) {
    push_error_cstr(L, "ERR host command invocation failed");
    return raise_error ? lua_error(L) : 1;
  }
  char *reply = (char *)(uintptr_t)out_ptr;
  if (raise_error && out_len > 0 && reply[0] != '-') raise_error = 0;
  RespReader reader = {reply, reply + out_len};
  if (!resp_to_lua(L, &reader, 1)) {
    free(reply);
    push_error_cstr(L, "ERR failed to parse Redis reply");
    return raise_error ? lua_error(L) : 1;
  }
  free(reply);
  if (raise_error) return lua_error(L);
  return 1;
}

static int lua_redis_call(lua_State *L) {
  return lua_redis_generic_command(L, 1);
}

static int lua_redis_pcall_cmd(lua_State *L) {
  return lua_redis_generic_command(L, 0);
}

static int lua_redis_pcall(lua_State *L) {
  int argc = lua_gettop(L);
  lua_pushboolean(L, 1);
  lua_insert(L, 1);
  if (lua_pcall(L, argc - 1, LUA_MULTRET, 0)) {
    lua_remove(L, 1);
    if (lua_istable(L, -1)) {
      lua_getfield(L, -1, "err");
      if (lua_isstring(L, -1)) lua_replace(L, -2);
      else lua_pop(L, 1);
    }
    lua_pushboolean(L, 0);
    lua_insert(L, 1);
  }
  return lua_gettop(L);
}

static int lua_redis_sha1hex(lua_State *L) {
  if (lua_gettop(L) != 1) {
    push_error_cstr(L, "wrong number of arguments");
    return lua_error(L);
  }
  size_t len = 0;
  const char *s = lua_tolstring(L, 1, &len);
  if (!s) {
    s = "";
    len = 0;
  }
  char digest[41];
  compute_sha1hex((const uint8_t *)s, (uint32_t)len, digest);
  lua_pushstring(L, digest);
  return 1;
}

static int lua_redis_error_reply(lua_State *L) {
  if (lua_gettop(L) != 1 || lua_type(L, -1) != LUA_TSTRING) {
    push_error_cstr(L, "wrong number or type of arguments");
    return 1;
  }
  size_t len = 0;
  const char *err = lua_tolstring(L, -1, &len);
  if (len > 0 && err[0] == '-') {
    push_error_len(L, err, len);
  } else {
    StrBuf sb = {NULL, 0, 0};
    sb_append_char(&sb, '-');
    sb_append(&sb, err, len);
    push_error_len(L, sb.data, sb.len);
    free(sb.data);
  }
  return 1;
}

static int lua_redis_status_reply(lua_State *L) {
  if (lua_gettop(L) != 1 || lua_type(L, -1) != LUA_TSTRING) {
    push_error_cstr(L, "wrong number or type of arguments");
    return 1;
  }
  lua_newtable(L);
  lua_pushstring(L, "ok");
  lua_pushvalue(L, -3);
  lua_settable(L, -3);
  return 1;
}

static int lua_redis_set_repl(lua_State *L) {
  if (lua_gettop(L) != 1) {
    push_error_cstr(L, "redis.set_repl() requires one argument.");
    return lua_error(L);
  }
  int flags = (int)lua_tonumber(L, -1);
  if ((flags & ~(PROPAGATE_AOF | PROPAGATE_REPL)) != 0) {
    push_error_cstr(L, "Invalid replication flags. Use REPL_AOF, REPL_REPLICA, REPL_ALL or REPL_NONE.");
    return lua_error(L);
  }
  return 0;
}

static int lua_redis_acl_check_cmd(lua_State *L) {
  StrBuf req = {NULL, 0, 0};
  if (!pack_lua_args(L, &req, 1)) {
    free(req.data);
    return lua_error(L);
  }
  int res = host_acl_check_cmd((const uint8_t *)req.data, (uint32_t)req.len);
  free(req.data);
  if (res < 0) {
    push_error_cstr(L, "Invalid command passed to redis.acl_check_cmd()");
    return lua_error(L);
  }
  lua_pushboolean(L, res != 0);
  return 1;
}

static int lua_redis_log(lua_State *L) {
  int argc = lua_gettop(L);
  if (argc < 2) {
    push_error_cstr(L, "redis.log() requires two arguments or more.");
    return lua_error(L);
  }
  if (!lua_isnumber(L, -argc)) {
    push_error_cstr(L, "First argument must be a number (log level).");
    return lua_error(L);
  }
  int level = (int)lua_tonumber(L, -argc);
  if (level < LL_DEBUG || level > LL_WARNING) {
    push_error_cstr(L, "Invalid log level.");
    return lua_error(L);
  }
  return 0;
}

static int lua_redis_setresp(lua_State *L) {
  RunCtx *rctx = get_registry_ptr(L, REGISTRY_RUN_CTX);
  if (!rctx) {
    push_error_cstr(L, "ERR redis.setresp can only be called inside a script");
    return lua_error(L);
  }
  int argc = lua_gettop(L);
  if (argc != 1) {
    push_error_cstr(L, "redis.setresp() requires one argument.");
    return lua_error(L);
  }
  int resp = (int)lua_tonumber(L, -argc);
  if (resp != 2 && resp != 3) {
    push_error_cstr(L, "RESP version must be 2 or 3.");
    return lua_error(L);
  }
  rctx->script_resp = resp;
  return 0;
}

static int lua_redis_breakpoint(lua_State *L) {
  lua_pushboolean(L, 0);
  return 1;
}

static int lua_redis_debug(lua_State *L) {
  (void)L;
  return 0;
}

static int lua_redis_replicate_commands(lua_State *L) {
  lua_pushboolean(L, 1);
  return 1;
}

static int redis_math_random(lua_State *L) {
  lua_Number r = (lua_Number)(redisLrand48() % REDIS_LRAND48_MAX) / (lua_Number)REDIS_LRAND48_MAX;
  switch (lua_gettop(L)) {
    case 0:
      lua_pushnumber(L, r);
      break;
    case 1: {
      int u = luaL_checkint(L, 1);
      luaL_argcheck(L, 1 <= u, 1, "interval is empty");
      lua_pushnumber(L, floor(r * u) + 1);
      break;
    }
    case 2: {
      int l = luaL_checkint(L, 1);
      int u = luaL_checkint(L, 2);
      luaL_argcheck(L, l <= u, 2, "interval is empty");
      lua_pushnumber(L, floor(r * (u - l + 1)) + l);
      break;
    }
    default:
      return luaL_error(L, "wrong number of arguments");
  }
  return 1;
}

static int redis_math_randomseed(lua_State *L) {
  redisSrand48(luaL_checkint(L, 1));
  return 0;
}

static const char *const ALLOW_GLOBALS[] = {
  "string", "cjson", "bit", "cmsgpack", "math", "table", "struct",
  "redis", "__redis__err__handler",
  "xpcall", "tostring", "getfenv", "setmetatable", "next", "assert",
  "tonumber", "rawequal", "collectgarbage", "getmetatable", "rawset",
  "pcall", "coroutine", "type", "_G", "select", "unpack", "gcinfo",
  "pairs", "rawget", "loadstring", "ipairs", "_VERSION", "setfenv",
  "load", "error", "newproxy", "debug", NULL
};

static int lua_protected_table_error(lua_State *L) {
  if (lua_gettop(L) != 2) luaL_error(L, "Wrong number of arguments to luaProtectedTableError");
  if (!lua_isstring(L, -1) && !lua_isnumber(L, -1)) {
    luaL_error(L, "Second argument to luaProtectedTableError must be a string or number");
  }
  const char *name = lua_tostring(L, -1);
  luaL_error(L, "Script attempted to access nonexistent global variable '%s'", name);
  return 0;
}

static void set_error_metatable(lua_State *L) {
  lua_newtable(L);
  lua_pushcfunction(L, lua_protected_table_error);
  lua_setfield(L, -2, "__index");
  lua_setmetatable(L, -2);
}

static int lua_new_index_allow_list(lua_State *L) {
  if (lua_gettop(L) != 3) luaL_error(L, "Wrong number of arguments to luaNewIndexAllowList");
  if (!lua_istable(L, -3)) luaL_error(L, "first argument to luaNewIndexAllowList must be a table");
  if (!lua_isstring(L, -2) && !lua_isnumber(L, -2)) {
    luaL_error(L, "Second argument to luaNewIndexAllowList must be a string or number");
  }
  const char *name = lua_tostring(L, -2);
  for (int i = 0; ALLOW_GLOBALS[i]; i++) {
    if (strcmp(ALLOW_GLOBALS[i], name) == 0) {
      lua_rawset(L, -3);
      return 0;
    }
  }
  return 0;
}

static void set_allow_list_protection(lua_State *L) {
  lua_newtable(L);
  lua_pushcfunction(L, lua_new_index_allow_list);
  lua_setfield(L, -2, "__newindex");
  lua_setmetatable(L, -2);
}

static void set_table_protection_recursively(lua_State *L) {
  if (lua_isreadonlytable(L, -1)) return;
  lua_enablereadonlytable(L, -1, 1);
  lua_checkstack(L, 2);
  lua_pushnil(L);
  while (lua_next(L, -2)) {
    if (lua_istable(L, -1)) set_table_protection_recursively(L);
    lua_pop(L, 1);
  }
  if (lua_getmetatable(L, -1)) {
    set_table_protection_recursively(L);
    lua_pop(L, 1);
  }
}

static void load_lib(lua_State *L, const char *name, lua_CFunction fn) {
  lua_pushcfunction(L, fn);
  lua_pushstring(L, name);
  lua_call(L, 1, 0);
}

static void register_version(lua_State *L) {
  lua_pushstring(L, "REDIS_VERSION_NUM");
  lua_pushnumber(L, REDIS_VERSION_NUM_VAL);
  lua_settable(L, -3);
  lua_pushstring(L, "REDIS_VERSION");
  lua_pushstring(L, REDIS_VERSION_STR);
  lua_settable(L, -3);
}

static void register_log_function(lua_State *L) {
  lua_pushstring(L, "log");
  lua_pushcfunction(L, lua_redis_log);
  lua_settable(L, -3);
  lua_pushstring(L, "LOG_DEBUG");
  lua_pushnumber(L, LL_DEBUG);
  lua_settable(L, -3);
  lua_pushstring(L, "LOG_VERBOSE");
  lua_pushnumber(L, LL_VERBOSE);
  lua_settable(L, -3);
  lua_pushstring(L, "LOG_NOTICE");
  lua_pushnumber(L, LL_NOTICE);
  lua_settable(L, -3);
  lua_pushstring(L, "LOG_WARNING");
  lua_pushnumber(L, LL_WARNING);
  lua_settable(L, -3);
}

static void register_redis_api(lua_State *L) {
  lua_pushvalue(L, LUA_GLOBALSINDEX);
  set_allow_list_protection(L);
  lua_pop(L, 1);

  load_lib(L, "", luaopen_base);
  load_lib(L, LUA_TABLIBNAME, luaopen_table);
  load_lib(L, LUA_STRLIBNAME, luaopen_string);
  load_lib(L, LUA_MATHLIBNAME, luaopen_math);
  load_lib(L, LUA_DBLIBNAME, luaopen_debug);
  load_lib(L, "cjson", luaopen_cjson);
  load_lib(L, "struct", luaopen_struct);
  load_lib(L, "cmsgpack", luaopen_cmsgpack);
  load_lib(L, "bit", luaopen_bit);

  lua_pushcfunction(L, lua_redis_pcall);
  lua_setglobal(L, "pcall");

  lua_newtable(L);
  lua_pushstring(L, "call");
  lua_pushcfunction(L, lua_redis_call);
  lua_settable(L, -3);
  lua_pushstring(L, "pcall");
  lua_pushcfunction(L, lua_redis_pcall_cmd);
  lua_settable(L, -3);
  register_log_function(L);
  register_version(L);
  lua_pushstring(L, "setresp");
  lua_pushcfunction(L, lua_redis_setresp);
  lua_settable(L, -3);
  lua_pushstring(L, "sha1hex");
  lua_pushcfunction(L, lua_redis_sha1hex);
  lua_settable(L, -3);
  lua_pushstring(L, "error_reply");
  lua_pushcfunction(L, lua_redis_error_reply);
  lua_settable(L, -3);
  lua_pushstring(L, "status_reply");
  lua_pushcfunction(L, lua_redis_status_reply);
  lua_settable(L, -3);
  lua_pushstring(L, "set_repl");
  lua_pushcfunction(L, lua_redis_set_repl);
  lua_settable(L, -3);
  lua_pushstring(L, "REPL_NONE");
  lua_pushnumber(L, PROPAGATE_NONE);
  lua_settable(L, -3);
  lua_pushstring(L, "REPL_AOF");
  lua_pushnumber(L, PROPAGATE_AOF);
  lua_settable(L, -3);
  lua_pushstring(L, "REPL_SLAVE");
  lua_pushnumber(L, PROPAGATE_REPL);
  lua_settable(L, -3);
  lua_pushstring(L, "REPL_REPLICA");
  lua_pushnumber(L, PROPAGATE_REPL);
  lua_settable(L, -3);
  lua_pushstring(L, "REPL_ALL");
  lua_pushnumber(L, PROPAGATE_AOF | PROPAGATE_REPL);
  lua_settable(L, -3);
  lua_pushstring(L, "acl_check_cmd");
  lua_pushcfunction(L, lua_redis_acl_check_cmd);
  lua_settable(L, -3);
  lua_setglobal(L, "redis");

  lua_getglobal(L, "math");
  lua_pushstring(L, "random");
  lua_pushcfunction(L, redis_math_random);
  lua_settable(L, -3);
  lua_pushstring(L, "randomseed");
  lua_pushcfunction(L, redis_math_randomseed);
  lua_settable(L, -3);
  lua_setglobal(L, "math");
}

static lua_State *init_eval_state(void) {
  lua_State *L = lua_open();
  register_redis_api(L);

  lua_getglobal(L, "redis");
  lua_pushstring(L, "breakpoint");
  lua_pushcfunction(L, lua_redis_breakpoint);
  lua_settable(L, -3);
  lua_pushstring(L, "debug");
  lua_pushcfunction(L, lua_redis_debug);
  lua_settable(L, -3);
  lua_pushstring(L, "replicate_commands");
  lua_pushcfunction(L, lua_redis_replicate_commands);
  lua_settable(L, -3);
  lua_setglobal(L, "redis");

  static const char *errh =
    "local dbg = debug\n"
    "debug = nil\n"
    "function __redis__err__handler(err)\n"
    "  local i = dbg.getinfo(2,'nSl')\n"
    "  if i and i.what == 'C' then\n"
    "    i = dbg.getinfo(3,'nSl')\n"
    "  end\n"
    "  if type(err) ~= 'table' then\n"
    "    err = {err='ERR ' .. tostring(err)}\n"
    "  end\n"
    "  if i then\n"
    "    err['source'] = i.source\n"
    "    err['line'] = i.currentline\n"
    "  end\n"
    "  return err\n"
    "end\n";
  luaL_loadbuffer(L, errh, strlen(errh), "@err_handler_def");
  lua_pcall(L, 0, 0, 0);

  lua_pushvalue(L, LUA_GLOBALSINDEX);
  set_error_metatable(L);
  set_table_protection_recursively(L);
  lua_pop(L, 1);
  return L;
}

static uint32_t match_flag_name(const char *s) {
  if (strcasecmp(s, "no-writes") == 0) return FLAG_NO_WRITES;
  if (strcasecmp(s, "allow-oom") == 0) return FLAG_ALLOW_OOM;
  if (strcasecmp(s, "allow-stale") == 0) return FLAG_ALLOW_STALE;
  if (strcasecmp(s, "no-cluster") == 0) return FLAG_NO_CLUSTER;
  if (strcasecmp(s, "allow-cross-slot-keys") == 0) return FLAG_ALLOW_CROSS_SLOT;
  return 0;
}

static int register_fn_read_flags(lua_State *L, uint32_t *out_flags) {
  uint32_t flags = 0;
  int j = 1;
  for (;;) {
    lua_pushnumber(L, j++);
    lua_gettable(L, -2);
    if (lua_type(L, -1) == LUA_TNIL) {
      lua_pop(L, 1);
      break;
    }
    if (!lua_isstring(L, -1)) {
      lua_pop(L, 1);
      return 0;
    }
    uint32_t bit = match_flag_name(lua_tostring(L, -1));
    lua_pop(L, 1);
    if (!bit) return 0;
    flags |= bit;
  }
  *out_flags = flags;
  return 1;
}

static int lua_register_function(lua_State *L) {
  LoadCtx *lctx = get_registry_ptr(L, REGISTRY_LOAD_CTX);
  if (!lctx) {
    push_error_cstr(L, "redis.register_function can only be called on FUNCTION LOAD command");
    return lua_error(L);
  }
  int argc = lua_gettop(L);
  if (argc < 1 || argc > 2) {
    push_error_cstr(L, "wrong number of arguments to redis.register_function");
    return lua_error(L);
  }

  char *name = NULL;
  size_t name_len = 0;
  char *desc = NULL;
  size_t desc_len = 0;
  int has_desc = 0;
  int lua_ref = LUA_NOREF;
  uint32_t flags = 0;
  const char *err = NULL;

  if (argc == 1) {
    if (!lua_istable(L, 1)) {
      err = "calling redis.register_function with a single argument is only applicable to Lua table (representing named arguments).";
      goto fail;
    }
    lua_pushnil(L);
    while (lua_next(L, -2)) {
      if (!lua_isstring(L, -2)) {
        err = "named argument key given to redis.register_function is not a string";
        goto fail;
      }
      const char *key = lua_tostring(L, -2);
      if (strcasecmp(key, "function_name") == 0) {
        if (!lua_isstring(L, -1)) {
          err = "function_name argument given to redis.register_function must be a string";
          goto fail;
        }
        const char *s = lua_tolstring(L, -1, &name_len);
        free(name);
        name = xstrdup_len(s, name_len);
      } else if (strcasecmp(key, "description") == 0) {
        if (!lua_isstring(L, -1)) {
          err = "description argument given to redis.register_function must be a string";
          goto fail;
        }
        const char *s = lua_tolstring(L, -1, &desc_len);
        free(desc);
        desc = xstrdup_len(s, desc_len);
        has_desc = 1;
      } else if (strcasecmp(key, "callback") == 0) {
        if (!lua_isfunction(L, -1)) {
          err = "callback argument given to redis.register_function must be a function";
          goto fail;
        }
        lua_ref = luaL_ref(L, LUA_REGISTRYINDEX);
        continue;
      } else if (strcasecmp(key, "flags") == 0) {
        if (!lua_istable(L, -1)) {
          err = "flags argument to redis.register_function must be a table representing function flags";
          goto fail;
        }
        if (!register_fn_read_flags(L, &flags)) {
          err = "unknown flag given";
          goto fail;
        }
      } else {
        err = "unknown argument given to redis.register_function";
        goto fail;
      }
      lua_pop(L, 1);
    }
    if (!name) {
      err = "redis.register_function must get a function name argument";
      goto fail;
    }
    if (lua_ref == LUA_NOREF) {
      err = "redis.register_function must get a callback argument";
      goto fail;
    }
  } else {
    if (!lua_isstring(L, 1)) {
      err = "first argument to redis.register_function must be a string";
      goto fail;
    }
    const char *s = lua_tolstring(L, 1, &name_len);
    name = xstrdup_len(s, name_len);
    if (!lua_isfunction(L, 2)) {
      err = "second argument to redis.register_function must be a function";
      goto fail;
    }
    lua_ref = luaL_ref(L, LUA_REGISTRYINDEX);
  }

  int res = host_register_function(name, (uint32_t)name_len, desc ? desc : "", (uint32_t)desc_len, has_desc, flags, lua_ref);
  if (res == 1) {
    err = "Library names can only contain letters, numbers, or underscores(_) and must be at least one character long";
    goto fail;
  }
  if (res == 2) {
    err = "Function already exists in the library";
    goto fail;
  }

  free(name);
  free(desc);
  return 0;

fail:
  free(name);
  free(desc);
  if (lua_ref != LUA_NOREF) luaL_unref(L, LUA_REGISTRYINDEX, lua_ref);
  push_error_cstr(L, err);
  return lua_error(L);
}

static lua_State *init_func_state(void) {
  lua_State *L = lua_open();
  register_redis_api(L);

  lua_newtable(L);
  lua_newtable(L);
  lua_pushstring(L, "register_function");
  lua_pushcfunction(L, lua_register_function);
  lua_settable(L, -3);
  register_log_function(L);
  register_version(L);
  set_error_metatable(L);
  lua_setfield(L, -2, "redis");
  set_error_metatable(L);
  set_table_protection_recursively(L);
  lua_setfield(L, LUA_REGISTRYINDEX, REGISTRY_LIBRARY_API);

  lua_pushstring(L, REGISTRY_ERROR_HANDLER);
  static const char *errh =
    "local dbg = debug\n"
    "debug = nil\n"
    "local error_handler = function (err)\n"
    "  local i = dbg.getinfo(2,'nSl')\n"
    "  if i and i.what == 'C' then\n"
    "    i = dbg.getinfo(3,'nSl')\n"
    "  end\n"
    "  if type(err) ~= 'table' then\n"
    "    err = {err='ERR ' .. tostring(err)}\n"
    "  end\n"
    "  if i then\n"
    "    err['source'] = i.source\n"
    "    err['line'] = i.currentline\n"
    "  end\n"
    "  return err\n"
    "end\n"
    "return error_handler";
  luaL_loadbuffer(L, errh, strlen(errh), "@err_handler_def");
  lua_pcall(L, 0, 1, 0);
  lua_settable(L, LUA_REGISTRYINDEX);

  lua_pushvalue(L, LUA_GLOBALSINDEX);
  set_error_metatable(L);
  set_table_protection_recursively(L);
  lua_pop(L, 1);

  lua_pushvalue(L, LUA_GLOBALSINDEX);
  lua_setfield(L, LUA_REGISTRYINDEX, REGISTRY_GLOBALS_API);

  lua_newtable(L);
  lua_newtable(L);
  lua_pushvalue(L, LUA_GLOBALSINDEX);
  lua_setfield(L, -2, "__index");
  lua_enablereadonlytable(L, -1, 1);
  lua_setmetatable(L, -2);
  lua_enablereadonlytable(L, -1, 1);
  lua_replace(L, LUA_GLOBALSINDEX);
  return L;
}

static void eval_count_hook(lua_State *L, lua_Debug *ar) {
  (void)ar;
  RunCtx *rctx = get_registry_ptr(L, REGISTRY_RUN_CTX);
  if (!rctx || rctx->timeout_ms <= 0) return;
  if (host_now_ms() - rctx->start_ms < rctx->timeout_ms) return;
  rctx->timed_out = 1;
  lua_sethook(L, eval_count_hook, LUA_MASKLINE, 0);
  push_error_cstr(L, "Script timed out");
  lua_error(L);
}

static void load_count_hook(lua_State *L, lua_Debug *ar) {
  (void)ar;
  LoadCtx *lctx = get_registry_ptr(L, REGISTRY_LOAD_CTX);
  if (!lctx || lctx->timeout_ms <= 0) return;
  if (host_now_ms() - lctx->start_ms <= lctx->timeout_ms) return;
  lctx->timed_out = 1;
  lua_sethook(L, load_count_hook, LUA_MASKLINE, 0);
  push_error_cstr(L, "FUNCTION LOAD timeout");
  lua_error(L);
}

static void push_packed_array(lua_State *L, const uint8_t *buf, uint32_t len) {
  lua_newtable(L);
  if (!buf || len < 4) return;
  const uint8_t *p = buf;
  const uint8_t *end = buf + len;
  uint32_t count = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
  p += 4;
  for (uint32_t j = 0; j < count && p + 4 <= end; j++) {
    uint32_t slen = (uint32_t)p[0] | ((uint32_t)p[1] << 8) | ((uint32_t)p[2] << 16) | ((uint32_t)p[3] << 24);
    p += 4;
    if (p + slen > end) break;
    lua_pushlstring(L, (const char *)p, slen);
    lua_rawseti(L, -2, (int)(j + 1));
    p += slen;
  }
}

static void finish_call(lua_State *L, RunCtx *rctx, int err) {
  g_gc_count++;
  if (g_gc_count >= 50) {
    lua_gc(L, LUA_GCSTEP, 50);
    g_gc_count = 0;
  }
  lua_sethook(L, NULL, 0, 0);
  save_registry_ptr(L, REGISTRY_RUN_CTX, NULL);

  sb_reset(&g_out);
  if (rctx->timed_out) {
    if (err) lua_pop(L, 1);
    sb_append_cstr(&g_out, "ERR Script timed out");
    return;
  }
  if (err) {
    if (!lua_istable(L, -1)) {
      const char *msg = lua_isstring(L, -1) ? lua_tostring(L, -1) : "execution failure";
      char buf[256];
      int n = snprintf(buf, sizeof(buf), "-ERR Error running script %s, %.100s", rctx->funcname, msg);
      sb_append_sanitized(&g_out, buf, (size_t)n);
      sb_append(&g_out, "\r\n", 2);
    } else {
      ErrInfo info;
      extract_error_info(L, &info);
      sb_append_char(&g_out, '-');
      if (info.msg) sb_append_sanitized(&g_out, info.msg, strlen(info.msg));
      if (info.line && info.source) {
        sb_append_cstr(&g_out, " script: ");
        sb_append_sanitized(&g_out, rctx->funcname, strlen(rctx->funcname));
        sb_append_cstr(&g_out, ", on ");
        sb_append_sanitized(&g_out, info.source, strlen(info.source));
        sb_append_char(&g_out, ':');
        sb_append_sanitized(&g_out, info.line, strlen(info.line));
        sb_append_char(&g_out, '.');
      }
      sb_append(&g_out, "\r\n", 2);
      discard_error_info(&info);
    }
    lua_pop(L, 1);
    return;
  }
  lua_to_resp(L, &g_out, rctx->script_resp, rctx->client_resp, 0);
}

static void swap_func_globals_index(lua_State *L, const char *registry_key) {
  lua_getmetatable(L, LUA_GLOBALSINDEX);
  lua_enablereadonlytable(L, -1, 0);
  lua_getfield(L, LUA_REGISTRYINDEX, registry_key);
  lua_setfield(L, -2, "__index");
  lua_enablereadonlytable(L, -1, 1);
  lua_pop(L, 1);
}

EMSCRIPTEN_KEEPALIVE
int lua_vm_init(void) {
  sb_reset(&g_out);
  if (!g_eval) g_eval = init_eval_state();
  if (!g_func) g_func = init_func_state();
  return (g_eval && g_func) ? 0 : 1;
}

EMSCRIPTEN_KEEPALIVE
void lua_eval_reset(void) {
  if (g_eval) {
    lua_gc(g_eval, LUA_GCCOLLECT, 0);
    lua_close(g_eval);
  }
  g_eval = init_eval_state();
}

EMSCRIPTEN_KEEPALIVE
void lua_func_reset(void) {
  if (g_func) {
    lua_gc(g_func, LUA_GCCOLLECT, 0);
    lua_close(g_func);
  }
  g_func = init_func_state();
}

EMSCRIPTEN_KEEPALIVE
void *lua_alloc(uint32_t n) {
  return malloc(n ? n : 1);
}

EMSCRIPTEN_KEEPALIVE
void lua_free(void *p) {
  free(p);
}

EMSCRIPTEN_KEEPALIVE
const uint8_t *lua_out_ptr(void) {
  return (const uint8_t *)(g_out.data ? g_out.data : "");
}

EMSCRIPTEN_KEEPALIVE
uint32_t lua_out_len(void) {
  return (uint32_t)g_out.len;
}

EMSCRIPTEN_KEEPALIVE
void lua_sha1hex(const uint8_t *data, uint32_t len, char *out41) {
  compute_sha1hex(data, len, out41);
}

EMSCRIPTEN_KEEPALIVE
int lua_eval_compile(const char *sha40, const char *body, uint32_t body_len, uint32_t shebang_len) {
  sb_reset(&g_out);
  if (!g_eval) lua_vm_init();
  char funcname[43];
  funcname[0] = 'f';
  funcname[1] = '_';
  memcpy(funcname + 2, sha40, 40);
  funcname[42] = '\0';

  if (luaL_loadbuffer(g_eval, body + shebang_len, body_len - shebang_len, "@user_script")) {
    const char *err = lua_tostring(g_eval, -1);
    sb_append_cstr(&g_out, "ERR Error compiling script (new function): ");
    if (err) sb_append_sanitized(&g_out, err, strlen(err));
    lua_pop(g_eval, 1);
    return 1;
  }
  lua_setfield(g_eval, LUA_REGISTRYINDEX, funcname);
  return 0;
}

EMSCRIPTEN_KEEPALIVE
int lua_eval_has(const char *sha40) {
  if (!g_eval) return 0;
  char funcname[43];
  funcname[0] = 'f';
  funcname[1] = '_';
  memcpy(funcname + 2, sha40, 40);
  funcname[42] = '\0';
  lua_getfield(g_eval, LUA_REGISTRYINDEX, funcname);
  int exists = !lua_isnil(g_eval, -1);
  lua_pop(g_eval, 1);
  return exists;
}

EMSCRIPTEN_KEEPALIVE
void lua_eval_remove(const char *sha40) {
  if (!g_eval) return;
  char funcname[43];
  funcname[0] = 'f';
  funcname[1] = '_';
  memcpy(funcname + 2, sha40, 40);
  funcname[42] = '\0';
  lua_pushnil(g_eval);
  lua_setfield(g_eval, LUA_REGISTRYINDEX, funcname);
}

EMSCRIPTEN_KEEPALIVE
int lua_eval_run(const char *sha40, const uint8_t *keys_buf, uint32_t keys_len, const uint8_t *args_buf, uint32_t args_len, int client_resp, double timeout_ms) {
  char funcname[43];
  funcname[0] = 'f';
  funcname[1] = '_';
  memcpy(funcname + 2, sha40, 40);
  funcname[42] = '\0';

  lua_getglobal(g_eval, "__redis__err__handler");
  lua_getfield(g_eval, LUA_REGISTRYINDEX, funcname);

  RunCtx rctx = {
    .funcname = sha40,
    .is_eval = 1,
    .script_resp = 2,
    .client_resp = client_resp,
    .start_ms = host_now_ms(),
    .timeout_ms = timeout_ms,
    .timed_out = 0,
  };
  save_registry_ptr(g_eval, REGISTRY_RUN_CTX, &rctx);
  if (timeout_ms > 0) lua_sethook(g_eval, eval_count_hook, LUA_MASKCOUNT, 100000);

  push_packed_array(g_eval, keys_buf, keys_len);
  lua_enablereadonlytable(g_eval, LUA_GLOBALSINDEX, 0);
  lua_setglobal(g_eval, "KEYS");
  lua_enablereadonlytable(g_eval, LUA_GLOBALSINDEX, 1);

  push_packed_array(g_eval, args_buf, args_len);
  lua_enablereadonlytable(g_eval, LUA_GLOBALSINDEX, 0);
  lua_setglobal(g_eval, "ARGV");
  lua_enablereadonlytable(g_eval, LUA_GLOBALSINDEX, 1);

  int err = lua_pcall(g_eval, 0, 1, -2);
  finish_call(g_eval, &rctx, err);
  lua_pop(g_eval, 1);
  return rctx.timed_out ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
int lua_func_load(const char *code, uint32_t code_len, double timeout_ms) {
  sb_reset(&g_out);
  if (!g_func) lua_vm_init();

  swap_func_globals_index(g_func, REGISTRY_LIBRARY_API);
  if (luaL_loadbuffer(g_func, code, code_len, "@user_function")) {
    const char *err = lua_tostring(g_func, -1);
    sb_append_cstr(&g_out, "ERR Error compiling function: ");
    if (err) sb_append_sanitized(&g_out, err, strlen(err));
    lua_pop(g_func, 1);
    swap_func_globals_index(g_func, REGISTRY_GLOBALS_API);
    return 1;
  }

  LoadCtx lctx = {.start_ms = host_now_ms(), .timeout_ms = timeout_ms, .timed_out = 0};
  save_registry_ptr(g_func, REGISTRY_LOAD_CTX, &lctx);
  if (timeout_ms > 0) lua_sethook(g_func, load_count_hook, LUA_MASKCOUNT, 100000);

  int rc = 0;
  if (lua_pcall(g_func, 0, 0, 0)) {
    ErrInfo info;
    extract_error_info(g_func, &info);
    sb_append_cstr(&g_out, "ERR Error registering functions: ");
    if (info.msg) sb_append_sanitized(&g_out, info.msg, strlen(info.msg));
    discard_error_info(&info);
    lua_pop(g_func, 1);
    rc = 1;
  }

  lua_sethook(g_func, NULL, 0, 0);
  save_registry_ptr(g_func, REGISTRY_LOAD_CTX, NULL);
  swap_func_globals_index(g_func, REGISTRY_GLOBALS_API);
  return rc;
}

EMSCRIPTEN_KEEPALIVE
int lua_func_call(int lua_ref, const char *fname, uint32_t fname_len, const uint8_t *keys_buf, uint32_t keys_len, const uint8_t *args_buf, uint32_t args_len, int client_resp, double timeout_ms) {
  char *fn_copy = xstrdup_len(fname, fname_len);
  lua_getfield(g_func, LUA_REGISTRYINDEX, REGISTRY_ERROR_HANDLER);
  lua_rawgeti(g_func, LUA_REGISTRYINDEX, lua_ref);

  RunCtx rctx = {
    .funcname = fn_copy,
    .is_eval = 0,
    .script_resp = 2,
    .client_resp = client_resp,
    .start_ms = host_now_ms(),
    .timeout_ms = timeout_ms,
    .timed_out = 0,
  };
  save_registry_ptr(g_func, REGISTRY_RUN_CTX, &rctx);
  if (timeout_ms > 0) lua_sethook(g_func, eval_count_hook, LUA_MASKCOUNT, 100000);

  push_packed_array(g_func, keys_buf, keys_len);
  push_packed_array(g_func, args_buf, args_len);

  int err = lua_pcall(g_func, 2, 1, -4);
  finish_call(g_func, &rctx, err);
  lua_pop(g_func, 1);
  free(fn_copy);
  return rctx.timed_out ? 1 : 0;
}

EMSCRIPTEN_KEEPALIVE
void lua_func_unref(int lua_ref) {
  if (!g_func || lua_ref == LUA_NOREF) return;
  luaL_unref(g_func, LUA_REGISTRYINDEX, lua_ref);
}
