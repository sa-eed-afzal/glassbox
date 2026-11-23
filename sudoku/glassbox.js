// src/core/errors.ts
var GlassboxErrorCode = {
  VERSION_MISMATCH: "VERSION_MISMATCH",
  PROTOCOL_ERROR: "PROTOCOL_ERROR",
  UNKNOWN_TOOL: "UNKNOWN_TOOL",
  DEADLINE: "DEADLINE",
  REVOKED: "REVOKED",
  POLICY_DENIED: "POLICY_DENIED",
  CONSENT_DENIED: "CONSENT_DENIED",
  UNAUTHORIZED: "UNAUTHORIZED"
};
var GlassboxError = class extends Error {
  code;
  traceId;
  constructor(code, message, opts) {
    super(message, opts?.cause !== void 0 ? { cause: opts.cause } : void 0);
    this.name = "GlassboxError";
    this.code = code;
    if (opts?.traceId !== void 0) this.traceId = opts.traceId;
  }
};

// src/core/codec.ts
function fail(field, msg) {
  throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, `${msg} (field "${field}")`);
}
function str(m, k) {
  if (typeof m[k] !== "string" || m[k].length === 0)
    fail(k, "expected non-empty string");
}
function num(m, k) {
  if (typeof m[k] !== "number" || !Number.isFinite(m[k])) fail(k, "expected finite number");
}
function optStr(m, k) {
  if (k in m && typeof m[k] !== "string") fail(k, "expected string");
}
function optNum(m, k) {
  if (k in m && (typeof m[k] !== "number" || !Number.isFinite(m[k])))
    fail(k, "expected finite number");
}
function wireError(m) {
  const e = m.error;
  if (typeof e !== "object" || e === null) fail("error", "expected {code, message}");
  const err = e;
  if (typeof err.code !== "string" || typeof err.message !== "string") {
    fail("error", "expected {code, message}");
  }
}
function xorPayload(m, payload, validate) {
  const hasP = payload in m;
  const hasE = "error" in m;
  if (hasP === hasE) fail(`${payload}|error`, `exactly one of ${payload}|error required`);
  if (hasP && !validate(m[payload])) fail(payload, "invalid payload");
  if (hasE) wireError(m);
}
function valueXorError(m) {
  xorPayload(m, "value", () => true);
}
var rules = {
  hello: (m) => {
    for (const k of ["v", "sid", "app", "origin", "tab"]) str(m, k);
  },
  "hello.ack": (m) => {
    str(m, "v");
    str(m, "server");
    num(m, "expiresMs");
  },
  error: (m) => {
    str(m, "code");
    str(m, "message");
    optStr(m, "traceId");
  },
  "tool.register": (m) => {
    str(m, "name");
    str(m, "description");
    if ("tier" in m && !["read", "write", "dangerous"].includes(m.tier)) {
      fail("tier", "expected read|write|dangerous");
    }
    optNum(m, "timeoutMs");
  },
  "tool.unregister": (m) => str(m, "name"),
  "tool.call": (m) => {
    num(m, "id");
    str(m, "name");
    num(m, "deadlineMs");
    str(m, "traceId");
  },
  "tool.result": (m) => {
    num(m, "id");
    valueXorError(m);
  },
  "prompt.request": (m) => {
    num(m, "id");
    str(m, "name");
    if (typeof m.args !== "object" || m.args === null || Array.isArray(m.args))
      fail("args", "expected object");
  },
  "prompt.result": (m) => {
    num(m, "id");
    xorPayload(m, "messages", Array.isArray);
  },
  "resource.request": (m) => {
    num(m, "id");
    str(m, "uri");
  },
  "resource.result": (m) => {
    num(m, "id");
    xorPayload(m, "contents", Array.isArray);
  },
  "sampling.request": (m) => {
    num(m, "id");
    if (!Array.isArray(m.messages)) fail("messages", "expected array");
    num(m, "maxTokens");
    optStr(m, "systemPrompt");
  },
  "sampling.result": (m) => {
    num(m, "id");
    valueXorError(m);
  },
  "call.event": (m) => {
    num(m, "id");
    if (!["start", "progress", "end"].includes(m.phase))
      fail("phase", "expected start|progress|end");
    optNum(m, "ms");
  },
  "consent.request": (m) => {
    num(m, "id");
    str(m, "tool");
    str(m, "description");
    if (!["read", "write", "dangerous"].includes(m.tier)) {
      fail("tier", "expected read|write|dangerous");
    }
    num(m, "deadlineMs");
  },
  "consent.result": (m) => {
    num(m, "id");
    if (!["approved", "denied"].includes(m.decision)) {
      fail("decision", "expected approved|denied");
    }
  },
  "session.revoke": (m) => str(m, "reason")
};
function encode(msg) {
  const s = JSON.stringify(msg);
  if (s === void 0) {
    throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "message is not JSON-serializable");
  }
  return s;
}
function decode(frame) {
  let m;
  try {
    m = JSON.parse(frame);
  } catch (e) {
    throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "frame is not valid JSON", {
      cause: e
    });
  }
  if (typeof m !== "object" || m === null || Array.isArray(m)) {
    throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, "frame must be a JSON object");
  }
  const t = m.type;
  if (typeof t !== "string" || !(t in rules)) {
    throw new GlassboxError(GlassboxErrorCode.PROTOCOL_ERROR, `unknown message type: ${String(t)}`);
  }
  rules[t](m);
  return m;
}

// src/core/qr.ts
var TOTAL_CW = [
  0,
  26,
  44,
  70,
  100,
  134,
  172,
  196,
  242,
  292,
  346,
  404,
  466,
  532,
  581,
  655,
  733,
  815,
  901,
  991,
  1085,
  1156,
  1258,
  1364,
  1474,
  1588,
  1706,
  1828,
  1921,
  2051,
  2185,
  2323,
  2465,
  2611,
  2761,
  2876,
  3034,
  3196,
  3362,
  3532,
  3706
];
var EC_CODEWORDS = [
  7,
  10,
  13,
  17,
  10,
  16,
  22,
  28,
  15,
  26,
  36,
  44,
  20,
  36,
  52,
  64,
  26,
  48,
  72,
  88,
  36,
  64,
  96,
  112,
  40,
  72,
  108,
  130,
  48,
  88,
  132,
  156,
  60,
  110,
  160,
  192,
  72,
  130,
  192,
  224,
  80,
  150,
  224,
  264,
  96,
  176,
  260,
  308,
  104,
  198,
  288,
  352,
  120,
  216,
  320,
  384,
  132,
  240,
  360,
  432,
  144,
  280,
  408,
  480,
  168,
  308,
  448,
  532,
  180,
  338,
  504,
  588,
  196,
  364,
  546,
  650,
  224,
  416,
  600,
  700,
  224,
  442,
  644,
  750,
  252,
  476,
  690,
  816,
  270,
  504,
  750,
  900,
  300,
  560,
  810,
  960,
  312,
  588,
  870,
  1050,
  336,
  644,
  952,
  1110,
  360,
  700,
  1020,
  1200,
  390,
  728,
  1050,
  1260,
  420,
  784,
  1140,
  1350,
  450,
  812,
  1200,
  1440,
  480,
  868,
  1290,
  1530,
  510,
  924,
  1350,
  1620,
  540,
  980,
  1440,
  1710,
  570,
  1036,
  1530,
  1800,
  570,
  1064,
  1590,
  1890,
  600,
  1120,
  1680,
  1980,
  630,
  1204,
  1770,
  2100,
  660,
  1260,
  1860,
  2220,
  720,
  1316,
  1950,
  2310,
  750,
  1372,
  2040,
  2430
];
var EC_BLOCKS = [
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  1,
  2,
  2,
  1,
  2,
  2,
  4,
  1,
  2,
  4,
  4,
  2,
  4,
  4,
  4,
  2,
  4,
  6,
  5,
  2,
  4,
  6,
  6,
  2,
  5,
  8,
  8,
  4,
  5,
  8,
  8,
  4,
  5,
  8,
  11,
  4,
  8,
  10,
  11,
  4,
  9,
  12,
  16,
  4,
  9,
  16,
  16,
  6,
  10,
  12,
  18,
  6,
  10,
  17,
  16,
  6,
  11,
  16,
  19,
  6,
  13,
  18,
  21,
  7,
  14,
  21,
  25,
  8,
  16,
  20,
  25,
  8,
  17,
  23,
  25,
  9,
  17,
  23,
  34,
  9,
  18,
  25,
  30,
  10,
  20,
  27,
  32,
  12,
  21,
  29,
  35,
  12,
  23,
  34,
  37,
  12,
  25,
  34,
  40,
  13,
  26,
  35,
  42,
  14,
  28,
  38,
  45,
  15,
  29,
  40,
  48,
  16,
  31,
  43,
  51,
  17,
  33,
  45,
  54,
  18,
  35,
  48,
  57,
  19,
  37,
  51,
  60,
  19,
  38,
  53,
  63,
  20,
  40,
  56,
  66,
  21,
  43,
  59,
  70,
  22,
  45,
  62,
  74,
  24,
  47,
  65,
  77,
  25,
  49,
  68,
  81
];
var ECL_BITS = { L: 1, M: 0, Q: 3, H: 2 };
var LVL_IDX = { L: 0, M: 1, Q: 2, H: 3 };
var ECL_IDX_FROM_BITS = [1, 0, 3, 2];
var LOG = new Uint8Array(256);
var EXP = new Uint8Array(512);
{
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 256) x ^= 285;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
}
function gmul(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}
function bitLen(x) {
  let n = 0;
  while (x !== 0) {
    n++;
    x >>>= 1;
  }
  return n;
}
function genPoly(degree) {
  let poly = new Uint8Array([1]);
  for (let i = 0; i < degree; i++) {
    const factor = new Uint8Array([1, EXP[i]]);
    const out = new Uint8Array(poly.length + 1);
    for (let a = 0; a < poly.length; a++)
      for (let b = 0; b < factor.length; b++) out[a + b] = out[a + b] ^ gmul(poly[a], factor[b]);
    poly = out;
  }
  return poly;
}
function rsEncode(data, gen) {
  const res = new Uint8Array(data.length + gen.length - 1);
  res.set(data);
  for (let i = 0; i < data.length; i++) {
    const coef = res[i];
    if (coef !== 0)
      for (let j = 1; j < gen.length; j++) res[i + j] = res[i + j] ^ gmul(gen[j], coef);
  }
  return res.slice(data.length);
}
function alignmentPositions(version) {
  if (version < 2) return [];
  const n = Math.floor(version / 7) + 2;
  const size = 17 + 4 * version;
  const step = size === 145 ? 26 : Math.ceil((size - 13) / (2 * n - 2)) * 2;
  const coords = [size - 7];
  for (let i = 1; i < n - 1; i++) coords.push(coords[i - 1] - step);
  coords.push(6);
  coords.reverse();
  const out = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      if (i === 0 && j === 0 || i === 0 && j === n - 1 || i === n - 1 && j === 0) continue;
      out.push([coords[i], coords[j]]);
    }
  return out;
}
function buildReserved(size, version) {
  const res = new Uint8Array(size * size);
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr >= 0 && rr < size && cc >= 0 && cc < size) res[rr * size + cc] = 1;
      }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    res[i * size + 6] = 1;
    res[6 * size + i] = 1;
  }
  for (const [ar, ac] of alignmentPositions(version))
    for (let r = -2; r <= 2; r++) for (let c = -2; c <= 2; c++) res[(ar + r) * size + (ac + c)] = 1;
  for (let i = 0; i < 15; i++) {
    if (i < 6) res[i * size + 8] = 1;
    else if (i < 8) res[(i + 1) * size + 8] = 1;
    else res[(size - 15 + i) * size + 8] = 1;
    if (i < 8) res[8 * size + size - 1 - i] = 1;
    else if (i < 9) res[8 * size + 7] = 1;
    else res[8 * size + 15 - 1 - i] = 1;
  }
  res[(size - 8) * size + 8] = 1;
  if (version >= 7)
    for (let i = 0; i < 18; i++) {
      const r = Math.floor(i / 3);
      const c = i % 3 + size - 11;
      res[r * size + c] = 1;
      res[c * size + r] = 1;
    }
  return res;
}
function drawFixedModules(mod, size, version) {
  const finder = (r0, c0) => {
    for (let r = -1; r <= 7; r++)
      for (let c = -1; c <= 7; c++) {
        const rr = r0 + r;
        const cc = c0 + c;
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
        const dark = r >= 0 && r <= 6 && (c === 0 || c === 6) || c >= 0 && c <= 6 && (r === 0 || r === 6) || r >= 2 && r <= 4 && c >= 2 && c <= 4;
        mod[rr * size + cc] = dark ? 1 : 0;
      }
  };
  finder(0, 0);
  finder(0, size - 7);
  finder(size - 7, 0);
  for (let i = 8; i < size - 8; i++) {
    const v = i % 2 === 0 ? 1 : 0;
    mod[i * size + 6] = v;
    mod[6 * size + i] = v;
  }
  for (const [ar, ac] of alignmentPositions(version))
    for (let r = -2; r <= 2; r++)
      for (let c = -2; c <= 2; c++)
        mod[(ar + r) * size + (ac + c)] = r === -2 || r === 2 || c === -2 || c === 2 || r === 0 && c === 0 ? 1 : 0;
  if (version >= 7) {
    const bits = versionBits(version);
    for (let i = 0; i < 18; i++) {
      const b = bits >> i & 1;
      const r = Math.floor(i / 3);
      const c = i % 3 + size - 11;
      mod[r * size + c] = b;
      mod[c * size + r] = b;
    }
  }
}
function formatBits(lvl, mask) {
  const data5 = ECL_BITS[lvl] << 3 | mask;
  let d = data5 << 10;
  while (bitLen(d) >= 11) d ^= 1335 << bitLen(d) - 11;
  return (data5 << 10 | d) ^ 21522;
}
function versionBits(version) {
  let d = version << 12;
  while (bitLen(d) >= 13) d ^= 7973 << bitLen(d) - 13;
  return version << 12 | d;
}
function writeFormatInfo(mod, size, lvl, mask) {
  const fmt = formatBits(lvl, mask);
  for (let i = 0; i < 15; i++) {
    const b = fmt >> i & 1;
    if (i < 6) mod[i * size + 8] = b;
    else if (i < 8) mod[(i + 1) * size + 8] = b;
    else mod[(size - 15 + i) * size + 8] = b;
    if (i < 8) mod[8 * size + size - 1 - i] = b;
    else if (i < 9) mod[8 * size + 7] = b;
    else mod[8 * size + 15 - 1 - i] = b;
  }
  mod[(size - 8) * size + 8] = 1;
}
function pickVersion(dataLen, lvlIdx) {
  for (let v = 1; v <= 40; v++) {
    const dataCw = TOTAL_CW[v] - EC_CODEWORDS[(v - 1) * 4 + lvlIdx];
    const usable = dataCw * 8 - 4 - (v < 10 ? 8 : 16);
    if (dataLen * 8 <= usable) return v;
  }
  throw new Error("glassbox qr: payload too large for any QR version");
}
function dataCodewords(version, lvlIdx, data) {
  const dataCw = TOTAL_CW[version] - EC_CODEWORDS[(version - 1) * 4 + lvlIdx];
  const ccBits = version < 10 ? 8 : 16;
  const bits = [];
  const push = (val, n) => {
    for (let i = n - 1; i >= 0; i--) bits.push(val >>> i & 1);
  };
  push(4, 4);
  push(data.length, ccBits);
  for (const b of data) push(b, 8);
  const total = dataCw * 8;
  if (bits.length + 4 <= total) push(0, 4);
  while (bits.length % 8 !== 0) bits.push(0);
  const pads = [236, 17];
  let pad = 0;
  while (bits.length < total) {
    push(pads[pad % 2], 8);
    pad++;
  }
  const out = new Uint8Array(dataCw);
  for (let i = 0; i < dataCw; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = v << 1 | bits[i * 8 + j];
    out[i] = v;
  }
  return out;
}
function encodeAll(data, version, lvlIdx) {
  const totalCw = TOTAL_CW[version];
  const ecCw = EC_CODEWORDS[(version - 1) * 4 + lvlIdx];
  const dataCw = totalCw - ecCw;
  const blocks = EC_BLOCKS[(version - 1) * 4 + lvlIdx];
  const g2 = totalCw % blocks;
  const g1 = blocks - g2;
  const d1 = Math.floor(dataCw / blocks);
  const d2 = d1 + 1;
  const ecPer = Math.floor(totalCw / blocks) - d1;
  const gen = genPoly(ecPer);
  const dc = [];
  const ec = [];
  let off = 0;
  for (let b = 0; b < blocks; b++) {
    const ds = b < g1 ? d1 : d2;
    const block = data.subarray(off, off + ds);
    dc.push(block);
    ec.push(rsEncode(block, gen));
    off += ds;
  }
  const out = new Uint8Array(totalCw);
  let idx = 0;
  for (let i = 0; i < d2; i++)
    for (let b = 0; b < blocks; b++) if (i < (b < g1 ? d1 : d2)) out[idx++] = dc[b][i];
  for (let i = 0; i < ecPer; i++) for (let b = 0; b < blocks; b++) out[idx++] = ec[b][i];
  return out;
}
function* placementOrder(size, reserved) {
  let inc = -1;
  let row = size - 1;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    while (true) {
      for (let c = 0; c < 2; c++) {
        if (reserved[row * size + col - c] === 0) yield [row, col - c];
      }
      row += inc;
      if (row < 0 || row >= size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
}
function maskAt(mask, r, c) {
  switch (mask) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return r * c % 2 + r * c % 3 === 0;
    case 6:
      return (r * c % 2 + r * c % 3) % 2 === 0;
    default:
      return (r * c % 3 + (r + c) % 2) % 2 === 0;
  }
}
function applyMask(mask, mod, reserved, size) {
  for (let r = 0; r < size; r++)
    for (let c = 0; c < size; c++)
      if (reserved[r * size + c] === 0)
        mod[r * size + c] = mod[r * size + c] ^ (maskAt(mask, r, c) ? 1 : 0);
}
function n1Line(size, get) {
  let points = 0;
  let run = 0;
  let last = -1;
  for (let i = 0; i < size; i++) {
    const v = get(i);
    if (v === last) run++;
    else {
      if (run >= 5) points += 3 + (run - 5);
      last = v;
      run = 1;
    }
  }
  if (run >= 5) points += 3 + (run - 5);
  return points;
}
function n3Line(size, get) {
  let points = 0;
  let bits = 0;
  for (let i = 0; i < size; i++) {
    bits = bits << 1 & 2047 | get(i);
    if (i >= 10 && (bits === 1488 || bits === 93)) points += 40;
  }
  return points;
}
function penalty(mod, size) {
  let p = 0;
  for (let r = 0; r < size; r++) p += n1Line(size, (i) => mod[r * size + i]);
  for (let c = 0; c < size; c++) p += n1Line(size, (i) => mod[i * size + c]);
  for (let r = 0; r < size - 1; r++)
    for (let c = 0; c < size - 1; c++) {
      const v = mod[r * size + c] + mod[r * size + c + 1] + mod[(r + 1) * size + c] + mod[(r + 1) * size + c + 1];
      if (v === 0 || v === 4) p += 3;
    }
  for (let r = 0; r < size; r++) p += n3Line(size, (i) => mod[r * size + i]);
  for (let c = 0; c < size; c++) p += n3Line(size, (i) => mod[i * size + c]);
  let dark = 0;
  for (let i = 0; i < mod.length; i++) dark += mod[i];
  p += Math.abs(Math.ceil(dark * 100 / mod.length / 5) - 10) * 10;
  return p;
}
function encodeQr(text, opts = {}) {
  if (text.length === 0) throw new Error("glassbox qr: empty payload");
  const lvl = opts.ecLevel ?? "L";
  const lvlIdx = LVL_IDX[lvl];
  const data = new Uint8Array(new TextEncoder().encode(text));
  const version = pickVersion(data.length, lvlIdx);
  const all = encodeAll(dataCodewords(version, lvlIdx, data), version, lvlIdx);
  const size = 17 + 4 * version;
  const mod = new Uint8Array(size * size);
  const reserved = buildReserved(size, version);
  drawFixedModules(mod, size, version);
  let bitIdx = 7;
  let byteIdx = 0;
  for (const [r, c] of placementOrder(size, reserved)) {
    mod[r * size + c] = byteIdx < all.length ? all[byteIdx] >>> bitIdx & 1 : 0;
    bitIdx--;
    if (bitIdx < 0) {
      bitIdx = 7;
      byteIdx++;
    }
  }
  let best = 0;
  let bestPenalty = Infinity;
  for (let m = 0; m < 8; m++) {
    writeFormatInfo(mod, size, lvl, m);
    applyMask(m, mod, reserved, size);
    const p = penalty(mod, size);
    applyMask(m, mod, reserved, size);
    if (p < bestPenalty) {
      bestPenalty = p;
      best = m;
    }
  }
  applyMask(best, mod, reserved, size);
  writeFormatInfo(mod, size, lvl, best);
  return { version, mask: best, size, modules: mod };
}
function decodeQrPayload(qr) {
  try {
    const { version, size, modules } = qr;
    if (version < 1 || version > 40 || size !== 17 + 4 * version) return null;
    const reserved = buildReserved(size, version);
    const get = (r, c) => modules[r * size + c];
    const posA = [
      [0, 8],
      [1, 8],
      [2, 8],
      [3, 8],
      [4, 8],
      [5, 8],
      [7, 8],
      [8, 8],
      [8, 7]
    ];
    for (let i = 9; i < 15; i++) posA.push([8, 14 - i]);
    const posB = [];
    for (let i = 0; i < 8; i++) posB.push([8, size - 1 - i]);
    for (let i = 8; i < 15; i++) posB.push([size - 15 + i, 8]);
    const toVal = (pos) => pos.reduce((v, [r, c], i) => v | get(r, c) << i, 0);
    const va = toVal(posA);
    if (va !== toVal(posB)) return null;
    const xored = va ^ 21522;
    const data5 = xored >> 10;
    let rem = data5 << 10;
    while (bitLen(rem) >= 11) rem ^= 1335 << bitLen(rem) - 11;
    if (rem !== (xored & 1023)) return null;
    const ecl = data5 >> 3;
    const mask = data5 & 7;
    if (ecl > 3) return null;
    let bit = 0;
    let nBits = 0;
    const cw = [];
    for (const [r, c] of placementOrder(size, reserved)) {
      bit = bit << 1 | get(r, c) ^ (maskAt(mask, r, c) ? 1 : 0);
      if (++nBits === 8) {
        cw.push(bit);
        bit = 0;
        nBits = 0;
      }
    }
    if (cw.length !== TOTAL_CW[version]) return null;
    const lvlIdx = ECL_IDX_FROM_BITS[ecl];
    const totalCw = TOTAL_CW[version];
    const dataCw = totalCw - EC_CODEWORDS[(version - 1) * 4 + lvlIdx];
    const blocks = EC_BLOCKS[(version - 1) * 4 + lvlIdx];
    const g2 = totalCw % blocks;
    const g1 = blocks - g2;
    const d1 = Math.floor(dataCw / blocks);
    const d2 = d1 + 1;
    const ecPer = Math.floor(totalCw / blocks) - d1;
    const dataPos = (i, b) => i < d1 ? i * blocks + b : i * blocks + b - g1;
    for (let b = 0; b < blocks; b++) {
      const ds = b < g1 ? d1 : d2;
      const block = [];
      for (let i = 0; i < ds; i++) block.push(cw[dataPos(i, b)]);
      for (let i = 0; i < ecPer; i++) block.push(cw[dataCw + i * blocks + b]);
      for (let k = 0; k < ecPer; k++) {
        let s = 0;
        for (const v of block) s = s === 0 ? v : EXP[LOG[s] + k] ^ v;
        if (s !== 0) return null;
      }
    }
    const dBytes = [];
    for (let b = 0; b < blocks; b++)
      for (let i = 0; i < (b < g1 ? d1 : d2); i++) dBytes.push(cw[dataPos(i, b)]);
    if (dBytes.length !== dataCw) return null;
    const totalBits = dataCw * 8;
    const bitAt = (i) => dBytes[Math.floor(i / 8)] >> 7 - i % 8 & 1;
    const mode = bitAt(0) << 3 | bitAt(1) << 2 | bitAt(2) << 1 | bitAt(3);
    if (mode !== 4) return null;
    const ccn = version < 10 ? 8 : 16;
    let cc = 0;
    for (let i = 4; i < 4 + ccn; i++) cc = cc << 1 | bitAt(i);
    if (4 + ccn + cc * 8 > totalBits) return null;
    const payload = [];
    const byteStart = (4 + ccn) % 8;
    for (let i = 4 + ccn; i < 4 + ccn + cc * 8; i++) {
      if (i % 8 === byteStart) payload.push(0);
      payload[payload.length - 1] = payload[payload.length - 1] << 1 | bitAt(i);
    }
    let p = 4 + ccn + cc * 8;
    const term = Math.min(4, totalBits - p);
    for (let i = 0; i < term; i++) if (bitAt(p + i) !== 0) return null;
    p += term;
    while (p % 8 !== 0) {
      if (bitAt(p) !== 0) return null;
      p++;
    }
    for (let byte = 0; p + byte * 8 < totalBits; byte++) {
      const expected = byte % 2 === 0 ? 236 : 17;
      for (let j = 0; j < 8; j++)
        if (bitAt(p + byte * 8 + j) !== (expected >> 7 - j & 1)) return null;
    }
    return new TextDecoder().decode(new Uint8Array(payload));
  } catch {
    return null;
  }
}
function qrToSvg(qr, opts = {}) {
  const quiet = opts.quiet ?? 2;
  const n = qr.size + quiet * 2;
  let d = "";
  for (let r = 0; r < qr.size; r++) {
    let c = 0;
    while (c < qr.size) {
      if (qr.modules[r * qr.size + c] !== 0) {
        let w = 0;
        while (c + w < qr.size && qr.modules[r * qr.size + c + w] !== 0) w++;
        d += `M${c + quiet} ${r + quiet}h${w}v1h-${w}z`;
        c += w;
      } else {
        c++;
      }
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${n} ${n}" shape-rendering="crispEdges" fill="currentColor" aria-hidden="true"><path d="${d}"/></svg>`;
}

// src/core/version.ts
var PROTOCOL_VERSION = "glassbox/v1";

// sdk/glassbox.ts
function b64urlDecode(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return atob(b64);
}
function matchesType(t, v) {
  switch (t) {
    case "string":
      return typeof v === "string";
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "boolean":
      return typeof v === "boolean";
    case "array":
      return Array.isArray(v);
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v);
    case "null":
      return v === null;
    default:
      return true;
  }
}
function checkSchema(s, v, path) {
  if (Array.isArray(s.type)) {
    if (s.type.every((t) => typeof t !== "string" || !matchesType(t, v))) {
      return `${path}: expected ${s.type.join(" | ")}, got ${v === null ? "null" : Array.isArray(v) ? "array" : typeof v}`;
    }
  } else if (typeof s.type === "string" && !matchesType(s.type, v)) {
    return `${path}: expected ${s.type}, got ${v === null ? "null" : Array.isArray(v) ? "array" : typeof v}`;
  }
  if (Array.isArray(s.enum)) {
    const ok = s.enum.some((e) => JSON.stringify(e) === JSON.stringify(v));
    if (!ok)
      return `${path}: not one of [${s.enum.map((e) => JSON.stringify(e)).join(", ")}]`;
  }
  if (typeof v === "number") {
    if (typeof s.minimum === "number" && v < s.minimum)
      return `${path}: below minimum ${s.minimum}`;
    if (typeof s.maximum === "number" && v > s.maximum)
      return `${path}: above maximum ${s.maximum}`;
  }
  if (typeof v === "string") {
    if (typeof s.minLength === "number" && v.length < s.minLength)
      return `${path}: shorter than ${s.minLength} chars`;
    if (typeof s.maxLength === "number" && v.length > s.maxLength)
      return `${path}: longer than ${s.maxLength} chars`;
  }
  if (matchesType("object", v)) {
    if (s.properties !== void 0 && s.properties !== null) {
      if (!matchesType("object", v) || Array.isArray(v)) return `${path}: expected object`;
      const props = s.properties;
      const obj = v;
      if (Array.isArray(s.required)) {
        for (const r of s.required) {
          if (typeof r === "string" && !(r in obj)) return `${path}: missing required "${r}"`;
        }
      }
      for (const [k, ps] of Object.entries(props)) {
        if (k in obj) {
          const err = checkSchema(ps, obj[k], `${path}.${k}`);
          if (err) return err;
        }
      }
    }
  } else if (Array.isArray(v) && s.items !== void 0 && s.items !== null) {
    if (!matchesType("array", v)) return `${path}: expected array`;
    const items = s.items;
    for (let i = 0; i < v.length; i++) {
      const err = checkSchema(items, v[i], `${path}[${i}]`);
      if (err) return err;
    }
  }
  return null;
}
function validateSampleAnswer(schema, value) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return null;
  return checkSchema(schema, value, "$");
}
function mkSampleField(f) {
  const out = { name: f.name, type: f.type, required: f.required };
  if (f.hint !== void 0) out.hint = f.hint;
  if (f.enum) out.enum = f.enum;
  return out;
}
function samplingFields(schema) {
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) {
    return [{ name: "answer", type: "textarea", required: true }];
  }
  const s = schema;
  const props = s.properties !== null && typeof s.properties === "object" && !Array.isArray(s.properties) ? s.properties : null;
  if (!props || Object.keys(props).length === 0) {
    return [{ name: "answer", type: "textarea", required: true }];
  }
  const required = new Set(
    (Array.isArray(s.required) ? s.required : []).filter(
      (r) => typeof r === "string"
    )
  );
  return Object.entries(props).map(([name, p]) => {
    const hint = typeof p.description === "string" ? p.description : "";
    const req = required.has(name);
    if (Array.isArray(p.enum)) {
      const all = p.enum;
      if (all.length > 0 && all.every((e) => typeof e === "string")) {
        return mkSampleField({ name, type: "select", required: req, hint, enum: all });
      }
      return mkSampleField({
        name,
        type: "text",
        required: req,
        hint: hint || `one of: ${all.map((e) => JSON.stringify(e)).join(", ")}`
      });
    }
    const types = Array.isArray(p.type) ? p.type : [p.type];
    if (types.includes("boolean"))
      return mkSampleField({ name, type: "checkbox", required: req, hint });
    if (types.includes("number") || types.includes("integer"))
      return mkSampleField({ name, type: "number", required: req, hint });
    return mkSampleField({ name, type: "text", required: req, hint });
  });
}
function decodeConnectCode(code) {
  try {
    const p = JSON.parse(b64urlDecode(code.trim()));
    if (typeof p.host !== "string" || !Number.isInteger(p.port)) throw new Error("malformed code");
    return { host: p.host, port: p.port, app: typeof p.app === "string" ? p.app : "app" };
  } catch (e) {
    throw new Error(
      `glassbox: invalid connect code (${e instanceof Error ? e.message : String(e)})`
    );
  }
}
function pageOrigin() {
  try {
    return globalThis.location?.origin ?? "http://localhost";
  } catch {
    return "http://localhost";
  }
}
function defaultStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null;
  }
}
var Glassbox = class {
  app;
  status = "disconnected";
  tools = /* @__PURE__ */ new Map();
  prompts = /* @__PURE__ */ new Map();
  resources = /* @__PURE__ */ new Map();
  sampler = null;
  pendingSampling = /* @__PURE__ */ new Set();
  listeners = /* @__PURE__ */ new Map();
  ws = null;
  session = null;
  ackResolve = null;
  reconnectAttempts = 0;
  reconnectTimer = null;
  reconnectNextAt = null;
  intentional = true;
  gen = 0;
  // How the next "connected" was opened: a fresh session from a pasted/QR code, or a
  // re-attach of an existing session (reload-resume / reconnect). The widget's feed
  // wording depends on it ("● connected" vs "↻ reconnected (session resumed)"), and a
  // fresh code after a bridge restart is NOT a resume (spec §5.2).
  connectKind = "fresh";
  storage;
  tab;
  constructor(app, opts = {}) {
    this.app = app;
    this.tab = `tab-${Math.random().toString(36).slice(2, 10)}`;
    this.storage = opts.storage ?? null;
    const stored = this.readStored();
    if (stored) void this.resume(stored).catch(() => {
    });
  }
  // ---- registration (spec §4.2) ----
  tool(name, description, a, b) {
    const OPT_KEYS = /* @__PURE__ */ new Set(["tier", "timeoutMs", "inputSchema"]);
    const TIERS = /* @__PURE__ */ new Set(["read", "write", "dangerous"]);
    let opts = {};
    let fn;
    if (typeof a === "function") {
      fn = a;
    } else if (typeof b === "function") {
      fn = b;
      const given = a ?? {};
      const keys = Object.keys(given);
      const isOptionEntry = (k) => {
        const v = given[k];
        if (k === "tier") return typeof v === "string";
        if (k === "timeoutMs") return typeof v === "number";
        return OPT_KEYS.has(k) && typeof v === "object" && v !== null;
      };
      if (keys.length > 0 && keys.every(isOptionEntry)) {
        const tier = given.tier;
        if (tier !== void 0 && !TIERS.has(String(tier))) {
          throw new Error(
            `glassbox: tool "${name}": unknown tier "${String(tier)}" (want read|write|dangerous)`
          );
        }
        const timeout = given.timeoutMs;
        if (typeof timeout === "number" && !(Number.isFinite(timeout) && timeout > 0)) {
          throw new Error(`glassbox: tool "${name}": timeoutMs must be a positive number`);
        }
        opts = given;
      } else {
        const mixed = keys.filter(isOptionEntry);
        if (mixed.length > 0) {
          throw new Error(
            `glassbox: tool "${name}": ${mixed.join(", ")} mixed with schema properties. Put the schema under inputSchema, e.g. { tier, inputSchema: { type: "object", properties: {...} } }`
          );
        }
        opts.inputSchema = { type: "object", properties: given };
      }
    } else {
      throw new Error("glassbox: tool(name, description, \u2026, handler) \u2014 a handler is required");
    }
    this.tools.set(name, { def: { ...opts, description }, fn });
    if (this.status === "connected") this.sendRegister(name);
    return this;
  }
  untool(name) {
    if (this.tools.delete(name) && this.status === "connected") {
      this.send({ type: "tool.unregister", name });
    }
    return this;
  }
  prompt(name, def, fn) {
    this.prompts.set(name, { def, fn });
    return this;
  }
  resource(uri, description, fn) {
    this.resources.set(uri, { description, fn });
    return this;
  }
  sampling(fn) {
    this.sampler = fn;
    return this;
  }
  // ---- events ----
  on(event, cb) {
    let set = this.listeners.get(event);
    if (!set) {
      set = /* @__PURE__ */ new Set();
      this.listeners.set(event, set);
    }
    set.add(cb);
    return this;
  }
  emit(event, data) {
    for (const cb of this.listeners.get(event) ?? []) {
      try {
        cb(data);
      } catch {
      }
    }
  }
  // ---- connect / reconnect (spec §5.2) ----
  /** Exchange a one-shot connect code for a session, then open the session channel. */
  async connect(code) {
    const target = decodeConnectCode(code);
    this.gen++;
    this.clearReconnect();
    this.intentional = false;
    this.connectKind = "fresh";
    this.setStatus("connecting");
    const res = await fetch(`http://${target.host}:${target.port}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, origin: pageOrigin() })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      this.setStatus("disconnected");
      throw new Error(err.error?.message ?? `session exchange failed (HTTP ${res.status})`);
    }
    const v = await res.json();
    this.session = {
      sid: v.sid,
      sessionToken: v.sessionToken,
      host: target.host,
      port: target.port
    };
    this.reconnectAttempts = 0;
    this.persist();
    await this.openSocket();
  }
  /** Auto-resume a stored session (spec §5.2): refresh with sid+sessionToken, then reconnect. */
  async resume(stored) {
    const g = ++this.gen;
    this.session = stored;
    this.intentional = false;
    this.connectKind = "resume";
    this.setStatus("connecting");
    try {
      const res = await fetch(`http://${stored.host}:${stored.port}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sid: stored.sid, sessionToken: stored.sessionToken })
      });
      if (g !== this.gen) return;
      if (!res.ok) {
        this.session = null;
        this.forget();
        this.setStatus("disconnected");
        return;
      }
      const v = await res.json();
      if (g !== this.gen) return;
      this.session = { ...stored, sid: v.sid, sessionToken: v.sessionToken };
      this.persist();
      this.reconnectAttempts = 0;
      await this.openSocket();
    } catch {
      if (g !== this.gen) return;
      this.scheduleReconnect();
    }
  }
  disconnect() {
    this.gen++;
    this.intentional = true;
    this.clearReconnect();
    this.ws?.close();
    this.ws = null;
    this.setStatus("disconnected");
  }
  /**
   * Ask the bridge to drop this session server-side (immediate RST, spec §5.2),
   * then tear down locally and forget the stored session. Wired to the widget's
   * Disconnect button — unlike `disconnect()`, the bridge forgets the session too.
   */
  revokeSession(reason = "user-disconnect") {
    try {
      this.send({ type: "session.revoke", reason });
    } catch {
    }
    this.gen++;
    this.intentional = true;
    this.clearReconnect();
    this.session = null;
    this.forget();
    this.ws?.close();
    this.ws = null;
    this.setStatus("expired");
    this.emit("revoke", { reason });
  }
  /**
   * Resolve a pending consent request (spec §7.3). The programmatic path for
   * pages with no visible widget (tests, headless); the widget calls this too.
   */
  resolveConsent(id, decision) {
    this.send({ type: "consent.result", id, decision });
  }
  /**
   * Reconnect progress for UIs (spec §5.2): attempts so far and the time until
   * the next automatic retry, or null when no retry is scheduled.
   */
  get reconnectProgress() {
    if (this.reconnectTimer === null || this.reconnectNextAt === null) return null;
    return {
      attempt: this.reconnectAttempts,
      nextInMs: Math.max(0, this.reconnectNextAt - Date.now())
    };
  }
  /**
   * Trigger a reconnect attempt immediately (widget "Reconnect" affordance,
   * spec §5.2). No-op outside `reconnecting`/`offline` — the dead-end states
   * (`disconnected`, `expired`) need a fresh connect code, not a retry.
   */
  reconnectNow() {
    if (this.intentional || !this.session) return;
    if (this.status !== "reconnecting" && this.status !== "offline") return;
    this.clearReconnect();
    this.setStatus("reconnecting");
    void this.tryReconnect();
  }
  /**
   * Answer a sampling request (spec §5.7) — used by the widget form when no
   * `sampling()` handler is registered on the page, and by tests / headless.
   */
  respondSampling(id, value, error) {
    if (this.pendingSampling.size > 0) this.pendingSampling.delete(id);
    if (error) this.send({ type: "sampling.result", id, error });
    else this.send({ type: "sampling.result", id, value: value ?? null });
  }
  setStatus(s) {
    if (this.status === s) return;
    this.status = s;
    this.emit(
      "status",
      // "connected" carries the kind of exchange that produced it, so UIs never call a
      // fresh pairing a "resume" (widget feed, spec §5.2)
      s === "connected" ? { status: s, resumed: this.connectKind === "resume" } : { status: s }
    );
  }
  /** Reconnect: refresh with the stored sid+sessionToken, backoff 250 ms → 4 s (spec §5.2). */
  scheduleReconnect() {
    if (this.intentional || this.reconnectTimer !== null || !this.session) return;
    const delay = Math.min(250 * 2 ** this.reconnectAttempts, 4e3);
    this.reconnectAttempts++;
    this.reconnectNextAt = Date.now() + delay;
    this.setStatus(delay >= 4e3 ? "offline" : "reconnecting");
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectNextAt = null;
      void this.tryReconnect();
    }, delay);
  }
  async tryReconnect() {
    const s = this.session;
    if (!s) return;
    this.connectKind = "resume";
    try {
      const res = await fetch(`http://${s.host}:${s.port}/session`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sid: s.sid, sessionToken: s.sessionToken })
      });
      if (!res.ok) {
        this.session = null;
        this.forget();
        this.setStatus("expired");
        this.emit("error", {
          code: "SESSION_EXPIRED",
          message: "session expired \u2014 paste a new connect code"
        });
        return;
      }
      const v = await res.json();
      this.session = { ...s, sid: v.sid, sessionToken: v.sessionToken };
      this.persist();
      this.setStatus("connecting");
      await this.openSocket();
    } catch {
      this.scheduleReconnect();
    }
  }
  clearReconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.reconnectNextAt = null;
  }
  openSocket() {
    const s = this.session;
    const ws = new WebSocket(`ws://${s.host}:${s.port}/session`);
    this.ws = ws;
    let settled = false;
    const timeout = setTimeout(() => {
      if (!settled) ws.close();
    }, 5e3);
    const ack = new Promise((resolve, reject) => {
      this.ackResolve = resolve;
      const fail2 = (e) => {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      };
      ws.onerror = () => fail2(new Error("session channel error"));
      ws.onclose = () => {
        fail2(new Error("session channel closed"));
      };
    });
    ws.onopen = () => {
      ws.send(
        encode({
          type: "hello",
          v: PROTOCOL_VERSION,
          sid: s.sid,
          app: this.app,
          origin: pageOrigin(),
          tab: this.tab
        })
      );
    };
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = decode(String(ev.data));
      } catch (e) {
        this.emit("error", {
          code: "PROTOCOL_ERROR",
          message: e instanceof Error ? e.message : String(e)
        });
        ws.close();
        return;
      }
      if (msg.type === "hello.ack") {
        clearTimeout(timeout);
        if (!settled) {
          settled = true;
          this.ackResolve?.(msg);
        }
        this.ackResolve = null;
        this.reconnectAttempts = 0;
        this.setStatus("connected");
        this.registerAll();
        this.emit("ready", msg);
        ws.onerror = null;
        ws.onclose = () => this.scheduleReconnect();
        return;
      }
      void this.handleFrame(msg);
    };
    return ack.then(() => void 0).catch((e) => {
      this.intentional = false;
      this.setStatus(this.session ? "reconnecting" : "disconnected");
      this.scheduleReconnect();
      throw e;
    });
  }
  // ---- frame handling (spec §5.8) ----
  async handleFrame(msg) {
    switch (msg.type) {
      // SDK-side change (M3): page errors expose the call's traceId so the widget
      // feed can show "✗ tool — PAGE_ERROR: … (trace tr-N)" (wire traceId, spec §5.8).
      case "tool.call": {
        const entry = this.tools.get(msg.name);
        if (!entry) {
          this.send({
            type: "tool.result",
            id: msg.id,
            error: { code: "PAGE_ERROR", message: `no tool "${msg.name}" on this page` }
          });
          this.emit("error", {
            code: "PAGE_ERROR",
            message: `no tool "${msg.name}" on this page`,
            traceId: msg.traceId
          });
          return;
        }
        const t0 = Date.now();
        this.emit("call", { name: msg.name, args: msg.args, phase: "start", ms: 0 });
        let error = null;
        try {
          const value = await entry.fn(msg.args ?? {});
          this.send({ type: "tool.result", id: msg.id, value: value ?? null });
        } catch (e) {
          error = { code: "PAGE_ERROR", message: e instanceof Error ? e.message : String(e) };
          this.send({
            type: "tool.result",
            id: msg.id,
            error: { code: error.code, message: error.message }
          });
        }
        this.emit("call", {
          name: msg.name,
          args: msg.args,
          phase: "end",
          ms: Date.now() - t0,
          ...error ? { error: { code: error.code, message: error.message, traceId: msg.traceId } } : {}
        });
        return;
      }
      case "prompt.request": {
        const entry = this.prompts.get(msg.name);
        if (!entry) {
          this.send({
            type: "prompt.result",
            id: msg.id,
            error: { code: "PAGE_ERROR", message: `no prompt "${msg.name}"` }
          });
          return;
        }
        try {
          const messages = await entry.fn(msg.args);
          this.send({ type: "prompt.result", id: msg.id, messages });
        } catch (e) {
          this.send({
            type: "prompt.result",
            id: msg.id,
            error: { code: "PAGE_ERROR", message: String(e) }
          });
        }
        return;
      }
      case "resource.request": {
        const entry = this.resources.get(msg.uri);
        if (!entry) {
          this.send({
            type: "resource.result",
            id: msg.id,
            error: { code: "PAGE_ERROR", message: `no resource "${msg.uri}"` }
          });
          return;
        }
        try {
          const value = await entry.fn();
          const text = typeof value === "string" ? value : JSON.stringify(value ?? null);
          this.send({
            type: "resource.result",
            id: msg.id,
            contents: [{ uri: msg.uri, mimeType: "application/json", text }]
          });
        } catch (e) {
          this.send({
            type: "resource.result",
            id: msg.id,
            error: { code: "PAGE_ERROR", message: String(e) }
          });
        }
        return;
      }
      case "sampling.request": {
        if (!this.sampler) {
          this.pendingSampling.add(msg.id);
          this.emit("sampling", {
            id: msg.id,
            messages: msg.messages,
            ...msg.systemPrompt !== void 0 ? { systemPrompt: msg.systemPrompt } : {},
            maxTokens: msg.maxTokens,
            ...msg.schema !== void 0 ? { schema: msg.schema } : {}
          });
          return;
        }
        try {
          const value = await this.sampler({
            messages: msg.messages,
            ...msg.systemPrompt !== void 0 ? { systemPrompt: msg.systemPrompt } : {},
            maxTokens: msg.maxTokens,
            ...msg.schema !== void 0 ? { schema: msg.schema } : {}
          });
          this.send({ type: "sampling.result", id: msg.id, value: value ?? null });
        } catch (e) {
          this.send({
            type: "sampling.result",
            id: msg.id,
            error: { code: "PAGE_ERROR", message: String(e) }
          });
        }
        return;
      }
      case "error":
        this.emit("error", {
          code: msg.code,
          message: msg.message,
          ...msg.traceId !== void 0 ? { traceId: msg.traceId } : {}
        });
        return;
      case "consent.request":
        this.emit("consent", {
          id: msg.id,
          tool: msg.tool,
          description: msg.description,
          args: msg.args,
          tier: msg.tier,
          deadlineMs: msg.deadlineMs
        });
        return;
      case "session.revoke":
        this.session = null;
        this.forget();
        this.clearReconnect();
        this.intentional = true;
        this.ws?.close();
        this.ws = null;
        this.setStatus("expired");
        this.emit("revoke", { reason: msg.reason });
        return;
      default:
        return;
    }
  }
  // ---- wire ----
  send(msg) {
    const ws = this.ws;
    if (ws && ws.readyState === 1) ws.send(encode(msg));
  }
  sendRegister(name) {
    const entry = this.tools.get(name);
    if (!entry) return;
    const { def } = entry;
    const m = {
      type: "tool.register",
      name,
      description: def.description
    };
    if (def.tier) m.tier = def.tier;
    if (def.timeoutMs) m.timeoutMs = def.timeoutMs;
    if (def.inputSchema) m.inputSchema = def.inputSchema;
    this.send(m);
  }
  registerAll() {
    for (const name of this.tools.keys()) this.sendRegister(name);
  }
  // ---- persistence (survives reload, spec §5.2) ----
  key() {
    return `glassbox.session.${this.app}`;
  }
  persist() {
    if (!this.session) return;
    try {
      this.store()?.setItem(this.key(), JSON.stringify(this.session));
    } catch {
    }
  }
  forget() {
    try {
      this.store()?.removeItem(this.key());
    } catch {
    }
  }
  store() {
    return this.storage ?? defaultStorage();
  }
  readStored() {
    try {
      const raw = this.store()?.getItem(this.key());
      if (!raw) return null;
      const v = JSON.parse(raw);
      return v && typeof v.sid === "string" && typeof v.sessionToken === "string" ? v : null;
    } catch {
      return null;
    }
  }
};
function storedSession(app) {
  try {
    const raw = defaultStorage()?.getItem(`glassbox.session.${app}`);
    if (!raw) return null;
    const v = JSON.parse(raw);
    return v && typeof v.sid === "string" && typeof v.sessionToken === "string" ? v : null;
  } catch {
    return null;
  }
}
var CSS = `
/* Two-phase placement (\xA7SPEC-WIDGET): fixed in both phases, so the page never
   reflows and never needs to "scroll back" after pairing. Pairing is centred with
   inset+auto margins \u2014 NOT transform \u2014 because a transformed ancestor would
   re-anchor the consent dialog (z-index 2147483000) to the widget instead of
   the viewport. */
.gb-widget{font:13px/1.45 system-ui,sans-serif;border:1px solid #444;border-radius:8px;padding:10px 12px;background:#111;color:#ddd;box-sizing:border-box;position:fixed;z-index:2147482000;inline-size:min(360px,calc(100dvw - 32px));max-block-size:calc(100dvb - 32px);overflow:auto;overscroll-behavior:contain;scrollbar-gutter:stable;box-shadow:0 6px 24px rgba(0,0,0,.45)}
.gb-widget[data-phase="pairing"]{inset:0;margin:auto;block-size:fit-content;box-shadow:0 6px 24px rgba(0,0,0,.45),0 0 0 100vmax rgba(0,0,0,.55)}
.gb-widget[data-phase="live"]{inset:auto max(16px,env(safe-area-inset-right,0px)) max(16px,env(safe-area-inset-bottom,0px)) auto;margin:0;inline-size:min(320px,calc(100dvw - 32px));max-block-size:min(60dvb,420px)}
.gb-widget[data-phase="live"]:not([data-expanded="true"])>.gb-row,
.gb-widget[data-phase="live"]:not([data-expanded="true"])>.gb-qr,
.gb-widget[data-phase="live"]:not([data-expanded="true"])>.gb-feed{display:none}
.gb-expand{display:none;background:#1c1408;color:#fbbf24;border-color:#d97706!important;flex:0 0 auto}
.gb-widget[data-phase="live"] .gb-expand{display:inline-flex}
/* explicit inline mount keeps the pre-two-phase behaviour for apps that opt out */
.gb-widget[data-placement="inline"]{position:static;inset:auto;margin:8px 0;max-block-size:none;overflow:visible;box-shadow:none}
.gb-widget[data-placement="inline"] .gb-expand{display:none}
.gb-widget .gb-row{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px}
.gb-widget input{flex:1 1 200px;min-width:0;background:#1c1c1c;border:1px solid #555;border-radius:5px;color:#eee;padding:5px 8px;font:inherit}
.gb-widget button{flex:0 0 auto;background:#2b6cb0;color:#fff;border:0;border-radius:5px;padding:5px 12px;cursor:pointer;font:inherit}
.gb-widget button.gb-disconnect{background:#555;flex:0 0 auto}
.gb-widget button.gb-reconnect{background:#b45309;flex:0 0 auto}
.gb-widget .gb-status{font-weight:600}
.gb-widget .gb-feed{margin-top:6px;max-height:120px;overflow:auto;font-size:12px;color:#aaa;word-break:break-word}
.gb-widget .gb-feed div{padding:1px 0;border-top:1px dashed #333}
.gb-widget .gb-feed .gb-session{color:#7dd3fc}
.gb-widget .gb-feed .gb-feed-err{color:#fca5a5;cursor:pointer}
.gb-widget .gb-feed .gb-feed-detail{color:#8a93a6;padding-left:12px;white-space:pre-wrap;word-break:break-word}
.gb-consent{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2147483000;width:max-content;max-width:min(480px,calc(100vw - 24px));padding:10px;border:1px solid #d97706;border-radius:6px;background:#1c1408;box-sizing:border-box}
.gb-consent .gb-consent-title{font-weight:700;color:#fbbf24;margin-bottom:4px}
.gb-consent .gb-consent-desc{margin-bottom:6px;color:#ddd}
.gb-consent .gb-consent-args{margin:6px 0;padding:6px;background:#000;border-radius:4px;font:11px/1.4 ui-monospace,monospace;color:#a5f3fc;white-space:pre-wrap;word-break:break-word;max-height:120px;overflow:auto}
.gb-consent .gb-consent-meta{font-size:11px;color:#fbbf24;margin-bottom:6px}
.gb-consent .gb-consent-actions{display:flex;gap:6px}
.gb-consent .gb-consent-approve{background:#15803d}
.gb-consent .gb-consent-deny{background:#b91c1c}
.gb-sample{margin-top:8px;padding:10px;border:1px solid #0369a1;border-radius:6px;background:#081420}
.gb-sample .gb-sample-q{margin-bottom:6px;color:#ddd;font-weight:600}
.gb-sample .gb-sample-field{margin:4px 0;display:flex;gap:6px;align-items:center}
.gb-sample .gb-sample-name{min-width:90px;color:#7dd3fc;font-size:12px;text-align:right}
.gb-sample .gb-sample-hint{font-size:11px;color:#888}
.gb-sample input,.gb-sample select,.gb-sample textarea{flex:1;min-width:0;background:#001018;border:1px solid #155e75;border-radius:4px;color:#e2e8f0;padding:4px 6px;font:inherit}
.gb-sample textarea{min-height:56px;width:100%}
.gb-sample .gb-sample-err{color:#fca5a5;font-size:12px;margin-top:4px}
.gb-sample .gb-sample-actions{display:flex;gap:6px;margin-top:6px}
.gb-sample .gb-sample-submit{background:#0369a1}
.gb-sample .gb-sample-cancel{background:#555}
.gb-widget .gb-consent-wait{margin-top:6px;padding:6px 8px;border:1px solid #d97706;border-radius:5px;background:#1c1408;color:#fbbf24;font-size:12px;cursor:pointer}
.gb-widget .gb-qr{margin-top:6px;display:flex;flex-wrap:wrap;gap:10px;align-items:center}
.gb-widget .gb-qr svg{width:132px;height:132px;flex:0 0 auto}
.gb-widget .gb-qr .gb-qr-note{font-size:11px;color:#888}
.gb-consent .gb-consent-approve:focus{outline:2px solid #93c5fd;outline-offset:1px}
.gb-sr{position:absolute;width:1px;height:1px;margin:-1px;overflow:hidden;white-space:nowrap}
@media (max-width:480px){.gb-widget{padding:8px 10px}.gb-widget .gb-qr svg{width:112px;height:112px}.gb-widget[data-phase="live"]{inline-size:calc(100dvw - 24px);inset-inline:12px;inset-block-end:max(12px,env(safe-area-inset-bottom,0px))}}
`;
var STATUS_TEXT = {
  disconnected: "\u25CB disconnected",
  connecting: "\u2026 connecting",
  connected: "\u25CF connected",
  reconnecting: "\u21BB reconnecting",
  offline: "\u2715 bridge unreachable \u2014 retrying every 4 s (if it restarted, paste a NEW code)",
  expired: "\u2715 session expired or revoked \u2014 new code needed"
};
function widgetStatusText(status, attempt = 0) {
  const transient = status === "reconnecting" || status === "offline";
  return transient && attempt > 0 ? `${STATUS_TEXT[status]} \u2014 attempt ${attempt}` : STATUS_TEXT[status];
}
function pasteHint(status) {
  return status === "expired" || status === "disconnected" || status === "offline" ? "paste a NEW connect code" : "paste connect code";
}
function widgetPhase(status) {
  return status === "connected" ? "live" : "pairing";
}
function widgetCss() {
  return CSS;
}
function cycleFocusIndex(current, count, shift) {
  if (count <= 0) return -1;
  if (current < 0) return shift ? count - 1 : 0;
  return (current + (shift ? count - 1 : 1)) % count;
}
function samplingQuestion(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (typeof m === "string") return truncateText(m);
    if (m !== null && typeof m === "object") {
      const c = m.content;
      if (typeof c === "string") return truncateText(c);
      if (Array.isArray(c)) {
        const s = c.map(
          (p) => p !== null && typeof p === "object" && "text" in p ? String(p.text) : ""
        ).join(" ");
        if (s) return truncateText(s);
      }
    }
  }
  return "please answer";
}
function truncateText(s, maxLen = 90) {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > maxLen ? `${t.slice(0, maxLen - 3)}\u2026` : t || "please answer";
}
function renderWidget(gbox, opts = {}) {
  const el = document.createElement("div");
  el.className = "gb-widget";
  el.setAttribute(
    "data-placement",
    opts.placement === "inline" || opts.mount !== void 0 ? "inline" : "auto"
  );
  el.setAttribute("data-expanded", "false");
  let phase = null;
  const style = document.createElement("style");
  style.textContent = CSS;
  el.append(style);
  const status = document.createElement("div");
  status.className = "gb-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  const toggle = document.createElement("button");
  toggle.className = "gb-expand";
  toggle.type = "button";
  toggle.textContent = "\u25B4 activity";
  toggle.setAttribute("aria-expanded", "false");
  toggle.setAttribute("aria-label", "Show Glassbox activity feed");
  const feed = document.createElement("div");
  feed.className = "gb-feed";
  const row = document.createElement("div");
  row.className = "gb-row";
  const input = document.createElement("input");
  input.placeholder = "paste connect code";
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Connect";
  row.append(input, btn);
  const reconnectBtn = document.createElement("button");
  reconnectBtn.type = "button";
  reconnectBtn.className = "gb-reconnect";
  reconnectBtn.textContent = "Reconnect";
  reconnectBtn.hidden = true;
  reconnectBtn.title = "Retry the reconnect now (spec \xA75.2)";
  const disconnectBtn = document.createElement("button");
  disconnectBtn.type = "button";
  disconnectBtn.className = "gb-disconnect";
  disconnectBtn.textContent = "Disconnect";
  disconnectBtn.title = "Revoke this session on the bridge (spec \xA75.2)";
  row.append(reconnectBtn, disconnectBtn);
  const qrSlot = document.createElement("div");
  qrSlot.className = "gb-qr";
  qrSlot.hidden = true;
  const qrNote = document.createElement("div");
  qrNote.className = "gb-qr-note";
  qrSlot.append(qrNote);
  const updateQr = () => {
    const code = input.value.trim();
    if (code === "") {
      qrSlot.hidden = true;
      return;
    }
    let ok = false;
    try {
      const qr = encodeQr(code);
      ok = decodeQrPayload(qr) === code;
      qrSlot.innerHTML = qrToSvg(qr);
    } catch {
      qrSlot.replaceChildren();
    }
    qrSlot.append(qrNote);
    qrNote.textContent = ok ? "QR of the code above \u2014 scan it from a phone (simulated scan: OK)" : "simulated scan FAILED \u2014 the code above does not round-trip; check for typos";
    qrSlot.title = ok ? "simulated scan: OK" : "simulated scan: FAILED";
    qrSlot.hidden = false;
  };
  input.addEventListener("input", updateQr);
  let expanded = false;
  toggle.addEventListener("click", () => {
    expanded = !expanded;
    el.setAttribute("data-expanded", String(expanded));
    toggle.setAttribute("aria-expanded", String(expanded));
    toggle.textContent = expanded ? "\u25BE activity" : "\u25B4 activity";
    toggle.setAttribute(
      "aria-label",
      expanded ? "Hide Glassbox activity feed" : "Show Glassbox activity feed"
    );
    if (expanded) feed.scrollTop = feed.scrollHeight;
  });
  el.append(status, toggle, row, qrSlot, feed);
  reconnectBtn.addEventListener("click", () => {
    note("\u21BB reconnecting (manual)");
    gbox.reconnectNow();
  });
  const trimFeed = () => {
    while (feed.children.length > 30) feed.lastChild?.remove();
  };
  const note = (text, session = false) => {
    const d = document.createElement("div");
    if (session) d.className = "gb-session";
    d.textContent = text;
    feed.prepend(d);
    trimFeed();
  };
  const noteError = (e, tool) => {
    const line = document.createElement("div");
    line.className = "gb-feed-err";
    line.title = "click for details";
    const trace = e.traceId !== void 0 ? ` \xB7 ${e.traceId}` : "";
    line.textContent = `${tool ? `${tool} \u2014 ` : ""}${e.code}: ${truncateText(e.message, 48)}${trace}`;
    const detail = document.createElement("div");
    detail.className = "gb-feed-detail";
    detail.textContent = e.message;
    detail.hidden = true;
    line.addEventListener("click", () => detail.hidden = !detail.hidden);
    feed.prepend(line, detail);
    trimFeed();
  };
  status.textContent = STATUS_TEXT[gbox.status];
  const updateStatusLine = () => {
    const p = gbox.reconnectProgress;
    status.textContent = widgetStatusText(gbox.status, p?.attempt ?? 0);
    reconnectBtn.hidden = !(gbox.status === "reconnecting" || gbox.status === "offline");
    input.placeholder = pasteHint(gbox.status);
    const next = widgetPhase(gbox.status);
    if (phase !== next) {
      phase = next;
      el.setAttribute("data-phase", next);
      expanded = false;
      el.setAttribute("data-expanded", "false");
      toggle.setAttribute("aria-expanded", "false");
      toggle.textContent = "\u25B4 activity";
      toggle.setAttribute("aria-label", "Show Glassbox activity feed");
      input.blur?.();
    }
  };
  updateStatusLine();
  gbox.on("status", (s) => {
    if (s.status === "connected")
      note(s.resumed ? "\u21BB reconnected (session resumed)" : "\u25CF connected", true);
    updateStatusLine();
  });
  gbox.on(
    "call",
    (c) => {
      if (c.phase === "start") note(`\u25B6 ${c.name}`);
      else if (c.error)
        noteError(c.error, c.name);
      else note(`\u2713 ${c.name} (${c.ms} ms)`);
    }
  );
  gbox.on(
    "error",
    (e) => noteError({
      code: e.code ?? "ERROR",
      message: e.message ?? "error",
      ...!e.traceId ? {} : { traceId: e.traceId }
    })
  );
  gbox.on("revoke", (r) => note(`revoked: ${r.reason}`));
  let consentQueue = [];
  let activeConsent = null;
  const chip = document.createElement("div");
  chip.className = "gb-consent-wait";
  chip.hidden = true;
  chip.setAttribute("role", "status");
  chip.setAttribute("aria-live", "polite");
  chip.title = "Click to re-show the consent prompt";
  el.append(chip);
  const showChip = () => {
    const head = consentQueue[0];
    if (!head) {
      chip.hidden = true;
      return;
    }
    chip.hidden = false;
    const extra = consentQueue.length > 1 ? ` \xB7 +${consentQueue.length - 1} in queue` : "";
    chip.textContent = `\u23F3 waiting for consent: ${head.tool}${extra}`;
  };
  const fmtMs = (ms) => `${Math.max(0, Math.ceil(ms / 1e3))}s`;
  const showNext = () => {
    if (activeConsent) {
      clearInterval(activeConsent.countdown);
      activeConsent.modal.remove();
      activeConsent = null;
    }
    const req = consentQueue[0];
    if (!req) {
      showChip();
      return;
    }
    const modal = document.createElement("div");
    modal.className = "gb-consent";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", `Consent: ${req.tool}`);
    const live = document.createElement("div");
    live.className = "gb-sr";
    live.setAttribute("aria-live", "assertive");
    live.textContent = `Consent requested: ${req.tool}. Deny is focused. Enter or Escape denies; Tab to Approve and press Enter to approve.`;
    const title = document.createElement("div");
    title.className = "gb-consent-title";
    title.textContent = `Consent: ${req.tool}`;
    const desc = document.createElement("div");
    desc.className = "gb-consent-desc";
    desc.textContent = req.description;
    const meta = document.createElement("div");
    meta.className = "gb-consent-meta";
    meta.textContent = `tier: ${req.tier} \xB7 deadline ${fmtMs(req.expiresAt - Date.now())}`;
    const argsEl = document.createElement("div");
    argsEl.className = "gb-consent-args";
    argsEl.textContent = JSON.stringify(req.args ?? {}, null, 2);
    const actions = document.createElement("div");
    actions.className = "gb-consent-actions";
    const approve = document.createElement("button");
    approve.type = "button";
    approve.className = "gb-consent-approve";
    approve.textContent = "Approve";
    const deny = document.createElement("button");
    deny.type = "button";
    deny.className = "gb-consent-deny";
    deny.textContent = "Deny";
    actions.append(approve, deny);
    modal.append(live, title, desc, meta, argsEl, actions);
    el.append(modal);
    const finish = (decision) => {
      if (!activeConsent || activeConsent.req.id !== req.id) return;
      clearInterval(activeConsent.countdown);
      gbox.resolveConsent(req.id, decision);
      note(`${decision === "approved" ? "\u2713 consent: " : "\u2715 consent denied: "}${req.tool}`);
      consentQueue = consentQueue.filter((c) => c.id !== req.id);
      showNext();
    };
    approve.addEventListener("click", () => finish("approved"));
    deny.addEventListener("click", () => finish("denied"));
    const countdown = setInterval(() => {
      meta.textContent = `tier: ${req.tier} \xB7 deadline ${fmtMs(req.expiresAt - Date.now())}`;
      if (req.expiresAt - Date.now() <= 0) {
        note(`\u23F1 consent timed out: ${req.tool}`);
        consentQueue = consentQueue.filter((c) => c.id !== req.id);
        showNext();
      }
    }, 250);
    activeConsent = { req, modal, meta, countdown, finish };
    showChip();
    deny.focus();
  };
  gbox.on("consent", (r) => {
    if (consentQueue.some((c) => c.id === r.id)) return;
    consentQueue.push({ ...r, expiresAt: Date.now() + r.deadlineMs });
    if (consentQueue.length > 1) {
      note(`\u23F3 consent queued: ${r.tool} (+${consentQueue.length - 1} waiting)`);
    }
    if (activeConsent) showChip();
    else showNext();
  });
  document.addEventListener("keydown", (ev) => {
    if (!activeConsent) return;
    const t = ev.target;
    const typing = t instanceof HTMLElement && ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName);
    if (ev.key === "Escape") {
      ev.preventDefault();
      activeConsent.finish("denied");
    } else if (ev.key === "Enter" && !typing && !(t instanceof HTMLButtonElement)) {
      ev.preventDefault();
      activeConsent.finish("denied");
    } else if (ev.key === "Tab") {
      ev.preventDefault();
      const buttons = Array.from(activeConsent.modal.querySelectorAll("button"));
      const current = buttons.indexOf(document.activeElement);
      buttons[cycleFocusIndex(current, buttons.length, ev.shiftKey)]?.focus();
    }
  });
  document.addEventListener("mousedown", (ev) => {
    if (!activeConsent) return;
    const t = ev.target;
    if (t instanceof Node && !activeConsent.modal.contains(t)) {
      clearInterval(activeConsent.countdown);
      activeConsent.modal.remove();
      activeConsent = null;
      showChip();
    }
  });
  chip.addEventListener("click", () => {
    if (!activeConsent && consentQueue.length > 0) showNext();
  });
  gbox.on("sampling", (req) => {
    note(`\u2B21 sampling request (${req.messages.length} msg${req.messages.length === 1 ? "" : "s"})`);
    const box = document.createElement("div");
    box.className = "gb-sample";
    const q = document.createElement("div");
    q.className = "gb-sample-q";
    q.textContent = samplingQuestion(req.messages);
    const fields = samplingFields(req.schema);
    const inputs = /* @__PURE__ */ new Map();
    for (const f of fields) {
      const fieldEl = document.createElement("div");
      fieldEl.className = "gb-sample-field";
      if (f.type === "checkbox") {
        const cb = document.createElement("input");
        cb.type = "checkbox";
        inputs.set(f.name, cb);
        const label = document.createElement("span");
        label.textContent = `${f.name}${f.required ? " *" : ""}`;
        fieldEl.append(cb, label);
      } else {
        const name = document.createElement("span");
        name.className = "gb-sample-name";
        name.textContent = `${f.name}${f.required ? " *" : ""}`;
        let control;
        if (f.type === "select") {
          const sel = document.createElement("select");
          for (const opt of f.enum ?? []) {
            const o = document.createElement("option");
            o.value = opt;
            o.textContent = opt;
            sel.appendChild(o);
          }
          control = sel;
        } else if (f.type === "textarea") {
          control = document.createElement("textarea");
        } else {
          const inp = document.createElement("input");
          if (f.type === "number") inp.type = "number";
          control = inp;
        }
        inputs.set(f.name, control);
        fieldEl.append(name, control);
        if (f.hint) {
          const hint = document.createElement("div");
          hint.className = "gb-sample-hint";
          hint.textContent = f.hint;
          fieldEl.appendChild(hint);
        }
      }
      box.appendChild(fieldEl);
    }
    const errEl = document.createElement("div");
    errEl.className = "gb-sample-err";
    const actions = document.createElement("div");
    actions.className = "gb-sample-actions";
    const submit = document.createElement("button");
    submit.type = "button";
    submit.className = "gb-sample-submit";
    submit.textContent = "Submit";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "gb-sample-cancel";
    cancel.textContent = "Cancel";
    actions.append(submit, cancel);
    const showErr = (msg) => errEl.textContent = msg;
    let firstField = null;
    let invalids = 0;
    const collect = () => {
      const out = {};
      for (const f of fields) {
        const el2 = inputs.get(f.name);
        if (!el2) continue;
        if (f.type === "checkbox") {
          out[f.name] = el2.checked;
          continue;
        }
        const raw = el2.value ?? "";
        if (raw === "") {
          continue;
        }
        if (f.type === "number") {
          const n = Number(raw);
          if (!Number.isFinite(n)) return { err: `"${f.name}" must be a number` };
          out[f.name] = n;
        } else {
          out[f.name] = raw;
        }
      }
      return { answer: out };
    };
    const failOnce = (msg) => {
      invalids++;
      if (invalids >= 2) {
        gbox.respondSampling(req.id, void 0, {
          code: "PAGE_ERROR",
          message: `sampling answer rejected: ${msg}`
        });
        done(`\u2715 sampling: ${msg}`);
        return true;
      }
      showErr(`repair \u2014 ${msg}`);
      return false;
    };
    const done = (msg) => {
      note(msg);
      box.remove();
    };
    submit.addEventListener("click", () => {
      const { answer, err } = collect();
      if (err) {
        if (failOnce(err)) return;
        return;
      }
      const verr = validateSampleAnswer(req.schema, answer);
      if (verr !== null) {
        if (failOnce(verr)) return;
        return;
      }
      gbox.respondSampling(req.id, answer);
      done("\u2713 sampling answered");
    });
    cancel.addEventListener("click", () => {
      gbox.respondSampling(req.id, void 0, {
        code: "PAGE_ERROR",
        message: "sampling cancelled"
      });
      done("\u2715 sampling cancelled");
    });
    box.append(q, errEl, actions);
    el.append(box);
    for (const v of inputs.values()) {
      if (v instanceof HTMLInputElement || v instanceof HTMLTextAreaElement || v instanceof HTMLSelectElement) {
        if (!firstField) firstField = v;
      }
    }
    firstField?.focus();
  });
  disconnectBtn.addEventListener("click", () => {
    note("\u21A9 disconnecting (revoking session)");
    gbox.revokeSession("user-disconnect");
  });
  const doConnect = () => {
    const code = input.value.trim();
    if (!code) return;
    input.value = "";
    updateQr();
    gbox.connect(code).catch((e) => note(`! ${e.message}`));
  };
  btn.addEventListener("click", doConnect);
  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") doConnect();
  });
  const mount = typeof opts.mount === "string" ? document.querySelector(opts.mount) : opts.mount;
  if (mount) mount.appendChild(el);
  else (document.body ?? document.documentElement).appendChild(el);
  return el;
}
export {
  Glassbox,
  cycleFocusIndex,
  decodeConnectCode,
  pasteHint,
  renderWidget,
  samplingFields,
  storedSession,
  validateSampleAnswer,
  widgetCss,
  widgetPhase,
  widgetStatusText
};
