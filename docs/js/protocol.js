// SiegeSeal protocol — JavaScript port.
//
// Byte-for-byte compatible with the C++ library in ../../src: the same
// canonical encoding, the same domain tags, Ed25519 (tweetnacl) and SHA-256
// (WebCrypto). An envelope signed here verifies with `siegeseal verify-envelope`
// and vice versa.
//
// Works in the browser (nacl loaded as a global) and in Node ≥ 19
// (set globalThis.nacl = require("tweetnacl") before importing).

export const VERSION = 1;
const TAG_ENV = "SIEGESEAL/ENVELOPE/v1";
const TAG_RCPT = "SIEGESEAL/RECEIPT/v1";
const TAG_TREATY = "SIEGESEAL/TREATY/v1";

const te = new TextEncoder();
const nacl = () => {
  if (!globalThis.nacl) throw new Error("tweetnacl not loaded");
  return globalThis.nacl;
};

// ---- hex & bytes -----------------------------------------------------------
const HEX = Array.from({ length: 256 }, (_, i) => i.toString(16).padStart(2, "0"));
export function toHex(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += HEX[bytes[i]];
  return s;
}
export function fromHex(hex, expectLen) {
  if (typeof hex !== "string" || hex.length % 2 || !/^[0-9a-fA-F]*$/.test(hex))
    throw new Error("not a hex string");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substring(i * 2, i * 2 + 2), 16);
  if (expectLen !== undefined && out.length !== expectLen)
    throw new Error(`expected ${expectLen} bytes, got ${out.length}`);
  return out;
}
export function randomBytes(n) {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}
export async function sha256(bytes) {
  return new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
}

// Canonical writer: big-endian integers, u32 length prefixes. Mirrors wire.hpp.
class Writer {
  constructor() { this.parts = []; this.len = 0; }
  push(u8) { this.parts.push(u8); this.len += u8.length; }
  u8(v) { this.push(Uint8Array.of(v & 0xff)); }
  u32(v) {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v >>> 0);
    this.push(b);
  }
  u64(v) {
    if (!Number.isSafeInteger(v) || v < 0) throw new Error("u64 out of range");
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(v));
    this.push(b);
  }
  raw(bytes) { this.push(bytes); }
  str(s) { const b = te.encode(s); this.u32(b.length); this.push(b); }
  bytes() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.length; }
    return out;
  }
}

// C++ sorts std::string bytewise; JS sorts UTF-16 units. Compare UTF-8 bytes.
function byteCompare(a, b) {
  const x = te.encode(a), y = te.encode(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) if (x[i] !== y[i]) return x[i] - y[i];
  return x.length - y.length;
}

// ---- keys --------------------------------------------------------------------
export function generateSeed() { return toHex(randomBytes(32)); }
export function publicKeyFromSeed(seedHex) {
  return toHex(nacl().sign.keyPair.fromSeed(fromHex(seedHex, 32)).publicKey);
}
function signBytes(seedHex, msg) {
  const kp = nacl().sign.keyPair.fromSeed(fromHex(seedHex, 32));
  return toHex(nacl().sign.detached(msg, kp.secretKey));
}
// Signature checks are the expensive step, and the app re-reads the same
// letters on every sync. Results are remembered, keyed by the key, the
// signature AND the exact signed bytes: a letter whose text changed under a
// genuine signature is a different key and is checked from scratch.
const CACHE_MAX = 5000;
function remember(map, key, value) {
  if (map.size >= CACHE_MAX) map.delete(map.keys().next().value); // drop the oldest
  map.set(key, value);
  return value;
}
const verified = new Map();
export const stats = { verifications: 0, cacheHits: 0 };
function verifyBytes(pubHex, msg, sigHex) {
  if (typeof pubHex !== "string" || typeof sigHex !== "string") return false;
  const key = pubHex + sigHex + toHex(msg);
  const hit = verified.get(key);
  if (hit !== undefined) { stats.cacheHits++; return hit; }
  stats.verifications++;
  let ok = false;
  try { ok = nacl().sign.detached.verify(msg, fromHex(sigHex, 64), fromHex(pubHex, 32)); } catch {}
  return remember(verified, key, ok);
}
// Same as C++ fingerprint(): first 8 bytes of SHA-256(pub), upper-case, groups of 4.
export async function fingerprint(pubHex) {
  const h = toHex((await sha256(fromHex(pubHex, 32))).slice(0, 8)).toUpperCase();
  return h.match(/.{4}/g).join("-");
}

// ---- envelopes -----------------------------------------------------------------
// JSON shape used in the classroom store:
//   { v, from, to, seq, ts, nonce(32 hex), prev(64 hex), body, sig(128 hex) }
export const ZERO_PREV = "0".repeat(64);

export function checkShape(e) {
  const ok =
    e && typeof e === "object" &&
    e.v === VERSION &&
    typeof e.from === "string" && typeof e.to === "string" && typeof e.body === "string" &&
    Number.isSafeInteger(e.seq) && e.seq >= 0 &&
    Number.isSafeInteger(e.ts) && e.ts >= 0 &&
    /^[0-9a-f]{32}$/.test(e.nonce) && /^[0-9a-f]{64}$/.test(e.prev) && /^[0-9a-f]{128}$/.test(e.sig);
  if (!ok) throw new Error("envelope is missing fields or has the wrong format");
}

export function envelopeSignedBytes(e) {
  const w = new Writer();
  w.str(TAG_ENV);
  w.u8(e.v);
  w.str(e.from);
  w.str(e.to);
  w.u64(e.seq);
  w.u64(e.ts);
  w.raw(fromHex(e.nonce, 16));
  w.raw(fromHex(e.prev, 32));
  w.str(e.body);
  return w.bytes();
}
// Wire format identical to Envelope::encode() in C++.
export function envelopeWire(e) {
  const w = new Writer();
  w.u8(e.v);
  w.str(e.from);
  w.str(e.to);
  w.u64(e.seq);
  w.u64(e.ts);
  w.raw(fromHex(e.nonce, 16));
  w.raw(fromHex(e.prev, 32));
  w.str(e.body);
  w.raw(fromHex(e.sig, 64));
  return w.bytes();
}
const digests = new Map();
export async function envelopeDigest(e) {
  const key = toHex(envelopeSignedBytes(e));
  const hit = digests.get(key);
  if (hit) return hit;
  return remember(digests, key, toHex(await sha256(fromHex(key))));
}
export function signEnvelope(seedHex, fields) {
  const e = { v: VERSION, nonce: toHex(randomBytes(16)), prev: ZERO_PREV, ...fields, sig: "" };
  e.sig = signBytes(seedHex, envelopeSignedBytes(e));
  return e;
}
export function verifyEnvelope(e, pubHex) {
  try {
    checkShape(e);
    return verifyBytes(pubHex, envelopeSignedBytes(e), e.sig);
  } catch {
    return false;
  }
}

// ---- receipts -------------------------------------------------------------------
//   { by, for, env(64 hex digest), at, sig }
export function receiptSignedBytes(r) {
  const w = new Writer();
  w.str(TAG_RCPT);
  w.str(r.by);
  w.str(r.for);
  w.raw(fromHex(r.env, 32));
  w.u64(r.at);
  return w.bytes();
}
export function signReceipt(seedHex, fields) {
  const r = { ...fields, sig: "" };
  r.sig = signBytes(seedHex, receiptSignedBytes(r));
  return r;
}
export function verifyReceipt(r, pubHex) {
  try {
    return verifyBytes(pubHex, receiptSignedBytes(r), r.sig);
  } catch {
    return false;
  }
}

// ---- treaties -------------------------------------------------------------------
//   { id, terms, parties: [names], sigs: { name: sigHex } }
export function treatySignedBytes(t) {
  const sorted = [...t.parties].sort(byteCompare);
  const w = new Writer();
  w.str(TAG_TREATY);
  w.str(t.terms);
  w.u32(sorted.length);
  for (const p of sorted) w.str(p);
  return w.bytes();
}
export function signTreaty(seedHex, t) {
  return signBytes(seedHex, treatySignedBytes(t));
}
// keyOf(name) -> pubHex | null. Returns { binding, signed: [...], missing: [...], broken: [...] }
export function checkTreaty(t, keyOf) {
  const msg = treatySignedBytes(t);
  const res = { binding: false, signed: [], missing: [], broken: [] };
  for (const p of t.parties) {
    const sig = t.sigs?.[p];
    const pub = keyOf(p);
    if (!sig) res.missing.push(p);
    else if (pub && verifyBytes(pub, msg, sig)) res.signed.push(p);
    else res.broken.push(p);
  }
  res.binding = t.parties.length > 0 && res.signed.length === t.parties.length;
  return res;
}

// ---- the receiver's checks (same order as Party::receive in C++) -------------
export const Status = {
  ACCEPTED: "accepted",
  GAP: "gap",
  MALFORMED: "malformed",
  UNKNOWN: "unknown-sender",
  BAD_SIG: "bad-signature",
  MISROUTED: "misrouted",
  EXPIRED: "expired",
  REPLAY: "replay",
  OUT_OF_ORDER: "out-of-order",
};
export const isAccepted = (s) => s === Status.ACCEPTED || s === Status.GAP;

// state: { lastSeq: {sender: n}, nonces: {hex: true} } — mutated on acceptance.
export function receive({ me, env, keyOf, now, policy, state }) {
  try {
    checkShape(env);
  } catch (err) {
    return { status: Status.MALFORMED, detail: err.message };
  }
  const pub = keyOf(env.from);
  if (!pub)
    return { status: Status.UNKNOWN, detail: `You have no seal on record for "${env.from}".` };
  if (!verifyEnvelope(env, pub))
    return {
      status: Status.BAD_SIG,
      detail: `The signature does not match ${env.from}'s seal. The letter was changed on the way, or someone else wrote it.`,
    };
  if (env.to !== me)
    return {
      status: Status.MISROUTED,
      detail: `The seal is genuine, but ${env.from} sealed this letter for ${env.to}, not for you.`,
    };
  if (env.ts + policy.freshness < now)
    return {
      status: Status.EXPIRED,
      detail: `Sealed ${Math.round((now - env.ts) / 60)} min ago, which is older than the ${Math.round(policy.freshness / 60)}-minute limit. Someone held the courier.`,
    };
  if (env.ts > now + policy.skew)
    return { status: Status.EXPIRED, detail: "The letter is dated in the future." };
  if (state.nonces[env.nonce])
    return { status: Status.REPLAY, detail: "You already received this exact letter. Someone is delivering a copy again." };
  const last = state.lastSeq[env.from] || 0;
  if (env.seq <= last)
    return {
      status: Status.OUT_OF_ORDER,
      detail: `This is letter #${env.seq} from ${env.from}, but you already have #${last}. It is an old letter.`,
    };
  let status = Status.ACCEPTED;
  let detail = `Verified with ${env.from}'s seal. Nobody changed a single character.`;
  if (env.seq !== last + 1) {
    status = Status.GAP;
    const missing = env.seq - 1 === last + 1 ? `#${last + 1}` : `#${last + 1} to #${env.seq - 1}`;
    detail = `Genuine, but letter ${missing} from ${env.from} never arrived. A courier was stopped.`;
  }
  state.lastSeq[env.from] = env.seq;
  state.nonces[env.nonce] = true;
  return { status, detail };
}

// Two genuine envelopes from one sender claiming the same predecessor = a signed fork.
// Positions used only once can't be a fork, so only shared positions are verified.
export async function findEquivocations(envs, keyOf) {
  const position = (e) => (e && typeof e.from === "string" && typeof e.prev === "string" ? e.from + "|" + e.prev : null);
  const count = new Map();
  for (const e of envs) { const k = position(e); if (k) count.set(k, (count.get(k) || 0) + 1); }
  const seen = new Map();
  const reported = new Set();
  const out = [];
  for (const e of envs) {
    const key = position(e);
    if (!key || count.get(key) < 2) continue;
    const pub = keyOf(e.from);
    if (!pub || !verifyEnvelope(e, pub)) continue;
    const first = seen.get(key);
    if (!first) { seen.set(key, e); continue; }
    const [a, b] = [await envelopeDigest(first), await envelopeDigest(e)];
    if (a === b) continue;
    const id = [a, b].sort().join();
    if (reported.has(id)) continue;
    reported.add(id);
    out.push({ sender: e.from, first, second: e });
  }
  return out;
}
