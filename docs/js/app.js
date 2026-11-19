// SiegeSeal Classroom — the messaging app.
//
// Everyone in a room shares one untrusted JSON document (the "road").
// Each person keeps their private seal and their own evidence in this
// browser only. All checks happen here, on the reader's device.

import * as P from "./protocol.js";
import { LocalStore, GistStore, JsonUrlStore, newRoom } from "./store.js";
import { drawSeal } from "./seal.js";
import { LS, SS } from "./storage.js";

// ---- tiny DOM helper -------------------------------------------------------------
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else if (k.startsWith("on")) e.addEventListener(k.slice(2), v);
    else if (k === "value") e.value = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const k of kids.flat(Infinity)) {
    if (k === null || k === undefined || k === false) continue;
    e.appendChild(typeof k === "string" || typeof k === "number" ? document.createTextNode(String(k)) : k);
  }
  return e;
}
const app = () => document.getElementById("app");
const now = () => Math.floor(Date.now() / 1000);
const rid = () => P.toHex(P.randomBytes(8));
const NAME_MAX = 32;
const BODY_MAX = 600;
const ARMIES = ["Aurelia", "Borealis", "Cyrene"];

function ago(ts) {
  const s = now() - ts;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}
// Relative times are live elements, refreshed by a ticker without re-rendering.
function fmtTime(ts, fmt) {
  if (fmt === "held") {
    const s = Math.max(0, now() - ts);
    return s < 60 ? `${s} s` : `${Math.round(s / 60)} min`;
  }
  return ago(ts);
}
function timeEl(ts, fmt = "ago") {
  return h("span", { "data-ts": ts, "data-fmt": fmt }, fmtTime(ts, fmt));
}
function refreshTimes() {
  for (const el of document.querySelectorAll("[data-ts]")) {
    const t = fmtTime(Number(el.dataset.ts), el.dataset.fmt);
    if (el.textContent !== t) el.textContent = t;
  }
}
function clock(ts) {
  return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}
function clock24(ts) {
  const d = new Date(ts * 1000);
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
let toastTimer = null;
function flash(msg) {
  let n = document.getElementById("toast");
  if (!n) {
    n = h("div", { id: "toast", class: "notice toast", role: "status", "aria-live": "polite" });
    document.body.appendChild(n);
  }
  n.textContent = msg;
  n.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { n.hidden = true; }, 3600);
}
async function copy(text, what = "Copied") {
  try {
    await navigator.clipboard.writeText(text);
    flash(what);
  } catch {
    // Clipboard blocked: show the text selected, ready for Ctrl+C / long-press.
    const ta = h("textarea", { readonly: true, style: "font-family:var(--mono);font-size:.8rem;min-height:10rem" });
    ta.value = text;
    const dlg = h("dialog", {}, h("h3", {}, "Copy this"), ta,
      h("div", { class: "row", style: "margin-top:.8rem" }, h("button", { onclick: () => { dlg.close(); dlg.remove(); } }, "Done")));
    document.body.appendChild(dlg);
    dlg.showModal();
    ta.focus();
    ta.select();
  }
}

// ---- global state ----------------------------------------------------------------------
const S = {
  roomKey: null, // "local:abc" | "gist:123" | "url:..."
  store: null,
  doc: null,
  me: null, // persisted identity + evidence, see blankMe()
  fps: new Map(), // pubHex -> fingerprint
  tab: "letters",
  thread: null,
  check: true, // "Verify seals" switch
  sync: { at: 0, error: "" },
  fresh: new Set(), // inbox ids that just arrived (for the crack animation)
  updaters: {}, // per-tab re-render functions
};

const K = {
  me: (name) => `siegeseal:me:${S.roomKey}:${name}`,
  active: () => `siegeseal:active:${S.roomKey}`,
  last: () => `siegeseal:last:${S.roomKey}`,
  token: (room) => `siegeseal:token:${room}`,
  city: () => `siegeseal:city:${S.roomKey}`,
};

function blankMe(name, seed) {
  return {
    name, seed, pub: P.publicKeyFromSeed(seed),
    chainHead: P.ZERO_PREV, nextSeq: {},
    rx: { lastSeq: {}, nonces: {}, processed: {} },
    inbox: [], // { id, env, status, detail, at }
    sent: [], // { env, digest, at, receipt: {at}|null, forged: 0, failed: "" }
    pins: {}, // name -> { pub, verified, at }
    seenReceipts: {},
  };
}
function save() {
  if (S.me) LS.setItem(K.me(S.me.name), JSON.stringify(S.me));
}
function identitiesOnDevice() {
  const prefix = `siegeseal:me:${S.roomKey}:`;
  return LS.keys().filter((k) => k.startsWith(prefix)).map((k) => k.slice(prefix.length)).sort();
}
function citySeed() {
  let s = LS.getItem(K.city());
  if (!s) { s = P.generateSeed(); LS.setItem(K.city(), s); }
  return s;
}

// Whose key do *I* trust for a name? Only my pins — never the shared store.
function keyOf(name) {
  if (!S.me || typeof name !== "string") return null;
  if (name === S.me.name) return S.me.pub;
  return S.me.pins[name]?.pub || null;
}
async function fp(pub) {
  if (!pub) return "";
  if (!S.fps.has(pub)) {
    try { S.fps.set(pub, await P.fingerprint(pub)); } catch { S.fps.set(pub, "invalid key"); }
  }
  return S.fps.get(pub);
}
function fpNow(pub) { return S.fps.get(pub) || "…"; }
async function warmFingerprints() {
  const pubs = new Set([S.me?.pub, ...Object.values(S.me?.pins || {}).map((p) => p.pub), ...S.doc.seals.map((s) => s.pub)]);
  for (const p of pubs) if (typeof p === "string" && /^[0-9a-f]{64}$/.test(p)) await fp(p);
}

// ---- routing ---------------------------------------------------------------------------------
function parseHash() {
  const out = {};
  for (const part of location.hash.replace(/^#/, "").split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    out[decodeURIComponent(i < 0 ? part : part.slice(0, i))] = i < 0 ? "" : decodeURIComponent(part.slice(i + 1));
  }
  return out;
}
function setHash(params) {
  const s = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&");
  history.replaceState(null, "", location.pathname + location.search + (s ? "#" + s : ""));
}
function roomLink(room, withKey) {
  const base = location.origin + location.pathname;
  const token = LS.getItem(K.token(room));
  let link = `${base}#room=${encodeURIComponent(room)}`;
  if (withKey && token) link += `&key=${encodeURIComponent(token)}`;
  return link;
}

function makeStore(room) {
  const i = room.indexOf(":");
  const kind = room.slice(0, i), id = room.slice(i + 1);
  if (kind === "local") return new LocalStore(id);
  if (kind === "gist") return new GistStore(id, LS.getItem(K.token(room)) || "");
  if (kind === "url") return new JsonUrlStore(id);
  throw new Error("That room link is not one this app understands.");
}

async function boot() {
  if (!globalThis.nacl) {
    app().replaceChildren(h("p", { class: "boot" }, "The signature library did not load. Check that js/vendor/nacl-fast.min.js was deployed."));
    return;
  }
  const params = parseHash();
  if (!params.room) return renderWelcome();
  S.roomKey = params.room;
  if (params.key) LS.setItem(K.token(params.room), params.key);
  if (params.as === "new") SS.removeItem(K.active());
  setHash({ room: params.room }); // keep the write key out of the address bar
  try {
    S.store = makeStore(S.roomKey);
    S.doc = await S.store.pull();
    if (!S.doc) throw new Error("The room is empty.");
  } catch (err) {
    return renderRoomError(err);
  }
  rememberRoom(S.roomKey, S.doc.title);
  const isLocal = S.roomKey.startsWith("local:");
  const name = SS.getItem(K.active()) || (!isLocal && params.as !== "new" ? LS.getItem(K.last()) : null);
  const saved = name && LS.getItem(K.me(name));
  if (saved) {
    S.me = JSON.parse(saved);
    SS.setItem(K.active(), S.me.name);
    return enterRoom();
  }
  renderIdentity();
}
// Restart in place rather than reloading, so a browser that keeps storage
// only in memory doesn't lose the room and the seal.
function restart() {
  clearTimeout(pollTimer);
  clearInterval(S.ticker);
  pollTimer = null;
  Object.assign(S, { roomKey: null, store: null, doc: null, me: null, tab: "letters", thread: null, sync: { at: 0, error: "" }, updaters: {} });
  S.fresh.clear();
  app().replaceChildren(h("p", { class: "boot" }, "Loading…"));
  boot();
}
window.addEventListener("hashchange", restart);
window.addEventListener("storage", (e) => { if (S.store && e.key && e.key.startsWith("siegeseal:room:")) poll(); });

function renderRoomError(err) {
  app().replaceChildren(
    h("div", { class: "welcome" },
      h("h1", {}, "Could not open this room"),
      h("p", { class: "notice bad" }, err.message || String(err)),
      h("div", { class: "row" },
        h("button", { onclick: restart }, "Try again"),
        h("button", { class: "quiet", onclick: () => { setHash({}); restart(); } }, "Start over"))));
}

// ---- rooms this device has opened ---------------------------------------------------------------
function knownRooms() {
  try { return JSON.parse(LS.getItem("siegeseal:rooms") || "[]").filter((r) => r && typeof r.room === "string"); } catch { return []; }
}
function rememberRoom(room, title) {
  const rooms = knownRooms().filter((r) => r.room !== room);
  rooms.unshift({ room, title: String(title || "Untitled room").slice(0, 80), at: now() });
  LS.setItem("siegeseal:rooms", JSON.stringify(rooms.slice(0, 8)));
}
function forgetRoom(room) {
  LS.setItem("siegeseal:rooms", JSON.stringify(knownRooms().filter((r) => r.room !== room)));
}

// ---- welcome: pick where the shared road lives ----------------------------------------------
function renderWelcome() {
  const rooms = knownRooms().filter((r) => !r.room.startsWith("local:") || LS.getItem("siegeseal:room:" + r.room.slice(6)) !== null);
  const kind = (room) => room.startsWith("gist:") ? "Classroom" : room.startsWith("local:") ? "Practice room" : "JSON storage";
  const demoSeal = (name, seedByte) => drawSeal({ pub: P.toHex(new Uint8Array(32).map((_, i) => (i * seedByte * 37 + seedByte * 11) & 255)), initial: name, size: 64 });

  const localTitle = h("input", { type: "text", value: "The Siege of Vharos", "aria-label": "Room name" });
  const gistToken = h("input", { type: "password", placeholder: "ghp_… or github_pat_…", autocomplete: "off", "aria-label": "GitHub token" });
  const gistTitle = h("input", { type: "text", value: "The Siege of Vharos", "aria-label": "Classroom name" });
  const gistOut = h("div", {});
  const joinInput = h("input", { type: "url", placeholder: "Paste the room link from your teacher", "aria-label": "Room link" });
  const urlInput = h("input", { type: "url", placeholder: "https://…", "aria-label": "Storage URL" });

  app().replaceChildren(
    h("div", { class: "welcome" },
      h("div", { class: "hero-seals", "aria-hidden": "true" }, demoSeal("A", 3), demoSeal("B", 7), demoSeal("C", 13)),
      h("h1", {}, "Three armies, one city, and every letter rides past its walls"),
      h("p", { class: "lede" }, "Send sealed letters to your allies while the city of Vharos reads, rewrites and forges them. See which letters you can prove, and which ones you can't."),
      rooms.length ? h("section", { class: "your-rooms" },
        h("h3", {}, "Your rooms"),
        h("div", { class: "armies" }, rooms.map((r) => h("span", { class: "room-chip" },
          h("button", { onclick: () => { location.hash = `room=${encodeURIComponent(r.room)}`; } }, r.title),
          h("span", { class: "small muted" }, `${kind(r.room)}, ${ago(r.at)}`),
          h("button", { class: "quiet small", "aria-label": `Forget ${r.title}`, onclick: () => { forgetRoom(r.room); renderWelcome(); } }, "Forget"))))) : null,
      h("div", { class: "choices" },
        h("section", { class: "choice" },
          h("h3", {}, "Try it on this computer"),
          h("p", { class: "muted" }, "Open several tabs and play every army yourself. Nothing leaves this browser. Good for rehearsing or a projector demo."),
          h("label", {}, "Room name"), localTitle,
          h("div", { class: "row", style: "margin-top:.8rem" },
            h("button", { onclick: () => { const id = LocalStore.create(localTitle.value.trim()); location.hash = `room=local:${id}`; } }, "Open a practice room"))),
        h("section", { class: "choice" },
          h("h3", {}, "Start a classroom"),
          h("p", { class: "muted" }, "Stores the room in a secret GitHub Gist so the whole class can join from their own devices. Needs a GitHub token with the gist scope."),
          h("label", {}, "Classroom name"), gistTitle,
          h("label", {}, "GitHub token"), gistToken,
          h("p", { class: "small muted", style: "margin-top:.4rem" }, "Use a throwaway GitHub account: the token goes into the join link, so treat anything it can reach as public."),
          h("div", { class: "row" },
            h("button", {
              onclick: async (ev) => {
                const token = gistToken.value.trim();
                if (!token) return gistOut.replaceChildren(h("p", { class: "notice bad" }, "Paste a GitHub token first."));
                ev.target.disabled = true;
                gistOut.replaceChildren(h("p", { class: "muted" }, "Creating the gist…"));
                try {
                  const id = await GistStore.create(token, gistTitle.value.trim());
                  const room = `gist:${id}`;
                  LS.setItem(K.token(room), token);
                  const full = roomLink(room, true);
                  gistOut.replaceChildren(
                    h("p", { class: "notice ok" }, "Classroom created."),
                    h("label", {}, "Link for students"),
                    h("div", { class: "linkbox" }, h("input", { type: "text", readonly: true, value: full }), h("button", { class: "small", onclick: () => copy(full, "Link copied") }, "Copy")),
                    h("div", { class: "row", style: "margin-top:.8rem" }, h("button", { onclick: () => { location.hash = `room=${room}`; } }, "Open the classroom")));
                } catch (err) {
                  const msg = err instanceof TypeError ? "Couldn't reach GitHub. Check your connection; some school networks and embedded previews block api.github.com." : err.message;
                  gistOut.replaceChildren(h("p", { class: "notice bad" }, msg));
                } finally { ev.target.disabled = false; }
              },
            }, "Create classroom")),
          gistOut),
        h("section", { class: "choice" },
          h("h3", {}, "Join a classroom"),
          h("p", { class: "muted" }, "Your teacher shares a link. Open it, or paste it here."),
          h("label", {}, "Room link"), joinInput,
          h("div", { class: "row", style: "margin-top:.8rem" },
            h("button", {
              onclick: () => {
                const v = joinInput.value.trim();
                const i = v.indexOf("#");
                if (i < 0 || !v.includes("room=")) return flash("That doesn't look like a room link.");
                location.hash = v.slice(i + 1);
              },
            }, "Join")))),
      h("details", { class: "more" },
        h("summary", {}, "Use your own JSON storage instead"),
        h("p", { class: "muted small", style: "margin-top:.6rem" }, "Any URL that returns the room as JSON on GET, accepts a replacement on PUT, and allows cross-origin requests. Everyone with the URL can rewrite it, which is fine: that's the point of the lesson."),
        h("div", { class: "linkbox" }, urlInput,
          h("button", {
            onclick: async () => {
              const url = urlInput.value.trim();
              if (!/^https:\/\//.test(url)) return flash("Use an https:// URL.");
              try {
                const st = new JsonUrlStore(url);
                await st.update((d) => { if (!d.app) Object.assign(d, newRoom()); });
                location.hash = `room=url:${url}`;
              } catch (err) { flash(err.message); }
            },
          }, "Use this URL")))));
}

// ---- identity: forge your seal ----------------------------------------------------------------
function renderIdentity(errMsg = "") {
  const taken = new Set(S.doc.seals.map((s) => s.name));
  const mine = identitiesOnDevice();
  const nameInput = h("input", { type: "text", maxlength: NAME_MAX, placeholder: "Your army, or your own name", "aria-label": "Name" });
  const err = h("div", {}, errMsg ? h("p", { class: "notice bad" }, errMsg) : null);

  const create = async (name) => {
    name = (name || "").trim().replace(/\s+/g, " ");
    if (!name) return err.replaceChildren(h("p", { class: "notice bad" }, "Choose a name first."));
    if (name.length > NAME_MAX) return err.replaceChildren(h("p", { class: "notice bad" }, `Keep it under ${NAME_MAX} characters.`));
    if (taken.has(name)) return err.replaceChildren(h("p", { class: "notice bad" }, `Someone has already posted a seal as ${name}. Pick another name.`));
    S.me = blankMe(name, P.generateSeed());
    try {
      await S.store.update((d) => {
        if (d.seals.some((s) => s.name === name)) throw new Error(`Someone just took the name ${name}.`);
        d.seals.push({ name, pub: S.me.pub, at: now() });
      });
    } catch (e) {
      S.me = null;
      return err.replaceChildren(h("p", { class: "notice bad" }, e.message));
    }
    save();
    SS.setItem(K.active(), name);
    LS.setItem(K.last(), name);
    S.tab = "seals";
    enterRoom();
  };

  app().replaceChildren(
    h("div", { class: "welcome" },
      h("h1", {}, S.doc.title),
      h("p", { class: "lede" }, "Forge your seal. It's a private key that never leaves this browser. Everyone else gets its public impression."),
      h("label", {}, "Who are you?"),
      h("div", { class: "armies" },
        ARMIES.map((a) => h("button", { class: "quiet", disabled: taken.has(a) || null, onclick: () => create(a) }, taken.has(a) ? `${a} (taken)` : a))),
      h("div", { class: "row", style: "max-width:520px;margin-top:.6rem;flex-wrap:nowrap" }, nameInput, h("button", { onclick: () => create(nameInput.value) }, "Forge my seal")),
      err,
      mine.length
        ? h("section", { style: "margin-top:2rem" },
            h("h3", {}, "Seals already on this device"),
            h("div", { class: "armies" }, mine.map((n) => h("button", {
              class: "quiet",
              onclick: () => {
                S.me = JSON.parse(LS.getItem(K.me(n)));
                SS.setItem(K.active(), n);
                LS.setItem(K.last(), n);
                enterRoom();
              },
            }, `Continue as ${n}`))))
        : null));
  nameInput.addEventListener("keydown", (e) => { if (e.key === "Enter") create(nameInput.value); });
  nameInput.focus();
}

// ---- the sync loop: read the road, check every letter, file receipts ---------------------
let syncing = Promise.resolve();
function runSync(doc) {
  syncing = syncing.then(() => syncDoc(doc)).catch((e) => console.error(e));
  return syncing;
}

const INBOX_MAX = 500;
const RECEIPT_GRACE = 90; // seconds before a missing receipt is called out

// Process a new version of the room. `doc` is null when the room is unchanged,
// in which case there is nothing to do: no checks, no save, no re-render.
async function syncDoc(doc, force = false) {
  if (!S.me || (!doc && !force)) return;
  if (doc) S.doc = doc;
  const me = S.me;

  // 1. Trust on first use: pin any seal we have never seen. Changes are NOT accepted silently.
  for (const s of S.doc.seals) {
    if (typeof s.name !== "string" || !/^[0-9a-f]{64}$/.test(s.pub || "")) continue;
    if (s.name === me.name || me.pins[s.name]) continue;
    me.pins[s.name] = { pub: s.pub, verified: false, at: now() };
  }

  // 2. Letters delivered to me, in road order.
  const receipts = [];
  const live = new Set();
  for (const item of S.doc.delivered) {
    if (item.deliverTo !== me.name) continue;
    const id = typeof item.id === "string" ? item.id : "noid:" + JSON.stringify(item.env).slice(0, 120);
    live.add(id);
    if (me.rx.processed[id]) continue;
    me.rx.processed[id] = true;
    const env = JSON.parse(JSON.stringify(item.env ?? null));
    const res = P.receive({ me: me.name, env, keyOf, now: now(), policy: S.doc.policy, state: me.rx });
    me.inbox.push({ id, env, status: res.status, detail: res.detail, at: now() });
    S.fresh.add(id);
    if (P.isAccepted(res.status)) {
      receipts.push(P.signReceipt(me.seed, { by: me.name, for: env.from, env: await P.envelopeDigest(env), at: now() }));
    }
  }
  // Forget ids the room has trimmed away (replay protection lives in rx.nonces / rx.lastSeq).
  for (const id of Object.keys(me.rx.processed)) if (!live.has(id)) delete me.rx.processed[id];
  if (me.inbox.length > INBOX_MAX) me.inbox.splice(0, me.inbox.length - INBOX_MAX);

  // 3. Receipts for letters I sent, matched by digest.
  const sentByDigest = new Map(me.sent.map((x) => [x.digest, x]));
  const liveReceipts = new Set();
  for (const r of S.doc.receipts) {
    if (r.for !== me.name || typeof r.sig !== "string") continue;
    liveReceipts.add(r.sig);
    if (me.seenReceipts[r.sig]) continue;
    me.seenReceipts[r.sig] = true;
    const s = sentByDigest.get(r.env);
    if (!s) continue;
    const pub = keyOf(r.by);
    if (r.by === s.env.to && pub && P.verifyReceipt(r, pub)) s.receipt = s.receipt || { at: r.at, by: r.by, sig: r.sig, rcpt: r };
    else s.forged = (s.forged || 0) + 1;
  }
  for (const sig of Object.keys(me.seenReceipts)) if (!liveReceipts.has(sig)) delete me.seenReceipts[sig];

  // 4. Equivocation check over everything on the road (cheap: only shared positions are verified).
  const pool = [];
  for (const x of S.doc.delivered) if (x.env) pool.push(x.env);
  for (const x of S.doc.road) if (x.env) pool.push(x.env);
  S.forks = await P.findEquivocations(pool, keyOf);

  save();
  await warmFingerprints();

  if (receipts.length) {
    try {
      await S.store.update((d) => d.receipts.push(...receipts));
    } catch (e) {
      S.sync.error = "Receipts not sent: " + e.message;
    }
  }
  render();
}

let pollTimer = null;
async function poll() {
  clearTimeout(pollTimer);
  const store = S.store;
  if (!store) return;
  try {
    const doc = await store.pull();
    if (S.store !== store || !S.me) return;
    const hadError = !!S.sync.error;
    S.sync = { at: Date.now(), error: "" };
    if (hadError) renderBar();
    updateSyncStatus();
    await runSync(doc);
  } catch (e) {
    S.sync.error = e.message;
    updateSyncStatus();
  }
  if (S.store !== store) return; // the room changed while we were waiting
  pollTimer = setTimeout(poll, document.hidden ? store.pollMs * 3 : store.pollMs);
}
async function write(fn) {
  try {
    const doc = await S.store.update(fn);
    S.sync = { at: Date.now(), error: "" };
    await runSync(doc);
    return true;
  } catch (e) {
    flash(e.message);
    S.sync.error = e.message;
    renderBar();
    return false;
  }
}

// ---- sending -----------------------------------------------------------------------------------
// letters: [{ to, body, prev? }]. A letter with `prev` reuses that chain
// position instead of extending the chain (used to demonstrate equivocation).
// Everything goes out in one write, to stay inside GitHub's write limits.
async function sendLetters(letters) {
  const me = S.me;
  const records = [];
  for (const { to, body, prev } of letters) {
    me.nextSeq[to] = (me.nextSeq[to] || 0) + 1;
    const env = P.signEnvelope(me.seed, { from: me.name, to, seq: me.nextSeq[to], ts: now(), prev: prev ?? me.chainHead, body });
    const digest = await P.envelopeDigest(env);
    me.chainHead = digest;
    const record = { env, digest, at: now(), receipt: null, forged: 0, failed: "" };
    me.sent.push(record);
    records.push(record);
  }
  save();
  if (!(await deliver(records.map((r) => r.env)))) {
    for (const r of records) r.failed = S.sync.error || "Not delivered";
    save();
    render();
  }
  return records;
}
function sendLetter(to, body) { return sendLetters([{ to, body }]); }
function deliver(envs) {
  return write((d) => {
    for (const env of envs) (d.checkpoint ? d.road : d.delivered).push({ id: rid(), deliverTo: env.to, env, sentAt: now() });
  });
}

// ---- shell ------------------------------------------------------------------------------------------
const TABS = [
  ["letters", "Letters"],
  ["seals", "Seal ceremony"],
  ["city", "Vharos"],
  ["tribunal", "Tribunal"],
  ["treaty", "Treaty"],
  ["lesson", "How it works"],
];

function enterRoom() {
  app().replaceChildren(
    h("div", { class: "shell" },
      h("header", { class: "bar", id: "bar" }),
      h("nav", { class: "tabs", id: "tabs", role: "tablist", "aria-label": "Sections" }),
      h("main", { class: "view", id: "view", role: "tabpanel", tabindex: "-1" })));
  mountTab();
  syncing = syncing.then(() => syncDoc(null, true));
  poll();
  clearInterval(S.ticker);
  S.ticker = setInterval(tick, 5000);
}

// Every 5 s: refresh "synced …" and relative times in place, and re-render only
// if a sent letter has just passed the point where its missing receipt matters.
function tick() {
  updateSyncStatus();
  refreshTimes();
  if (S.receiptDeadline && now() >= S.receiptDeadline && S.tab === "letters") render();
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.store) poll(); });

function render() {
  renderBar();
  renderTabs();
  S.updaters[S.tab]?.();
}

function renderBar() {
  const bar = document.getElementById("bar");
  if (!bar || !S.me) return;
  const check = h("input", { type: "checkbox", checked: S.check || null, onchange: (e) => { S.check = e.target.checked; render(); } });
  bar.replaceChildren(...[
    h("span", { class: "room" }, S.doc.title),
    h("span", { id: "sync", class: "sync", role: "status" }),
    LS.persistent ? null : h("span", { class: "sync err", title: "Private browsing or a locked-down browser" }, "This browser won't save your seal. Keep this tab open."),
    h("label", { class: "switch", title: "Turn this off to read letters the way people did before signatures" }, check, "Check seals"),
    h("div", { class: "me" },
      drawSeal({ pub: S.me.pub, initial: S.me.name, size: 38, title: "Your seal" }),
      h("div", { class: "who" }, h("b", {}, S.me.name), h("span", { class: "fp small muted" }, fpNow(S.me.pub))),
      h("button", { class: "quiet small", title: "Switch to a different identity", onclick: () => { SS.removeItem(K.active()); LS.removeItem(K.last()); restart(); } }, "Switch")),
  ].filter(Boolean));
  updateSyncStatus();
}

function updateSyncStatus() {
  const el = document.getElementById("sync");
  if (!el || !S.store) return;
  const secs = S.sync.at ? Math.round((Date.now() - S.sync.at) / 1000) : null;
  const text = S.sync.error || `${S.store.label}${secs !== null ? `, synced ${secs < 5 ? "now" : secs < 90 ? secs + " s ago" : Math.round(secs / 60) + " min ago"}` : ", connecting…"}`;
  if (el.textContent !== text) el.textContent = text;
  el.classList.toggle("err", !!S.sync.error);
}

function counts() {
  const unseen = S.me.inbox.filter((m) => S.fresh.has(m.id)).length;
  const conflicts = sealConflicts().length;
  const forks = S.forks?.length || 0;
  return { letters: unseen, seals: conflicts, tribunal: forks };
}
function renderTabs() {
  const nav = document.getElementById("tabs");
  if (!nav) return;
  const c = counts();
  nav.replaceChildren(...TABS.map(([id, label]) =>
    h("button", {
      role: "tab", "aria-selected": String(S.tab === id), "aria-controls": "view", class: id === "city" ? "city" : "",
      onclick: () => { S.tab = id; mountTab(); },
    }, label, c[id] ? h("span", { class: "count" + (id === "letters" ? " warn" : "") }, c[id]) : null)));
}

function mountTab() {
  const view = document.getElementById("view");
  view.replaceChildren();
  S.updaters = {};
  ({ letters: mountLetters, seals: mountSeals, city: mountCity, tribunal: mountTribunal, treaty: mountTreaty, lesson: mountLesson })[S.tab](view);
  renderBar();
  renderTabs();
  view.focus?.();
}

// ---- Letters ---------------------------------------------------------------------------------------
const VERDICT = {
  [P.Status.ACCEPTED]: { cls: "v-ok", seal: "intact", label: "Genuine" },
  [P.Status.GAP]: { cls: "v-warn", seal: "intact", label: "Genuine, but a letter is missing" },
  [P.Status.BAD_SIG]: { cls: "v-bad v-false", seal: "cracked", label: "Seal broken" },
  [P.Status.UNKNOWN]: { cls: "v-bad v-false", seal: "blank", label: "Seal you don't recognise" },
  [P.Status.MALFORMED]: { cls: "v-bad v-false", seal: "torn", label: "Torn letter" },
  [P.Status.MISROUTED]: { cls: "v-bad", seal: "intact", label: "Not addressed to you" },
  [P.Status.EXPIRED]: { cls: "v-bad", seal: "intact", label: "Too old" },
  [P.Status.REPLAY]: { cls: "v-bad", seal: "intact", label: "Delivered twice" },
  [P.Status.OUT_OF_ORDER]: { cls: "v-bad", seal: "intact", label: "Old letter" },
};

function threadFor(name) {
  const items = [];
  for (const m of S.me.inbox) {
    const from = typeof m.env?.from === "string" ? m.env.from : "(unreadable)";
    const bucket = S.me.pins[from] || from === S.me.name ? from : "__unknown";
    if (bucket === name) items.push({ kind: "in", at: m.at, m });
  }
  if (name !== "__unknown") for (const s of S.me.sent) if (s.env.to === name) items.push({ kind: "out", at: s.at, s });
  return items.sort((a, b) => a.at - b.at);
}

function letterIn(m) {
  const v = VERDICT[m.status] || VERDICT[P.Status.MALFORMED];
  const env = m.env || {};
  const from = typeof env.from === "string" ? env.from : "unknown";
  const pin = S.me.pins[from];
  const body = typeof env.body === "string" ? env.body : "(the letter could not be read)";
  if (!S.check) {
    // Seal checking off: every letter looks equally believable.
    return h("article", { class: "letter" },
      h("div", { class: "meta" }, `From ${from}, `, timeEl(m.at)),
      h("div", { class: "body" }, body));
  }
  const fresh = S.fresh.has(m.id) && v.seal === "cracked";
  const art = h("article", { class: `letter ${v.cls}${fresh ? " crack-in" : ""}` },
    h("div", { class: "meta" }, `From ${from}`, typeof env.seq === "number" ? `, letter #${env.seq}` : "", ", ", timeEl(m.at)),
    h("div", { class: "body" }, body),
    h("div", { class: "verdict" }, h("b", {}, v.label), m.detail),
    pin && !pin.verified && P.isAccepted(m.status)
      ? h("div", { class: "receipt" }, `You haven't checked ${from}'s fingerprint in person yet, so this only proves it came from whoever posted that seal.`)
      : null,
    drawSeal({ pub: keyOf(from) || "", initial: from, state: v.seal, size: 54, title: v.label }));
  return art;
}

function letterOut(s) {
  const late = !s.receipt && now() - s.at > RECEIPT_GRACE;
  if (!s.receipt && !late && !s.failed) S.receiptDeadline = Math.min(S.receiptDeadline || Infinity, s.at + RECEIPT_GRACE);
  let rc;
  if (s.failed) rc = h("div", { class: "receipt bad" }, `Not sent: ${s.failed} `, h("button", { class: "small quiet", onclick: async () => { s.failed = ""; save(); if (!(await deliver([s.env]))) { s.failed = S.sync.error; save(); } render(); } }, "Try again"));
  else if (s.receipt) rc = h("div", { class: "receipt ok" }, `Receipt signed by ${s.receipt.by} at ${clock(s.receipt.at)}. They can't say they never got it.`);
  else if (late) rc = h("div", { class: "receipt bad" }, "No signed receipt. The courier may have been stopped or the letter changed. ",
    h("button", { class: "small quiet", onclick: () => sendLetter(s.env.to, s.env.body) }, "Send it again"));
  else rc = h("div", { class: "receipt" }, "On the road. Waiting for a signed receipt.");
  return h("article", { class: "letter mine" },
    h("div", { class: "meta" }, `To ${s.env.to}, letter #${s.env.seq}, `, timeEl(s.at)),
    h("div", { class: "body" }, s.env.body),
    S.check ? rc : null,
    S.check && s.forged ? h("div", { class: "receipt bad" }, `Rejected ${s.forged} fake receipt${s.forged > 1 ? "s" : ""} claiming ${s.env.to} got this.`) : null,
    S.check ? drawSeal({ pub: S.me.pub, initial: S.me.name, size: 44, title: "Your seal" }) : null);
}

function mountLetters(view) {
  const allies = h("div", { class: "allies", role: "tablist", "aria-label": "Allies" });
  const thread = h("div", { class: "thread", "aria-live": "polite" });
  const banner = h("div", {});
  const text = h("textarea", { maxlength: BODY_MAX, placeholder: "Write your letter…", "aria-label": "Letter" });
  const head = h("h2", {});
  const counter = h("span", { class: "counter", "aria-live": "off" });
  const updateCounter = () => {
    const left = BODY_MAX - text.value.length;
    counter.textContent = text.value ? `${left} characters left` : "Ctrl+Enter to send";
    counter.classList.toggle("near", left < 60);
  };
  // Drafts belong to the ally they were written to, so switching ally never
  // sends half a letter to the wrong army.
  S.drafts = S.drafts || {};
  const sent = () => { text.value = ""; delete S.drafts[S.thread]; updateCounter(); text.focus(); };
  const compose = h("div", { class: "compose" },
    text,
    h("div", { class: "row" },
      h("button", {
        onclick: async () => {
          const body = text.value.trim();
          if (!body || !S.thread || S.thread === "__unknown") return;
          const to = S.thread;
          sent();
          await sendLetter(to, body);
          thread.lastElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        },
      }, "Seal and send"),
      h("button", {
        class: "quiet",
        onclick: async () => {
          const body = text.value.trim();
          const names = Object.keys(S.me.pins);
          if (!body || !names.length) return;
          sent();
          await sendLetters(names.map((to) => ({ to, body })));
          flash(`Sealed and sent ${names.length} copies.`);
        },
      }, "Send to every ally"),
      counter),
    h("p", { class: "small muted", style: "margin:.6rem 0 0" }, "Each copy is sealed separately with your private key, the ally's name, a number and the time."));
  text.addEventListener("keydown", (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) compose.querySelector("button").click(); });
  text.addEventListener("input", () => { if (S.thread) S.drafts[S.thread] = text.value; updateCounter(); });
  const selectThread = (name) => {
    if (S.thread === name) return;
    S.thread = name;
    text.value = S.drafts[name] || "";
    updateCounter();
    S.updaters.letters();
  };
  updateCounter();

  view.append(
    h("div", { class: "letters-layout" },
      h("div", {}, h("h3", {}, "Allies"), allies),
      h("div", {}, banner, head, thread, compose)));

  S.updaters.letters = () => {
    S.receiptDeadline = null; // recomputed by letterOut() for the letters on screen
    const names = Object.keys(S.me.pins).sort();
    const hasUnknown = S.me.inbox.some((m) => !(S.me.pins[m.env?.from] || m.env?.from === S.me.name));
    if (!S.thread || (S.thread !== "__unknown" && !S.me.pins[S.thread])) S.thread = names[0] || (hasUnknown ? "__unknown" : null);

    allies.replaceChildren(...[
      ...names.map((n) => {
        const bad = S.me.inbox.filter((m) => m.env?.from === n && !P.isAccepted(m.status)).length;
        const pin = S.me.pins[n];
        return h("button", { class: "ally", role: "tab", "aria-selected": String(S.thread === n), onclick: () => selectThread(n) },
          drawSeal({ pub: pin.pub, initial: n, size: 30 }), n,
          S.check && bad ? h("span", { class: "tag bad" }, `${bad} rejected`) : S.check && !pin.verified ? h("span", { class: "tag" }, "unchecked") : null);
      }),
      hasUnknown ? h("button", { class: "ally", role: "tab", "aria-selected": String(S.thread === "__unknown"), onclick: () => selectThread("__unknown") },
        drawSeal({ pub: "", initial: "?", state: "blank", size: 30 }), "Strangers") : null,
    ].filter(Boolean));

    banner.replaceChildren(S.check ? h("span") : h("p", { class: "notice unchecked-banner" },
      "Seal checking is off. You are reading letters the way people did before signatures: every letter looks just as believable as the next."));

    if (!S.thread) {
      head.textContent = "";
      thread.replaceChildren(h("p", { class: "empty" }, "No allies yet. When others in your room forge their seals, they appear here."));
      compose.hidden = true;
      return;
    }
    head.textContent = S.thread === "__unknown" ? "Letters from strangers" : `Letters with ${S.thread}`;
    compose.hidden = S.thread === "__unknown";
    const items = threadFor(S.thread);
    thread.replaceChildren(...(items.length
      ? items.map((it) => (it.kind === "in" ? letterIn(it.m) : letterOut(it.s)))
      : [h("p", { class: "empty" }, `Nothing yet. Write ${S.thread} a letter below.`)]));
    // Letters on screen are no longer new.
    for (const it of items) if (it.kind === "in") S.fresh.delete(it.m.id);
  };
  S.updaters.letters();
}

// ---- Seal ceremony ----------------------------------------------------------------------------------
function sealConflicts() {
  const out = [];
  for (const s of S.doc?.seals || []) {
    if (typeof s.name !== "string") continue;
    const mine = s.name === S.me.name ? S.me.pub : S.me.pins[s.name]?.pub;
    if (mine && s.pub !== mine) out.push(s);
  }
  return out;
}

function mountSeals(view) {
  const mineBox = h("div", {});
  const list = h("div", { class: "seal-list" });
  view.append(
    h("div", { class: "panel-intro" },
      h("h2", {}, "Seal ceremony"),
      h("p", {}, "Before the campaign, the commanders met in person and compared seals. Do the same: read your fingerprint aloud, and tick each ally only after their fingerprint matches what they read out. The road can't be trusted to tell you whose seal is whose.")),
    mineBox, h("h3", {}, "Seals posted on the road"), list);

  S.updaters.seals = () => {
    mineBox.replaceChildren(
      h("div", { class: "my-seal" },
        drawSeal({ pub: S.me.pub, initial: S.me.name, size: 110, title: "Your seal" }),
        h("div", {},
          h("div", { class: "muted" }, `Your fingerprint, ${S.me.name}`),
          h("div", { class: "fp-big" }, fpNow(S.me.pub)),
          h("p", { class: "small muted", style: "margin:0" }, "Read this out loud. Your private key stays in this browser and never goes on the road."))));

    const conflicts = sealConflicts();
    const rows = [];
    for (const s of conflicts) {
      const isMe = s.name === S.me.name;
      rows.push(h("div", { class: "seal-row conflict" },
        drawSeal({ pub: s.pub, initial: s.name, size: 48 }),
        h("div", {},
          h("b", {}, isMe ? `A seal in your name: ${s.name}` : `A different seal for ${s.name}`),
          h("div", { class: "fp" }, fpNow(s.pub)),
          h("div", { class: "state bad" }, isMe
            ? "Someone posted a seal pretending to be you. Tell your allies your real fingerprint."
            : `This doesn't match the seal you already have for ${s.name} (${fpNow(S.me.pins[s.name].pub)}). Someone may be impersonating them.`)),
        isMe ? h("span") : h("button", {
          class: "quiet small",
          onclick: (e) => {
            const btn = e.currentTarget;
            if (!btn.dataset.armed) {
              btn.dataset.armed = "1";
              btn.textContent = `Yes, ${s.name} told me this in person`;
              btn.className = "danger small";
              return;
            }
            S.me.pins[s.name] = { pub: s.pub, verified: true, at: now() };
            save(); render();
          },
        }, "Use this seal instead")));
    }
    for (const name of Object.keys(S.me.pins).sort()) {
      const pin = S.me.pins[name];
      rows.push(h("div", { class: "seal-row" },
        drawSeal({ pub: pin.pub, initial: name, size: 48 }),
        h("div", {},
          h("b", {}, name),
          h("div", { class: "fp" }, fpNow(pin.pub)),
          h("div", { class: "state " + (pin.verified ? "ok" : "warn") },
            pin.verified ? "Checked in person" : "Not checked yet. Letters with this seal only prove they came from whoever posted it.")),
        pin.verified
          ? h("button", { class: "quiet small", onclick: () => { pin.verified = false; save(); render(); } }, "Undo")
          : h("button", { class: "small", onclick: () => { pin.verified = true; save(); render(); } }, "It matches")));
    }
    list.replaceChildren(...(rows.length ? rows : [h("p", { class: "empty" }, "No one else has posted a seal yet.")]));
  };
  S.updaters.seals();
}

// ---- Vharos: the city in the middle -------------------------------------------------------------
function cityPub() { return P.publicKeyFromSeed(citySeed()); }

function editDialog(item) {
  const env = item.env || {};
  const f = {
    body: h("textarea", { value: env.body ?? "" }),
    from: h("input", { type: "text", value: env.from ?? "" }),
    to: h("input", { type: "text", value: env.to ?? "" }),
    deliverTo: h("input", { type: "text", value: item.deliverTo ?? "" }),
    ts: h("input", { type: "text", value: env.ts ? clock24(env.ts) : "" }),
  };
  const reseal = h("input", { type: "checkbox" });
  const dlg = h("dialog", {},
    h("h3", {}, "Rewrite this letter"),
    h("p", { class: "muted small" }, "You can change anything, but you don't have the sender's private key. You can only re-seal with your own."),
    h("label", {}, "Letter text"), f.body,
    h("div", { class: "row", style: "flex-wrap:nowrap;align-items:flex-start" },
      h("div", { style: "flex:1" }, h("label", {}, "Signed by"), f.from),
      h("div", { style: "flex:1" }, h("label", {}, "Addressed to (inside)"), f.to)),
    h("div", { class: "row", style: "flex-wrap:nowrap;align-items:flex-start" },
      h("div", { style: "flex:1" }, h("label", {}, "Deliver to (outside label)"), f.deliverTo),
      h("div", { style: "flex:1" }, h("label", {}, "Time written (HH:MM)"), f.ts)),
    h("label", { class: "switch", style: "margin-top:.9rem" }, reseal, "Re-seal it with Vharos's own wax"),
    h("div", { class: "row", style: "margin-top:1rem" },
      h("button", {
        class: "danger",
        onclick: async () => {
          const ok = await write((d) => {
            const it = d.road.find((x) => x.id === item.id);
            if (!it) throw new Error("That courier already left the road.");
            it.env = { ...it.env, body: f.body.value, from: f.from.value, to: f.to.value };
            const m = /^(\d{1,2}):(\d{2})$/.exec(f.ts.value.trim());
            if (m && it.env.ts) {
              const dt = new Date(it.env.ts * 1000);
              dt.setHours(+m[1], +m[2]);
              it.env.ts = Math.floor(dt.getTime() / 1000);
            }
            it.deliverTo = f.deliverTo.value;
            if (reseal.checked) it.env.sig = resealWith(citySeed(), it.env);
          });
          if (ok) { dlg.close(); dlg.remove(); flash("Letter rewritten. It's still on the road."); }
        },
      }, "Save changes"),
      h("button", { class: "quiet", onclick: () => { dlg.close(); dlg.remove(); } }, "Cancel")));
  document.body.appendChild(dlg);
  dlg.showModal();
}
function resealWith(seed, env) {
  // Same nonce and fields, new signature from a key that isn't the sender's.
  const kp = globalThis.nacl.sign.keyPair.fromSeed(P.fromHex(seed, 32));
  return P.toHex(globalThis.nacl.sign.detached(P.envelopeSignedBytes(env), kp.secretKey));
}

function mountCity(view) {
  const head = h("div", { class: "city-head" });
  const road = h("div", {});
  const delivered = h("div", {});
  const names = () => [...new Set([S.me.name, ...Object.keys(S.me.pins), ...S.doc.seals.map((s) => s.name)])].filter((n) => typeof n === "string").sort();

  const forgeFrom = h("input", { type: "text", placeholder: "Write as… (e.g. Cyrene)" });
  const forgeTo = h("input", { type: "text", placeholder: "Deliver to…" });
  const forgeBody = h("textarea", { placeholder: "Aurelia has betrayed us. Withdraw at once." });
  const fakeName = h("input", { type: "text", placeholder: "Name to impersonate, or a new one" });
  const treatySel = h("select", {});
  const treatyTerms = h("textarea", {});

  view.append(head,
    h("div", { class: "city-grid" },
      h("section", {}, h("h3", {}, "Couriers stopped at the gate"), road),
      h("section", {}, h("h3", {}, "Letters already delivered"), delivered),
      h("section", {},
        h("div", { class: "toolbox" },
          h("h3", {}, "Forge a letter"),
          h("p", { class: "small muted" }, "You can write anything in anyone's name. You can only seal it with Vharos's wax."),
          h("label", {}, "Signed as"), forgeFrom,
          h("label", {}, "Deliver to"), forgeTo,
          h("label", {}, "Text"), forgeBody,
          h("div", { class: "row", style: "margin-top:.7rem" },
            h("button", {
              class: "danger",
              onclick: async () => {
                const from = forgeFrom.value.trim(), to = forgeTo.value.trim(), body = forgeBody.value.trim();
                if (!from || !to || !body) return flash("Fill in all three.");
                const env = P.signEnvelope(citySeed(), { from, to, seq: 1 + Math.floor(Math.random() * 3), ts: now(), prev: P.ZERO_PREV, body });
                if (await write((d) => d.delivered.push({ id: rid(), deliverTo: to, env, sentAt: now() }))) { forgeBody.value = ""; flash(`Forged letter delivered to ${to}.`); }
              },
            }, "Deliver forgery"))),
        h("div", { class: "toolbox" },
          h("h3", {}, "Post a fake seal"),
          h("p", { class: "small muted" }, "Post Vharos's seal under someone's name. Anyone who hasn't seen the real one yet may trust it. Anyone who has will see a warning."),
          fakeName,
          h("div", { class: "row", style: "margin-top:.7rem" },
            h("button", {
              class: "danger",
              onclick: async () => {
                const name = fakeName.value.trim();
                if (!name) return;
                if (await write((d) => d.seals.push({ name, pub: cityPub(), at: now() }))) { fakeName.value = ""; flash(`Fake seal posted for ${name}.`); }
              },
            }, "Post fake seal"))),
        h("div", { class: "toolbox" },
          h("h3", {}, "Doctor a treaty"),
          treatySel, h("label", {}, "New terms"), treatyTerms,
          h("div", { class: "row", style: "margin-top:.7rem" },
            h("button", {
              class: "danger",
              onclick: async () => {
                const id = treatySel.value;
                if (!id) return;
                if (await write((d) => { const t = d.treaties.find((x) => x.id === id); if (t) t.terms = treatyTerms.value; })) flash("Treaty terms changed.");
              },
            }, "Change terms"))))));
  treatySel.addEventListener("change", () => { treatyTerms.value = S.doc.treaties.find((t) => t.id === treatySel.value)?.terms || ""; });

  S.updaters.city = () => {
    head.replaceChildren(
      h("h2", {}, "You are the city of Vharos"),
      h("p", {}, "Every courier rides past your walls. Read, rewrite, forge, copy, delay or burn whatever you like. Then watch which tricks the armies catch."),
      h("label", { class: "switch" },
        h("input", { type: "checkbox", checked: S.doc.checkpoint || null, onchange: (e) => write((d) => { d.checkpoint = e.target.checked; }) }),
        S.doc.checkpoint ? "Couriers are being stopped at the gate" : "Couriers pass freely. Turn on to stop them"));

    const roadItems = S.doc.road.filter((x) => x && x.env);
    road.replaceChildren(...(roadItems.length ? roadItems.map((it) => {
      return h("div", { class: "courier" },
        h("div", { class: "route" }, h("b", {}, String(it.env.from)), " to ", h("b", {}, String(it.deliverTo)), ", held ", timeEl(it.sentAt || now(), "held")),
        h("div", { class: "body" }, String(it.env.body)),
        h("div", { class: "row" },
          h("button", { class: "small", onclick: () => write((d) => { const i = d.road.findIndex((x) => x.id === it.id); if (i >= 0) d.delivered.push(...d.road.splice(i, 1)); }) }, "Let it through"),
          h("button", { class: "small danger", onclick: () => editDialog(it) }, "Rewrite"),
          h("button", { class: "small quiet", onclick: () => write((d) => { d.road = d.road.filter((x) => x.id !== it.id); }) }, "Burn it"),
          h("button", {
            class: "small quiet", title: "Burn the letter, then send the sender a receipt pretending it arrived",
            onclick: async () => {
              const r = P.signReceipt(citySeed(), { by: it.env.to, for: it.env.from, env: await P.envelopeDigest(it.env), at: now() });
              write((d) => { d.road = d.road.filter((x) => x.id !== it.id); d.receipts.push(r); });
            },
          }, "Burn and fake a receipt")));
    }) : [h("p", { class: "empty" }, S.doc.checkpoint ? "No couriers waiting. New letters will stop here." : "Turn on the checkpoint to stop new letters here.")]));

    const recent = S.doc.delivered.filter((x) => x && x.env).slice(-8).reverse();
    const nameList = names();
    delivered.replaceChildren(...(recent.length ? recent.map((it) => {
      const sel = h("select", { "aria-label": "Deliver a copy to" }, nameList.map((n) => h("option", { value: n, selected: n === it.deliverTo || null }, n)));
      return h("div", { class: "courier" },
        h("div", { class: "route" }, h("b", {}, String(it.env.from)), " to ", h("b", {}, String(it.deliverTo))),
        h("div", { class: "body" }, String(it.env.body)),
        h("div", { class: "row" },
          h("span", { class: "small muted" }, "Deliver a copy to"), h("div", { style: "flex:1;min-width:8rem" }, sel),
          h("button", { class: "small danger", onclick: () => write((d) => d.delivered.push({ id: rid(), deliverTo: sel.value, env: it.env, sentAt: now() })) }, "Send copy")));
    }) : [h("p", { class: "empty" }, "Nothing delivered yet.")]));

    const keep = treatySel.value;
    treatySel.replaceChildren(h("option", { value: "" }, S.doc.treaties.length ? "Choose a treaty" : "No treaties yet"),
      ...S.doc.treaties.map((t) => h("option", { value: t.id, selected: t.id === keep || null }, String(t.terms).slice(0, 50))));
  };
  S.updaters.city();
}

// ---- Tribunal -------------------------------------------------------------------------------------------
function mountTribunal(view) {
  const forks = h("div", {});
  const exhibits = h("div", { class: "exhibits" });
  const detail = h("div", {});
  const paste = h("textarea", { placeholder: "Paste evidence JSON here", style: "font-family:var(--mono);font-size:.85rem;min-height:7rem" });
  const pasteOut = h("div", {});
  const lieA = h("textarea", { placeholder: "What you tell the first ally" });
  const lieB = h("textarea", { placeholder: "What you tell the second ally" });
  const lieToA = h("select", {}), lieToB = h("select", {});
  let selected = null;

  view.append(
    h("div", { class: "panel-intro" },
      h("h2", {}, "Tribunal"),
      h("p", {}, "When the allies argue about who said what, opinions don't count. Only sealed evidence does, and anyone holding the right seals can check it themselves.")),
    forks,
    h("div", { class: "two-col" },
      h("div", {}, h("h3", {}, "Evidence you hold"), exhibits),
      h("div", {}, detail)),
    h("div", { class: "two-col", style: "margin-top:2rem" },
      h("div", {},
        h("h3", {}, "Check someone else's evidence"),
        h("p", { class: "small muted" }, "An ally hands you a letter they say proves something. Paste it here. It's checked against the seals you trust, not the one that came with it."),
        paste,
        h("div", { class: "row", style: "margin-top:.6rem" }, h("button", { onclick: () => checkPasted(paste.value, pasteOut) }, "Check evidence"))),
      h("div", {}, pasteOut)),
    h("section", { style: "margin-top:2.4rem;max-width:760px" },
      h("h3", {}, "Try to tell two stories"),
      h("p", { class: "small muted" }, "Send two allies different promises, each sealed as if it were your only next letter. Each one looks genuine on its own. See if the tribunal catches you."),
      h("div", { class: "two-col", style: "grid-template-columns:1fr 1fr;gap:.8rem" },
        h("div", {}, h("label", {}, "To"), lieToA, lieA),
        h("div", {}, h("label", {}, "To"), lieToB, lieB)),
      h("div", { class: "row", style: "margin-top:.6rem" },
        h("button", {
          class: "danger",
          onclick: async () => {
            const a = lieToA.value, b = lieToB.value;
            if (!a || !b || a === b || !lieA.value.trim() || !lieB.value.trim()) return flash("Pick two different allies and write both letters.");
            const prev = S.me.chainHead;
            await sendLetters([{ to: a, body: lieA.value.trim(), prev }, { to: b, body: lieB.value.trim(), prev }]);
            lieA.value = lieB.value = "";
            flash("Both letters sent. Each points back to the same earlier letter of yours.");
          },
        }, "Send both"))));

  S.updaters.tribunal = async () => {
    const pins = Object.keys(S.me.pins).sort();
    for (const sel of [lieToA, lieToB]) {
      const keep = sel.value;
      sel.replaceChildren(h("option", { value: "" }, "Choose an ally"), ...pins.map((n) => h("option", { value: n, selected: n === keep || null }, n)));
    }

    // Pool every letter visible to anyone: the road is public.
    const found = S.forks || [];
    forks.replaceChildren(...found.map((f) => h("div", { class: "fork" },
      h("b", {}, `${f.sender} told two allies two different stories.`),
      h("p", { class: "small", style: "margin:.3rem 0" }, `Both letters carry ${f.sender}'s genuine seal and both claim to come right after the same earlier letter. Only ${f.sender} could have sealed them.`),
      h("div", {}, `To ${f.first.to}: `, h("q", {}, f.first.body)),
      h("div", {}, `To ${f.second.to}: `, h("q", {}, f.second.body)))));
    renderTabs();

    const ex = [
      ...S.me.inbox.filter((m) => P.isAccepted(m.status)).map((m) => ({ key: "in:" + m.id, label: `${m.env.from}: ${m.env.body}`, pub: keyOf(m.env.from), name: m.env.from, kind: "letter", m })),
      ...S.me.sent.filter((s) => s.receipt).map((s) => ({ key: "rc:" + s.digest, label: `Receipt from ${s.receipt.by}: ${s.env.body}`, pub: keyOf(s.receipt.by), name: s.receipt.by, kind: "receipt", s })),
    ].reverse();
    if (!selected && ex.length) selected = ex[0].key;
    exhibits.replaceChildren(...(ex.length ? ex.map((x) => h("button", { class: "exhibit", "aria-selected": String(x.key === selected), onclick: () => { selected = x.key; S.updaters.tribunal(); } },
      drawSeal({ pub: x.pub || "", initial: x.name, size: 26 }), h("span", {}, x.label))) : [h("p", { class: "empty" }, "Genuine letters you receive, and signed receipts for letters you send, collect here.")]));
    const cur = ex.find((x) => x.key === selected);
    detail.replaceChildren(cur ? await evidenceCard(cur) : h("span"));
  };
  S.updaters.tribunal();
}

async function evidenceCard(x) {
  const env = x.kind === "letter" ? x.m.env : x.s.env;
  const digest = await P.envelopeDigest(env);
  const senderPub = keyOf(env.from);
  const sigOk = P.verifyEnvelope(env, senderPub);
  let evidence, claim, checks;
  if (x.kind === "letter") {
    claim = `${env.from} sealed this letter to ${env.to} at ${clock(env.ts)}.`;
    evidence = { kind: "siegeseal-letter", letter: env, sealOf: { name: env.from, pub: senderPub } };
    checks = [
      [sigOk ? "ok" : "bad", `The signature matches ${env.from}'s seal (${fpNow(senderPub)}). Only the holder of that private key could have made it.`],
      ["ok", `It names ${env.to} as the recipient, letter #${env.seq} from ${env.from}.`],
      ["ok", `Changing even one character gives a different fingerprint than ${digest.slice(0, 16)}…, and the seal would no longer match.`],
      [S.me.pins[env.from]?.verified ? "ok" : "warn", S.me.pins[env.from]?.verified ? `You checked ${env.from}'s fingerprint in person.` : `You haven't checked ${env.from}'s fingerprint in person. Until you do, this proves less.`],
    ];
  } else {
    const r = x.s.receipt.rcpt;
    const rcOk = r && P.verifyReceipt(r, keyOf(r.by));
    claim = `${r.by} signed that they received your letter at ${clock(r.at)}.`;
    evidence = { kind: "siegeseal-receipt", letter: env, receipt: r, sealOf: { name: r.by, pub: keyOf(r.by) } };
    checks = [
      [rcOk ? "ok" : "bad", `The receipt is signed with ${r.by}'s seal (${fpNow(keyOf(r.by))}).`],
      [r.env === digest ? "ok" : "bad", "The receipt names exactly this letter, by its fingerprint."],
      ["ok", `${r.by} can't claim the letter never arrived, or that it said something else.`],
    ];
  }
  const json = JSON.stringify(evidence, null, 2);
  const wire = P.toHex(P.envelopeWire(env));
  return h("div", { class: "evidence" },
    h("h3", {}, x.kind === "letter" ? "A sealed letter" : "A signed receipt"),
    h("p", { class: "muted" }, claim),
    h("blockquote", {}, env.body),
    h("ul", { class: "checks" }, checks.map(([c, t]) => h("li", { class: c }, t))),
    h("div", { class: "row" }, h("button", { onclick: () => copy(json, "Evidence copied. Paste it in the tribunal box on another device.") }, "Copy evidence")),
    h("details", { class: "raw" }, h("summary", {}, "Exactly what was signed"),
      h("pre", {}, P.toHex(P.envelopeSignedBytes(env))),
      h("p", { class: "small muted" }, "The tag SIEGESEAL/ENVELOPE/v1, then version, sender, recipient, number, time, nonce, previous-letter link and text, each length-prefixed.")),
    h("details", { class: "raw" }, h("summary", {}, "Check it with the C++ tool"),
      h("pre", {}, `echo "siegeseal-public ${env.from} ${senderPub}" > ${env.from}.pub\necho "${wire}" > letter.hex\nsiegeseal verify-envelope ${env.from}.pub letter.hex`)));
}

function checkPasted(text, out) {
  let ev;
  try { ev = JSON.parse(text); } catch { return out.replaceChildren(h("p", { class: "notice bad" }, "That isn't evidence JSON. Use Copy evidence on the other device.")); }
  const env = ev?.letter;
  const name = ev?.kind === "siegeseal-receipt" ? ev?.receipt?.by : env?.from;
  const trusted = keyOf(name);
  const items = [];
  if (!trusted) items.push(["bad", `You have no seal for ${name}. You can't check this.`]);
  else {
    if (ev?.sealOf?.pub && ev.sealOf.pub !== trusted) items.push(["warn", `The evidence came with a different seal for ${name} than the one you trust. Ignoring it and using yours.`]);
    if (ev.kind === "siegeseal-receipt") {
      const ok = P.verifyReceipt(ev.receipt, trusted);
      items.push([ok ? "ok" : "bad", ok ? `Genuine receipt: ${name} signed for this letter.` : `Forged or altered: the receipt doesn't match ${name}'s seal.`]);
    } else {
      const ok = P.verifyEnvelope(env, trusted);
      items.push([ok ? "ok" : "bad", ok ? `Genuine: ${name} sealed this letter. They can't deny it.` : `Forged or altered: this doesn't match ${name}'s seal. It proves nothing about ${name}.`]);
    }
  }
  out.replaceChildren(h("div", { class: "evidence" },
    h("h3", {}, "Verdict"),
    env?.body ? h("blockquote", {}, String(env.body)) : null,
    h("ul", { class: "checks" }, items.map(([c, t]) => h("li", { class: c }, t)))));
}

// ---- Treaty ------------------------------------------------------------------------------------------------
function mountTreaty(view) {
  const list = h("div", {});
  const terms = h("textarea", { value: "The armies of Aurelia, Borealis and Cyrene will besiege Vharos together. No one makes a separate peace with the city. The spoils are shared equally." });
  const partyBox = h("div", { class: "armies" });
  view.append(
    h("div", { class: "panel-intro" },
      h("h2", {}, "Treaty"),
      h("p", {}, "A treaty binds only when every named party has sealed the exact same words. Change a comma and every seal breaks.")),
    list,
    h("section", { class: "compose", style: "max-width:700px" },
      h("h3", {}, "Propose a treaty"),
      terms, h("label", {}, "Who must seal it"), partyBox,
      h("div", { class: "row" }, h("button", {
        onclick: async () => {
          const parties = [...partyBox.querySelectorAll("input:checked")].map((i) => i.value);
          if (!terms.value.trim() || parties.length < 2) return flash("Write the terms and pick at least two parties.");
          await write((d) => d.treaties.push({ id: rid(), terms: terms.value.trim(), parties, sigs: {}, by: S.me.name, at: now() }));
        },
      }, "Propose"))));

  S.updaters.treaty = () => {
    const candidates = [S.me.name, ...Object.keys(S.me.pins)].sort();
    const checked = new Set([...partyBox.querySelectorAll("input:checked")].map((i) => i.value));
    if (!partyBox.childElementCount) candidates.forEach((n) => checked.add(n));
    partyBox.replaceChildren(...candidates.map((n) => h("label", { class: "switch", style: "margin:0 .8rem 0 0" },
      h("input", { type: "checkbox", value: n, checked: checked.has(n) || null }), n)));

    list.replaceChildren(...S.doc.treaties.filter((t) => typeof t.terms === "string" && Array.isArray(t.parties)).slice().reverse().map((t) => {
      const st = P.checkTreaty(t, keyOf);
      const iAmParty = t.parties.includes(S.me.name);
      const iSigned = st.signed.includes(S.me.name);
      return h("article", { class: "treaty" },
        h("div", { class: "status " + (st.binding ? "ok" : st.broken.length ? "bad" : "") },
          st.binding ? "Binding: every party sealed these exact words." : st.broken.length ? "Not binding: some seals don't match these words. Someone changed the terms." : `Not binding yet: waiting for ${st.missing.join(", ")}.`),
        h("div", { class: "terms" }, t.terms),
        h("div", { class: "signers" }, t.parties.map((p) => {
          const state = st.signed.includes(p) ? "intact" : st.broken.includes(p) ? "cracked" : "blank";
          return h("span", { class: "signer" }, drawSeal({ pub: keyOf(p) || "", initial: p, state, size: 24 }), p,
            state === "blank" ? h("span", { class: "muted" }, " (not yet)") : null);
        })),
        iAmParty && !iSigned ? h("button", {
          onclick: () => {
            const seen = JSON.stringify([t.terms, t.parties]);
            const sig = P.signTreaty(S.me.seed, t);
            write((d) => {
              const live = d.treaties.find((x) => x.id === t.id);
              if (!live) throw new Error("That treaty is gone.");
              if (JSON.stringify([live.terms, live.parties]) !== seen) throw new Error("The terms changed while you were reading. Read them again before you seal.");
              live.sigs = { ...(live.sigs || {}), [S.me.name]: sig };
            });
          },
        }, "Seal these terms") : null);
    }));
    if (!S.doc.treaties.length) list.replaceChildren(h("p", { class: "empty" }, "No treaties yet. Propose one below."));
  };
  S.updaters.treaty();
}

// ---- Lesson --------------------------------------------------------------------------------------------------
function mountLesson(view) {
  view.append(h("article", { class: "lesson" },
    h("h2", { style: "margin-top:0" }, "The story"),
    h("div", { class: "story" },
      h("p", {}, "Three armies from three nations, Aurelia, Borealis and Cyrene, plan to besiege the city of Vharos together. They camp on different sides of the city, so every courier between them has to ride past its walls."),
      h("p", {}, "Vharos doesn't need to win a battle. It only needs to stop a courier and change one word. If Borealis reads \"attack at dusk\" while the others attack at dawn, the alliance destroys itself. And because the allies don't fully trust each other, each one will suspect the others of lying.")),
    h("h2", {}, "What a seal proves"),
    h("dl", {},
      h("dt", {}, "Integrity: nobody changed it"),
      h("dd", {}, "The seal is computed from every character of the letter. Change one letter and the seal no longer fits."),
      h("dt", {}, "Authenticity: it really came from them"),
      h("dd", {}, "Only the person holding the private key can make a seal that matches their public impression. Vharos can copy the look of a seal, but not make a new one."),
      h("dt", {}, "Non-repudiation: they can't take it back"),
      h("dd", {}, "Because only the sender could have made the seal, they can't later say \"I never wrote that\". Because the recipient signs a receipt, they can't say \"I never got it\". Anyone with the public seals can check, so it doesn't come down to one person's word against another's.")),
    h("h2", {}, "What else is sealed into every letter"),
    h("dl", {},
      h("dt", {}, "The recipient's name"), h("dd", {}, "So a real letter for Borealis can't be passed off to Cyrene."),
      h("dt", {}, "A number and a random tag"), h("dd", {}, "So an old order can't be delivered twice, and a missing number shows a courier was stopped."),
      h("dt", {}, "The time"), h("dd", {}, "So a letter held at the gate for hours is rejected as too old."),
      h("dt", {}, "A link to the sender's previous letter"), h("dd", {}, "So nobody can tell two allies two different stories without leaving sealed proof.")),
    h("h2", {}, "What it doesn't do"),
    h("dl", {},
      h("dt", {}, "Keep secrets"), h("dd", {}, "Vharos can read every letter in this app. Seals protect against changing and denying, not reading. Hiding the words needs encryption, which is a separate tool."),
      h("dt", {}, "Stop a courier"), h("dd", {}, "Vharos can still burn letters. Seals make sure you notice: a gap in the numbers, or no signed receipt."),
      h("dt", {}, "Fix a bad first meeting"), h("dd", {}, "If someone tricked you into trusting the wrong seal at the start, every check afterwards trusts the wrong person. That's why the seal ceremony happens face to face.")),
    h("h2", {}, "In the real world"),
    h("p", {}, "This is how software updates prove they came from the company that made them, how websites prove who they are (the padlock in your browser), how signed PDFs and contracts work, and how apps like Signal let you compare safety numbers with a friend. The math here is Ed25519, the same signature scheme used by SSH and many of those systems.")));
}

boot();
