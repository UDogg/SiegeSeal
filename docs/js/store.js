// The "post office": one shared JSON document that every client reads and writes.
//
// It is deliberately untrusted. Anyone with the link can rewrite it, exactly
// like the city of Vharos standing on the road. The protocol never relies on
// the store being honest; it only needs the store to carry bytes.
//
// Three backends share one interface:
//   pull()      -> the latest document, or null if nothing changed since the last pull/update
//   update(fn)  -> read fresh, apply fn(doc), trim, write back (serialised per client)
//
// Not meant to scale: last writer wins. A message lost in a write race never
// gets a signed receipt, which the sender sees, as the protocol intends.

import { LS } from "./storage.js";

export const FILE = "siegeseal-room.json";

// A room is a classroom demo, not an archive. Keep the newest entries so the
// document (which every client downloads on every change) stays small.
export const LIMITS = { road: 60, delivered: 400, receipts: 400, seals: 80, treaties: 20 };

export function newRoom(title) {
  return {
    app: "siegeseal-classroom",
    v: 1,
    title: title || "The Siege of Vharos",
    created: Math.floor(Date.now() / 1000),
    policy: { freshness: 600, skew: 120 },
    seals: [],
    checkpoint: false,
    road: [],
    delivered: [],
    receipts: [],
    treaties: [],
  };
}

// The store can be edited by anyone, so never trust its shape.
export function normalize(doc) {
  const d = doc && typeof doc === "object" && !Array.isArray(doc) ? doc : {};
  const arr = (x) => (Array.isArray(x) ? x.filter((i) => i && typeof i === "object" && !Array.isArray(i)) : []);
  return {
    ...d,
    title: typeof d.title === "string" ? d.title.slice(0, 120) : "The Siege of Vharos",
    policy: {
      freshness: Number.isFinite(d.policy?.freshness) ? d.policy.freshness : 600,
      skew: Number.isFinite(d.policy?.skew) ? d.policy.skew : 120,
    },
    seals: arr(d.seals),
    checkpoint: !!d.checkpoint,
    road: arr(d.road),
    delivered: arr(d.delivered),
    receipts: arr(d.receipts),
    treaties: arr(d.treaties),
  };
}

// Drop the oldest entries beyond LIMITS. Applied on every write.
export function compact(doc) {
  for (const [k, max] of Object.entries(LIMITS)) if (doc[k].length > max) doc[k] = doc[k].slice(-max);
  return doc;
}

function parse(raw) {
  if (!raw || !raw.trim()) return normalize(newRoom());
  try {
    return normalize(JSON.parse(raw));
  } catch {
    throw new Error("The room's data is not valid JSON. Someone may have damaged it; start a new room.");
  }
}

class Serial {
  constructor() { this.chain = Promise.resolve(); }
  run(fn) {
    const p = this.chain.then(fn, fn);
    this.chain = p.catch(() => {});
    return p;
  }
}

// Shared logic: subclasses implement readRaw(conditional) -> string | null (unchanged)
// and writeRaw(string).
class Store {
  constructor() {
    this.raw = null; // exact text of the last version this client saw or wrote
    this.serial = new Serial();
  }
  pull() {
    return this.serial.run(async () => {
      const raw = await this.readRaw(true);
      if (raw === null || raw === this.raw) return null;
      this.raw = raw;
      return parse(raw);
    });
  }
  update(fn) {
    return this.serial.run(async () => {
      const doc = parse(await this.readRaw(false));
      fn(doc);
      const raw = JSON.stringify(compact(doc));
      await this.writeRaw(raw);
      this.raw = raw; // our own write is not news on the next pull
      return doc;
    });
  }
}

// ---- this device only: localStorage, shared between tabs -------------------
export class LocalStore extends Store {
  constructor(id) {
    super();
    this.id = id;
    this.key = "siegeseal:room:" + id;
    this.pollMs = 3000; // other tabs' writes also arrive instantly via the storage event
    this.label = "This computer only";
  }
  static create(title) {
    const id = Math.random().toString(36).slice(2, 10);
    LS.setItem("siegeseal:room:" + id, JSON.stringify(newRoom(title)));
    return id;
  }
  async readRaw() {
    const raw = LS.getItem(this.key);
    if (raw === null) throw new Error("This room does not exist on this computer.");
    return raw;
  }
  async writeRaw(raw) {
    LS.setItem(this.key, raw);
  }
}

// ---- GitHub Gist ----------------------------------------------------------------
async function ghError(res) {
  let msg = "";
  try { msg = (await res.json()).message || ""; } catch {}
  if (res.status === 401) return new Error("GitHub rejected the access token. Check it has the gist scope and has not expired.");
  if (res.status === 404) return new Error("Gist not found. Check the room link, or the token cannot see this gist.");
  if (res.status === 403 || res.status === 429) {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    const retry = Number(res.headers.get("retry-after"));
    const when = retry
      ? ` Try again in ${retry} seconds.`
      : reset ? ` Try again after ${new Date(reset * 1000).toLocaleTimeString()}.` : " Wait a minute and try again.";
    return new Error("GitHub rate limit reached." + when);
  }
  return new Error(`GitHub error ${res.status}${msg ? ": " + msg : ""}`);
}

const GH = { Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };

export class GistStore extends Store {
  constructor(id, token) {
    super();
    this.id = id;
    this.token = token || "";
    this.etag = null;
    // With a token, unchanged polls (304) are free. Without one, GitHub allows
    // only 60 requests an hour, so poll about once a minute.
    this.pollMs = this.token ? 6000 : 65000;
    this.label = "GitHub Gist";
  }
  headers(extra = {}) {
    const h = { ...GH, ...extra };
    if (this.token) h.Authorization = "Bearer " + this.token;
    return h;
  }
  static async create(token, title) {
    const res = await fetch("https://api.github.com/gists", {
      method: "POST",
      headers: { ...GH, Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body: JSON.stringify({
        description: "SiegeSeal classroom: " + (title || "The Siege of Vharos"),
        public: false,
        files: { [FILE]: { content: JSON.stringify(newRoom(title)) } },
      }),
    });
    if (!res.ok) throw await ghError(res);
    return (await res.json()).id;
  }
  async readRaw(conditional) {
    const extra = conditional && this.etag ? { "If-None-Match": this.etag } : {};
    const res = await fetch(`https://api.github.com/gists/${this.id}`, { headers: this.headers(extra), cache: "no-store" });
    if (res.status === 304) return null;
    if (!res.ok) throw await ghError(res);
    this.etag = res.headers.get("etag");
    const f = (await res.json()).files?.[FILE];
    if (!f) throw new Error(`This gist has no ${FILE} file, so it is not a SiegeSeal room.`);
    return f.truncated ? (await fetch(f.raw_url, { cache: "no-store" })).text() : f.content;
  }
  async writeRaw(raw) {
    if (!this.token) throw new Error("You need the room's write key to send. Ask your teacher for the full room link.");
    const res = await fetch(`https://api.github.com/gists/${this.id}`, {
      method: "PATCH",
      headers: this.headers({ "Content-Type": "application/json" }),
      body: JSON.stringify({ files: { [FILE]: { content: raw } } }),
    });
    if (!res.ok) throw await ghError(res);
    this.etag = null; // the next pull refetches once; identical content is then ignored
  }
  update(fn) {
    if (!this.token) return Promise.reject(new Error("You need the room's write key to send. Ask your teacher for the full room link."));
    return super.update(fn);
  }
}

// ---- any URL that answers GET with JSON and accepts PUT ---------------------
export class JsonUrlStore extends Store {
  constructor(url) {
    super();
    this.url = url;
    this.etag = null;
    this.pollMs = 4000;
    this.label = "JSON URL";
  }
  async readRaw(conditional) {
    const headers = { Accept: "application/json" };
    if (conditional && this.etag) headers["If-None-Match"] = this.etag;
    const res = await fetch(this.url, { headers, cache: "no-store" });
    if (res.status === 304) return null;
    if (!res.ok) throw new Error(`The storage URL answered ${res.status}.`);
    this.etag = res.headers.get("etag");
    return res.text();
  }
  async writeRaw(raw) {
    const res = await fetch(this.url, { method: "PUT", headers: { "Content-Type": "application/json" }, body: raw });
    if (!res.ok) throw new Error(`The storage URL refused the write (${res.status}).`);
    this.etag = null;
  }
}
