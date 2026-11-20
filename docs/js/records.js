// SiegeSeal Records: create / read / update / delete, where every change is signed.
//
// The shared store holds an append-only log of operations. Nobody edits a
// record in place: an update or delete is a new signed operation that points
// at the record's previous version. Each reader rebuilds the table from the
// log on their own device and checks every signature on the way.
//
// Store document:
//   { app, v, title, created, users: [Member], ops: [Op] }
//   Member: { name, pub, ts, sig }            a self-signed "this is my key"
//   Op:     { v, op, rec, author, ts, prev, title, body, sig }
//            op   = "create" | "update" | "delete"
//            rec  = record id (16 hex), chosen by its creator
//            prev = id of the record's previous operation ("" for create)
//
// What gets signed is shown to students verbatim (signedText), so they can
// see that every field, including who and when, is covered by the signature.

import { toHex, fromHex, randomBytes, generateSeed, publicKeyFromSeed, signBytes, verifyBytes, fingerprint } from "./protocol.js";

export { generateSeed, publicKeyFromSeed, fingerprint };

export const FILE = "siegeseal-records.json";
export const LIMITS = { users: 40, ops: 600, name: 32, title: 80, body: 500 };
const TAG_OP = "SIEGESEAL/RECORD-OP/v1";
const TAG_MEMBER = "SIEGESEAL/MEMBER/v1";
const OPS = ["create", "update", "delete"];
const te = new TextEncoder();

export function newBoard(title) {
  return {
    app: "siegeseal-records",
    v: 1,
    title: (title || "Class records").slice(0, 80),
    created: Math.floor(Date.now() / 1000),
    users: [],
    ops: [],
  };
}

// Anyone can write to the store, so never trust its shape.
export function normalize(doc) {
  const d = doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  const arr = (x) => (Array.isArray(x) ? x.filter((i) => i && typeof i === "object" && !Array.isArray(i)) : []);
  return {
    ...d,
    title: typeof d.title === "string" ? d.title.slice(0, 80) : "Class records",
    users: arr(d.users),
    ops: arr(d.ops),
  };
}

// Never drop operations silently: losing a "create" would orphan its record.
// The UI refuses new operations once the board is full instead.
export const compact = (doc) => doc;

export const SCHEMA = { file: FILE, prefix: "siegeseal:records:", newDoc: newBoard, normalize, compact, what: "a SiegeSeal records board" };

export const newRecordId = () => toHex(randomBytes(8));
const now = () => Math.floor(Date.now() / 1000);
const str = (x) => (typeof x === "string" ? x : "");

// ---- what is signed -----------------------------------------------------------
// A fixed-order JSON array behind a domain tag: readable, and deterministic.
export function signedText(op) {
  return TAG_OP + "\n" + JSON.stringify([op.v, op.op, op.rec, op.author, op.ts, op.prev, op.title, op.body]);
}
export function memberText(m) {
  return TAG_MEMBER + "\n" + JSON.stringify([m.name, m.pub, m.ts]);
}

// An operation's id is the SHA-256 of exactly what was signed.
const ids = new Map();
export async function opId(op) {
  const text = signedText(op);
  let id = ids.get(text);
  if (!id) {
    id = toHex(new Uint8Array(await crypto.subtle.digest("SHA-256", te.encode(text))));
    if (ids.size > 5000) ids.clear();
    ids.set(text, id);
  }
  return id;
}

function wellFormed(op) {
  return op.v === 1 && OPS.includes(op.op) && /^[0-9a-f]{16}$/.test(str(op.rec)) &&
    typeof op.author === "string" && op.author.length > 0 && Number.isSafeInteger(op.ts) &&
    typeof op.prev === "string" && typeof op.title === "string" && typeof op.body === "string";
}

// ---- signing ------------------------------------------------------------------
export function signMember(seed, name) {
  const m = { name, pub: publicKeyFromSeed(seed), ts: now() };
  return { ...m, sig: signBytes(seed, te.encode(memberText(m))) };
}
export function verifyMember(m) {
  return typeof m.name === "string" && /^[0-9a-f]{64}$/.test(str(m.pub)) &&
    verifyBytes(m.pub, te.encode(memberText(m)), m.sig);
}

export function signOp(seed, { op, rec, author, prev = "", title = "", body = "" }) {
  const o = { v: 1, op, rec, author, ts: now(), prev, title: title.slice(0, LIMITS.title), body: body.slice(0, LIMITS.body) };
  return { ...o, sig: signBytes(seed, te.encode(signedText(o))) };
}
export function verifyOp(op, pub) {
  return !!pub && verifyBytes(pub, te.encode(signedText(op)), op.sig);
}

// ---- who is who -----------------------------------------------------------------
// The first validly self-signed registration of a name wins. `pins` are the keys
// this browser saw first for each name: if the store later shows a different
// key, the pinned one is used and the change is reported.
export function directory(doc, pins = {}) {
  const keys = {};
  const conflicts = [];
  for (const m of doc.users) {
    if (!verifyMember(m)) continue;
    if (!keys[m.name]) keys[m.name] = m.pub;
  }
  for (const [name, pub] of Object.entries(pins)) {
    if (keys[name] && keys[name] !== pub) conflicts.push({ name, pinned: pub, store: keys[name] });
    keys[name] = pub;
  }
  return { keys, conflicts };
}

// ---- rebuild the table from the log --------------------------------------------
// Status of each operation:
//   ok          applied
//   bad-sig     signature does not match the content: altered or forged
//   unknown     no registered key for the author
//   not-owner   genuinely signed, but only the record's creator may change it
//   stale       does not follow the record's latest version (out of order, replayed or forked)
//   no-record   update/delete of a record that does not exist or was deleted
//   duplicate   create for a record id that already exists
//   malformed   missing or wrong-typed fields
//
// With check=false the reader behaves like a plain CRUD app: every well-formed
// operation is applied in log order, whatever its signature says.
export async function rebuild(doc, { keys = {}, check = true } = {}) {
  const records = new Map();
  const log = [];
  for (const op of doc.ops) {
    const entry = { op, id: null, status: "ok" };
    log.push(entry);
    if (!wellFormed(op)) { entry.status = "malformed"; continue; }
    entry.id = await opId(op);
    const r = records.get(op.rec);
    if (check) {
      if (!keys[op.author]) { entry.status = "unknown"; continue; }
      if (!verifyOp(op, keys[op.author])) { entry.status = "bad-sig"; continue; }
      if (op.op === "create") {
        if (r) { entry.status = "duplicate"; continue; }
        if (op.prev !== "") { entry.status = "stale"; continue; }
      } else {
        if (!r || r.deleted) { entry.status = "no-record"; continue; }
        if (op.author !== r.owner) { entry.status = "not-owner"; continue; }
        if (op.prev !== r.head) { entry.status = "stale"; continue; }
      }
    } else if (op.op !== "create" && !r) {
      entry.status = "no-record";
      continue;
    }
    if (op.op === "create" || !r) {
      records.set(op.rec, { rec: op.rec, owner: op.author, title: op.title, body: op.body, created: op.ts, updated: op.ts, by: op.author, deleted: false, head: entry.id, history: [entry] });
    } else {
      r.head = entry.id;
      r.updated = op.ts;
      r.by = op.author;
      r.history.push(entry);
      if (op.op === "delete") r.deleted = true;
      else { r.title = op.title; r.body = op.body; }
    }
  }
  // Attach rejected operations to their record's history too, so students see the attempt.
  for (const e of log) {
    if (e.status === "ok") continue;
    const r = records.get(e.op.rec);
    if (r && !r.history.includes(e)) r.history.push(e);
  }
  return { records, log };
}

export const STATUS_TEXT = {
  ok: "Signature valid",
  "bad-sig": "Signature does not match: altered or forged",
  unknown: "Unknown author: no registered key",
  "not-owner": "Rejected: signed by someone who doesn't own this record",
  stale: "Rejected: doesn't follow the record's latest version",
  "no-record": "Rejected: record doesn't exist or was deleted",
  duplicate: "Rejected: record already exists",
  malformed: "Malformed entry",
};

// ---- portable proof --------------------------------------------------------------
// Everything a third party needs to check who did what, with no access to the store.
export function makeProof(op, member) {
  return { kind: "siegeseal-record-proof", v: 1, op, member };
}
export async function checkProof(p) {
  if (!p || p.kind !== "siegeseal-record-proof" || !p.op || !p.member) return { ok: false, why: "This is not a SiegeSeal record proof." };
  const { op, member } = p;
  if (!wellFormed(op)) return { ok: false, why: "The operation is malformed." };
  if (!verifyMember(member)) return { ok: false, why: "The member's key registration is not validly self-signed." };
  if (member.name !== op.author) return { ok: false, why: `The operation claims to be by ${op.author}, but the key belongs to ${member.name}.` };
  if (!verifyOp(op, member.pub)) return { ok: false, why: "The signature does not match the operation. It was altered, or forged." };
  return { ok: true, id: await opId(op), fp: await fingerprint(member.pub) };
}

export { fromHex };
