// SiegeSeal Records — a classroom demo of CRUD with non-repudiation.
//
// 3–5 students share one board (a secret GitHub Gist, or tabs on one computer).
// Every create, update and delete is signed with the author's private key, which
// never leaves their browser. Each reader rebuilds the table from the signed log
// and checks every signature, so the shared store itself is never trusted.

import * as R from "./records.js";
import { LocalStore, GistStore } from "./store.js";
import { drawSeal } from "./seal.js";
import { LS, SS } from "./storage.js";

// ---- tiny DOM helper ---------------------------------------------------------------
function h(tag, props, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
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
function ago(ts) {
  const s = now() - ts;
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return new Date(ts * 1000).toLocaleDateString();
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const clock = (ts) => new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const seal = (name, pub, size = 30, state = "intact") => drawSeal({ pub, initial: (name || "?")[0].toUpperCase(), size, state, title: name });
async function copy(text, btn) {
  try { await navigator.clipboard.writeText(text); } catch { prompt("Copy this:", text); return; }
  if (btn) { const t = btn.textContent; btn.textContent = "Copied"; setTimeout(() => (btn.textContent = t), 1200); }
}

// ---- state & storage keys ------------------------------------------------------------
const S = {
  room: null, store: null, doc: null, me: null,
  check: true, tab: "records", showDeleted: false, editing: null,
  view: { keys: {}, conflicts: [], records: new Map(), log: [], missing: [] },
  sync: { at: 0, error: "" }, busy: false,
};
const K = {
  token: (room) => `ssr:token:${room}`,
  me: (name) => `ssr:me:${S.room}:${name}`,
  active: () => `ssr:active:${S.room}`,
  last: () => `ssr:last:${S.room}`,
  pins: () => `ssr:pins:${S.room}:${S.me.name}`,
  seen: () => `ssr:seen:${S.room}:${S.me.name}`,
  outbox: () => `ssr:outbox:${S.room}:${S.me.name}`,
  rooms: "ssr:rooms",
};
const load = (k, fallback) => { try { return JSON.parse(LS.getItem(k)) ?? fallback; } catch { return fallback; } };
const save = (k, v) => LS.setItem(k, JSON.stringify(v));

function parseHash() {
  const out = {};
  for (const part of location.hash.replace(/^#/, "").split("&")) {
    if (!part) continue;
    const i = part.indexOf("=");
    out[decodeURIComponent(i < 0 ? part : part.slice(0, i))] = i < 0 ? "" : decodeURIComponent(part.slice(i + 1));
  }
  return out;
}
function roomLink(withKey) {
  const base = location.origin + location.pathname;
  const token = LS.getItem(K.token(S.room));
  return `${base}#room=${encodeURIComponent(S.room)}` + (withKey && token ? `&key=${encodeURIComponent(token)}` : "");
}
function makeStore(room) {
  const i = room.indexOf(":");
  const kind = room.slice(0, i), id = room.slice(i + 1);
  if (kind === "local") return new LocalStore(id, R.SCHEMA);
  if (kind === "gist") {
    const st = new GistStore(id, LS.getItem(K.token(room)) || "", R.SCHEMA);
    if (st.token) st.pollMs = 4000; // unchanged polls (304) don't count against the token's rate limit
    return st;
  }
  throw new Error("That link is not a SiegeSeal Records board.");
}
function rememberRoom(room, title) {
  const rooms = load(K.rooms, []).filter((r) => r && r.room !== room);
  save(K.rooms, [{ room, title }, ...rooms].slice(0, 6));
}

// ---- boot ---------------------------------------------------------------------------------
async function boot() {
  if (!globalThis.nacl) return app().replaceChildren(h("p", { class: "boot" }, "The signature library did not load."));
  const p = parseHash();
  if (!p.room) return renderWelcome();
  S.room = p.room;
  if (p.key) LS.setItem(K.token(S.room), p.key);
  history.replaceState(null, "", location.pathname + location.search + "#room=" + encodeURIComponent(S.room)); // keep the key out of sight
  try {
    S.store = makeStore(S.room);
    S.doc = await S.store.pull();
    if (!S.doc || S.doc.app !== "siegeseal-records") throw new Error("This link doesn't point to a SiegeSeal Records board.");
  } catch (err) {
    return renderError(err);
  }
  rememberRoom(S.room, S.doc.title);
  const local = S.room.startsWith("local:");
  const name = SS.getItem(K.active()) || (local ? null : LS.getItem(K.last()));
  const saved = name && load(K.me(name), null);
  if (saved?.seed) { S.me = saved; return enter(); }
  renderJoin();
}
function restart() {
  clearTimeout(pollTimer);
  Object.assign(S, { room: null, store: null, doc: null, me: null, tab: "records", editing: null, sync: { at: 0, error: "" } });
  app().replaceChildren(h("p", { class: "boot" }, "Loading…"));
  boot();
}
window.addEventListener("hashchange", restart);
window.addEventListener("storage", (e) => { if (S.store && e.key?.startsWith(R.SCHEMA.prefix)) poll(); });

function renderError(err) {
  app().replaceChildren(h("div", { class: "welcome" },
    h("h1", {}, "Couldn't open this board"),
    h("p", { class: "notice bad" }, err.message || String(err)),
    h("p", {}, h("a", { href: location.pathname }, "Back to the start"))));
}

// ---- welcome ---------------------------------------------------------------------------------
function renderWelcome() {
  const localTitle = h("input", { type: "text", value: "Class records", maxlength: 80 });
  const gistTitle = h("input", { type: "text", value: "Class records", maxlength: 80 });
  const token = h("input", { type: "password", placeholder: "ghp_… or github_pat_…", autocomplete: "off" });
  const join = h("input", { type: "url", placeholder: "Paste the board link from your teacher" });
  const msg = h("p", { class: "small", role: "status" });
  const rooms = load(K.rooms, []).filter((r) => !r.room.startsWith("local:") || LS.getItem(R.SCHEMA.prefix + r.room.slice(6)) !== null);

  async function createGist(btn) {
    const t = token.value.trim();
    if (!t) { msg.className = "small notice bad"; msg.textContent = "Paste a GitHub token with the gist scope first."; return; }
    btn.disabled = true; msg.className = "small"; msg.textContent = "Creating a secret gist…";
    try {
      const id = await GistStore.create(t, gistTitle.value.trim(), R.SCHEMA);
      LS.setItem(K.token("gist:" + id), t);
      location.hash = "room=" + encodeURIComponent("gist:" + id);
    } catch (e) { msg.className = "small notice bad"; msg.textContent = e.message; btn.disabled = false; }
  }
  function joinLink() {
    const v = join.value.trim(), i = v.indexOf("#");
    if (i < 0) { msg.className = "small notice bad"; msg.textContent = "That doesn't look like a board link."; return; }
    location.hash = v.slice(i + 1);
  }

  app().replaceChildren(h("div", { class: "welcome" },
    h("p", { class: "eyebrow" }, "SiegeSeal Records"),
    h("h1", {}, "Create, read, update, delete — and prove who did it"),
    h("p", { class: "lede" }, "A shared table for 3–5 people where every change is signed. Turn the signatures off and anyone with database access can rewrite history unnoticed. Turn them on and every tampered row stands out."),
    rooms.length ? h("div", { class: "your-rooms" }, h("h3", {}, "Your boards"),
      h("div", { class: "row" }, rooms.map((r) => h("button", { class: "quiet", onclick: () => { location.hash = "room=" + encodeURIComponent(r.room); } }, r.title)))) : null,
    h("div", { class: "choices" },
      h("section", { class: "choice" },
        h("h3", {}, "Practice on this computer"),
        h("p", {}, "Open the board in several tabs, one per person. Nothing leaves this browser. Good for rehearsing or a projector demo."),
        h("label", {}, "Board name"), localTitle,
        h("div", { class: "row", style: "margin-top:.8rem" },
          h("button", { onclick: () => { const id = LocalStore.create(localTitle.value.trim(), R.SCHEMA); location.hash = "room=local:" + id; } }, "Open a practice board"))),
      h("section", { class: "choice" },
        h("h3", {}, "Start a classroom board"),
        h("p", {}, "Stores the board in a secret GitHub Gist so each student can join from their own device. Needs a GitHub token with the gist scope."),
        h("label", {}, "Board name"), gistTitle,
        h("label", {}, "GitHub token"), token,
        h("p", { class: "small muted" }, "Use a throwaway GitHub account: the token goes into the join link, so treat anything it can reach as public."),
        h("button", { onclick: (e) => createGist(e.currentTarget) }, "Create board")),
      h("section", { class: "choice" },
        h("h3", {}, "Join a board"),
        h("p", {}, "Your teacher shares a link. Open it, or paste it here."),
        h("label", {}, "Board link"), join,
        h("div", { class: "row", style: "margin-top:.8rem" }, h("button", { onclick: joinLink }, "Join")))),
    msg,
    h("p", { class: "small muted", style: "margin-top:2rem" },
      "Looking for the messaging game with the three armies? ", h("a", { href: "siege.html" }, "Open the Siege of Vharos"), ".")));
}

// ---- join ------------------------------------------------------------------------------------
function renderJoin() {
  const members = S.doc.users.filter(R.verifyMember);
  const mine = members.filter((m) => load(K.me(m.name), null)?.seed);
  const name = h("input", { type: "text", maxlength: R.LIMITS.name, placeholder: "Your first name", autocomplete: "off" });
  const msg = h("p", { class: "small", role: "status" });
  async function go() {
    const n = name.value.trim().replace(/\s+/g, " ");
    if (!n) { msg.className = "small notice bad"; msg.textContent = "Type a name."; return; }
    if (members.some((m) => m.name.toLowerCase() === n.toLowerCase())) { msg.className = "small notice bad"; msg.textContent = `${n} is already taken on this board. Pick another name.`; return; }
    const seed = R.generateSeed();
    const member = R.signMember(seed, n);
    msg.className = "small"; msg.textContent = "Creating your key…";
    try {
      await S.store.update((d) => {
        if (d.users.some((m) => m.name.toLowerCase() === n.toLowerCase())) throw new Error(`${n} was just taken. Pick another name.`);
        if (d.users.length >= R.LIMITS.users) throw new Error("This board is full.");
        d.users.push(member);
      });
    } catch (e) { msg.className = "small notice bad"; msg.textContent = e.message; return; }
    S.me = { name: n, seed, pub: member.pub };
    save(K.me(n), S.me);
    enter();
  }
  name.addEventListener("keydown", (e) => { if (e.key === "Enter") go(); });
  app().replaceChildren(h("div", { class: "welcome" },
    h("p", { class: "eyebrow" }, S.doc.title),
    h("h1", {}, "Who are you?"),
    h("p", { class: "lede" }, "Joining creates a private signing key in this browser. It never leaves this device. Everyone else gets only your public key, which lets them check your signature."),
    mine.length ? h("div", {}, h("p", {}, "Continue as:"), h("div", { class: "row" }, mine.map((m) =>
      h("button", { class: "quiet", onclick: () => { S.me = load(K.me(m.name), null); enter(); } }, seal(m.name, m.pub, 22), " ", m.name)))) : null,
    h("div", { class: "row", style: "max-width:460px;margin-top:1rem;flex-wrap:nowrap" }, name, h("button", { onclick: go }, "Join")),
    msg,
    members.length ? h("p", { class: "small muted", style: "margin-top:1.5rem" }, "Already here: ", members.map((m) => m.name).join(", ")) : null));
  name.focus();
}

// ---- syncing -----------------------------------------------------------------------------------
let pollTimer = null;
function enter() {
  SS.setItem(K.active(), S.me.name);
  if (!S.room.startsWith("local:")) LS.setItem(K.last(), S.me.name);
  renderShell();
  recompute().then(render);
  schedule();
}
function schedule() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, document.hidden ? S.store.pollMs * 3 : S.store.pollMs);
}
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.me) poll(); });

async function poll() {
  if (!S.store || !S.me) return;
  try {
    const doc = await S.store.pull();
    S.sync = { at: now(), error: "" };
    if (doc) { S.doc = doc; await recompute(); render(); }
    await flushOutbox();
  } catch (e) { S.sync.error = e.message; }
  renderBar();
  schedule();
}

async function recompute() {
  const pins = load(K.pins(), {});
  let pinned = false;
  for (const m of S.doc.users) if (!pins[m.name] && R.verifyMember(m)) { pins[m.name] = m.pub; pinned = true; }
  if (pinned) save(K.pins(), pins);
  const { keys, conflicts } = R.directory(S.doc, pins);
  const { records, log } = await R.rebuild(S.doc, { keys, check: S.check });
  // Remember every operation we've seen. If one later vanishes from the store,
  // we still hold the signed copy, and can say so.
  const seen = load(K.seen(), {});
  const present = new Set(log.map((e) => e.op.sig));
  // Only genuinely signed operations count, whether or not the switch is on.
  for (const e of log) if (e.id && !seen[e.op.sig] && R.verifyOp(e.op, keys[e.op.author])) seen[e.op.sig] = e.op;
  const keysSeen = Object.keys(seen);
  if (keysSeen.length > 800) for (const k of keysSeen.slice(0, keysSeen.length - 800)) delete seen[k];
  save(K.seen(), seen);
  const missing = Object.values(seen).filter((op) => !present.has(op.sig));
  S.view = { keys, conflicts, records, log, missing };
}

// Operations are written read-modify-write, so two people saving in the same
// second can overwrite each other. Each of our operations stays in an outbox
// until we see it in the store, and is re-sent if it went missing.
async function flushOutbox() {
  let box = load(K.outbox(), []);
  if (!box.length) return;
  const present = new Set(S.doc.ops.map((o) => o.sig));
  box = box.filter((o) => !present.has(o.sig) && now() - o.ts < 600);
  save(K.outbox(), box);
  if (!box.length) return;
  S.doc = await S.store.update((d) => { for (const o of box) if (!d.ops.some((x) => x.sig === o.sig)) d.ops.push(o); });
  await recompute(); // our own write is not news to the next pull, so show it now
  render();
}

async function submit(fields) {
  if (S.doc.ops.length >= R.LIMITS.ops) throw new Error("This board is full. Start a new one.");
  const op = R.signOp(S.me.seed, { author: S.me.name, ...fields });
  save(K.outbox(), [...load(K.outbox(), []), op]);
  S.busy = true; renderBar();
  try {
    S.doc = await S.store.update((d) => {
      if (d.ops.length >= R.LIMITS.ops) throw new Error("This board is full. Start a new one.");
      d.ops.push(op);
    });
    await recompute();
    render();
  } finally { S.busy = false; renderBar(); }
  return op;
}

// ---- shell -------------------------------------------------------------------------------------
const TABS = [
  ["records", "Records"],
  ["history", "History"],
  ["members", "Members"],
  ["verify", "Check a proof"],
  ["admin", "Database admin"],
  ["learn", "How it works"],
];
function renderShell() {
  app().replaceChildren(h("div", { class: "shell" },
    h("header", { class: "bar", id: "bar" }),
    h("nav", { class: "tabs", id: "tabs", role: "tablist", "aria-label": "Sections" }),
    h("main", { class: "view", id: "view" })));
  renderBar();
  renderTabs();
}
function renderBar() {
  const bar = document.getElementById("bar");
  if (!bar || !S.me) return;
  const toggle = h("input", { type: "checkbox", role: "switch", checked: S.check, onchange: async (e) => { S.check = e.target.checked; await recompute(); render(); renderBar(); } });
  const sync = S.sync.error ? h("span", { class: "sync err", title: S.sync.error }, "Sync error: " + S.sync.error)
    : h("span", { class: "sync" }, (S.room.startsWith("local:") ? "This computer only" : "Shared board") + (S.busy ? ", saving…" : S.sync.at ? ", synced" : ""));
  bar.replaceChildren(
    h("span", { class: "room" }, S.doc.title), sync,
    h("label", { class: "switch", title: "Turn off to see the board as a plain CRUD app that trusts the database" }, toggle, S.check ? "Signatures checked" : "Signatures ignored"),
    h("div", { class: "me" }, seal(S.me.name, S.me.pub, 34),
      h("div", { class: "who" }, h("b", {}, S.me.name), h("span", { class: "small muted" }, "you")),
      h("button", { class: "quiet small", onclick: () => { SS.removeItem(K.active()); LS.removeItem(K.last()); restart(); } }, "Switch")));
}
function renderTabs() {
  const nav = document.getElementById("tabs");
  const v = S.view;
  const alerts = { history: v.log.filter((e) => e.status !== "ok").length + v.missing.length, members: v.conflicts.length };
  nav.replaceChildren(...TABS.map(([id, label]) => h("button", {
    role: "tab", "aria-selected": String(S.tab === id), class: id === "admin" ? "city" : null,
    onclick: () => { S.tab = id; S.editing = null; renderTabs(); render(true); },
  }, label, S.check && alerts[id] ? h("span", { class: "count" }, alerts[id]) : null)));
}

// Tabs with forms re-render only when asked, so a poll never wipes what someone is typing.
function render(force = false) {
  renderTabs();
  const view = document.getElementById("view");
  if (!view) return;
  const typing = view.contains(document.activeElement) && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
  if (!force && (S.editing || (typing && S.tab !== "records") || S.tab === "admin" || S.tab === "verify")) {
    const stale = document.getElementById("stale");
    if (stale) stale.hidden = false;
    return;
  }
  if (S.tab === "records" && !force && view.firstChild) return refreshRecords();
  view.replaceChildren(...({ records: viewRecords, history: viewHistory, members: viewMembers, verify: viewVerify, admin: viewAdmin, learn: viewLearn }[S.tab])());
  if (S.tab === "records") refreshRecords();
}
const staleNote = () => h("p", { id: "stale", class: "notice", hidden: true }, "The board changed. ", h("button", { class: "small quiet", onclick: () => { S.editing = null; render(true); } }, "Show latest"));

// ---- records (the CRUD screen) ---------------------------------------------------------------
function viewRecords() {
  const title = h("input", { type: "text", maxlength: R.LIMITS.title, placeholder: "Title, e.g. Lunch order" });
  const body = h("textarea", { maxlength: R.LIMITS.body, placeholder: "Details, e.g. Two pizzas, one salad", rows: 2 });
  const msg = h("p", { class: "small", role: "status" });
  async function create() {
    if (!title.value.trim()) { msg.className = "small notice bad"; msg.textContent = "Give the record a title."; return; }
    try {
      await submit({ op: "create", rec: R.newRecordId(), title: title.value.trim(), body: body.value.trim() });
      title.value = ""; body.value = ""; msg.textContent = "";
    } catch (e) { msg.className = "small notice bad"; msg.textContent = e.message; }
  }
  return [
    h("div", { class: "panel-intro" }, h("h2", {}, "Records"),
      h("p", {}, "Create a record, edit it, delete it. Each action is signed with your key before it's saved. Only a record's creator can change it, but anyone can try.")),
    h("div", { id: "plain-banner" }),
    h("section", { class: "compose" }, h("h3", {}, "Create"),
      h("label", {}, "Title"), title, h("label", {}, "Details"), body,
      h("div", { class: "row" }, h("button", { onclick: create }, "Create record"),
        h("label", { class: "switch small", style: "margin:0 0 0 auto" },
          h("input", { type: "checkbox", checked: S.showDeleted, onchange: (e) => { S.showDeleted = e.target.checked; refreshRecords(); } }), "Show deleted")),
      msg),
    staleNote(),
    h("div", { id: "records", class: "records" }),
  ];
}
function verdict(status) {
  if (!S.check) return h("span", { class: "state warn" }, "Not checked");
  return h("span", { class: "state " + (status === "ok" ? "ok" : "bad") }, status === "ok" ? "✓ " + R.STATUS_TEXT.ok : "✗ " + R.STATUS_TEXT[status]);
}
function refreshRecords() {
  const box = document.getElementById("records");
  const banner = document.getElementById("plain-banner");
  if (!box) return;
  banner.replaceChildren(...(S.check ? [] : [h("p", { class: "notice" }, "Signatures are ignored. This is an ordinary CRUD app: whatever the database says, you believe. Try the Database admin tab, then switch signatures back on.")]));
  const list = [...S.view.records.values()].filter((r) => S.showDeleted || !r.deleted).sort((a, b) => b.updated - a.updated);
  if (!list.length) return box.replaceChildren(h("p", { class: "empty" }, "No records yet. Create the first one."));
  box.replaceChildren(...list.map(recordCard));
}
function recordCard(r) {
  const key = S.view.keys[r.owner];
  const rejected = r.history.filter((e) => e.status !== "ok");
  if (S.editing === r.rec) return editCard(r);
  return h("article", { class: "record" + (r.deleted ? " deleted" : "") },
    h("div", { class: "meta" }, seal(r.owner, key || "", 26), h("b", {}, r.owner),
      h("span", { class: "muted" }, r.deleted ? ` deleted this ${ago(r.updated)}` : r.updated !== r.created ? ` · edited ${ago(r.updated)}` : ` · ${ago(r.created)}`)),
    h("h3", {}, r.title),
    r.body ? h("p", { class: "body" }, r.body) : null,
    h("div", { class: "row foot" }, verdict("ok"),
      h("span", { class: "small muted" }, plural(r.history.filter((e) => e.status === "ok").length, S.check ? "signed version" : "version")),
      S.check && rejected.length ? h("span", { class: "state bad" }, `${rejected.length} rejected attempt${rejected.length === 1 ? "" : "s"}`) : null,
      r.deleted ? null : h("span", { class: "row", style: "margin-left:auto;gap:.4rem" },
        h("button", { class: "small quiet", onclick: () => { S.editing = r.rec; refreshRecords(); } }, r.owner === S.me.name ? "Edit" : "Try to edit"),
        h("button", { class: "small quiet", onclick: () => del(r) }, r.owner === S.me.name ? "Delete" : "Try to delete"))));
}
function editCard(r) {
  const title = h("input", { type: "text", maxlength: R.LIMITS.title, value: r.title });
  const body = h("textarea", { maxlength: R.LIMITS.body, rows: 2 }, r.body);
  const msg = h("p", { class: "small", role: "status" });
  const notMine = r.owner !== S.me.name;
  async function saveEdit() {
    try {
      const op = await submit({ op: "update", rec: r.rec, prev: r.head, title: title.value.trim(), body: body.value.trim() });
      S.editing = null;
      refreshRecords();
      if (notMine) toast(op, "edit");
    } catch (e) { msg.className = "small notice bad"; msg.textContent = e.message; }
  }
  return h("article", { class: "record editing" },
    h("h3", {}, "Update “", r.title, "”"),
    notMine ? h("p", { class: "notice small" }, `This is ${r.owner}'s record. Your edit will be signed with your key, so everyone can see you tried, and it will be rejected.`) : null,
    h("label", {}, "Title"), title, h("label", {}, "Details"), body,
    h("div", { class: "row", style: "margin-top:.6rem" },
      h("button", { onclick: saveEdit }, "Sign and save"),
      h("button", { class: "quiet", onclick: () => { S.editing = null; render(true); } }, "Cancel")), msg);
}
async function del(r) {
  const notMine = r.owner !== S.me.name;
  if (!confirm(notMine ? `Try to delete ${r.owner}'s record “${r.title}”? Your attempt will be signed by you.` : `Delete “${r.title}”? The deletion is signed by you and kept in the history.`)) return;
  try {
    const op = await submit({ op: "delete", rec: r.rec, prev: r.head, title: r.title });
    if (notMine) toast(op, "delete");
  } catch (e) { alert(e.message); }
}
function toast(op, what) {
  const view = document.getElementById("view");
  const n = h("p", { class: "notice bad", role: "alert" }, `Your ${what} was rejected: only the record's creator can change it. But it's signed by you and is now in the History for everyone to see. You can't deny you tried.`);
  view.prepend(n);
  setTimeout(() => n.remove(), 9000);
}

// ---- history (the signed log) -----------------------------------------------------------------
const VERB = { create: "created", update: "updated", delete: "deleted" };
function viewHistory() {
  const v = S.view;
  const items = [...v.log].reverse();
  return [
    h("div", { class: "panel-intro" }, h("h2", {}, "History"),
      h("p", {}, "Every operation ever saved, newest first. This log is the database: the Records tab is rebuilt from it on your device. Open any entry to see exactly which text was signed.")),
    S.check && v.missing.length ? h("div", { class: "notice bad" },
      h("b", {}, `${v.missing.length} operation${v.missing.length === 1 ? "" : "s"} you saw earlier ${v.missing.length === 1 ? "has" : "have"} been removed from the database.`),
      h("p", { class: "small" }, "Your browser still holds the signed copies, so the removal can be proven:"),
      h("ul", { class: "small" }, v.missing.map((op) => h("li", {}, `${op.author} ${VERB[op.op] || op.op} “${op.title}” at ${clock(op.ts)} `,
        memberOf(op.author) ? h("button", { class: "small quiet", onclick: (e) => copy(JSON.stringify(R.makeProof(op, memberOf(op.author)), null, 2), e.currentTarget) }, "Copy proof") : null)))) : null,
    items.length ? h("ol", { class: "log" }, items.map(logEntry)) : h("p", { class: "empty" }, "Nothing has happened yet."),
  ];
}
function memberOf(name) { return S.doc.users.find((m) => m.name === name && m.pub === S.view.keys[name]) || null; }
function logEntry(e) {
  const op = e.op;
  const bad = S.check && e.status !== "ok";
  const author = typeof op.author === "string" ? op.author : "?";
  const member = memberOf(author);
  return h("li", { class: "entry" + (bad ? " bad" : "") },
    h("div", { class: "row" }, seal(author, S.view.keys[author] || "", 24, bad ? "cracked" : "intact"),
      h("span", {}, h("b", {}, author), ` ${VERB[op.op] || "did something to"} `, h("q", {}, String(op.title || S.view.records.get(op.rec)?.title || "a record"))),
      h("span", { class: "small muted", style: "margin-left:auto" }, Number.isFinite(op.ts) ? clock(op.ts) : "")),
    op.op !== "delete" && op.body ? h("p", { class: "small body" }, String(op.body)) : null,
    h("div", { class: "row" }, verdict(e.status),
      member && e.id && R.verifyOp(op, member.pub) ? h("button", { class: "small quiet", onclick: (ev) => copy(JSON.stringify(R.makeProof(op, member), null, 2), ev.currentTarget) }, "Copy proof") : null),
    h("details", { class: "raw" }, h("summary", {}, "What was signed"),
      h("pre", {}, e.id ? R.signedText(op) : JSON.stringify(op, null, 2)),
      h("p", { class: "small muted" }, "Signature: ", h("span", { class: "hex" }, String(op.sig ?? "none"))),
      e.id ? h("p", { class: "small muted" }, "Operation id (SHA-256 of the signed text): ", h("span", { class: "hex" }, e.id)) : null));
}

// ---- members (key ceremony) ----------------------------------------------------------------------
function viewMembers() {
  const fpBox = h("span", { class: "fp-big" }, "…");
  R.fingerprint(S.me.pub).then((fp) => (fpBox.textContent = fp));
  const list = h("div", { class: "seal-list" });
  const members = S.doc.users.filter(R.verifyMember);
  Promise.all(members.map(async (m) => {
    const pinned = S.view.keys[m.name];
    const conflict = pinned && pinned !== m.pub;
    return h("div", { class: "seal-row" + (conflict ? " conflict" : "") }, seal(m.name, m.pub, 34),
      h("div", {}, h("b", {}, m.name, m.name === S.me.name ? " (you)" : ""), h("div", { class: "fp" }, await R.fingerprint(m.pub))),
      h("span", { class: "state " + (conflict ? "bad" : "ok") }, conflict ? "Key changed! Not trusted" : "Key pinned"));
  })).then((rows) => list.replaceChildren(...rows));
  const share = roomLink(true);
  return [
    h("div", { class: "panel-intro" }, h("h2", {}, "Members"),
      h("p", {}, "A signature only proves something if you know whose key it is. Read your fingerprint out loud; everyone checks it matches what they see next to your name. Your browser remembers (pins) each key the first time it sees it, and warns you if the database later swaps it.")),
    h("div", { class: "my-seal" }, seal(S.me.name, S.me.pub, 64),
      h("div", {}, h("div", { class: "small muted" }, "Your fingerprint"), fpBox, h("div", { class: "small muted" }, "Your private key stays in this browser."))),
    S.view.conflicts.map((c) => h("p", { class: "notice bad" }, `The database now shows a different key for ${c.name} than the one you pinned. Someone may be trying to impersonate them. You're still using the original key.`)),
    list,
    h("h3", { style: "margin-top:1.6rem" }, "Invite others"),
    S.room.startsWith("local:")
      ? h("p", { class: "small muted" }, "This is a practice board: open this page in another tab on this computer and join under another name.")
      : h("div", {}, h("p", { class: "small muted" }, "Share this link with up to 4 classmates. It contains the write key, so keep it inside the class."),
        h("div", { class: "linkbox" }, h("input", { type: "text", readonly: true, value: share }),
          h("button", { onclick: (e) => copy(share, e.currentTarget) }, "Copy"))),
  ];
}

// ---- check a proof --------------------------------------------------------------------------------
function viewVerify() {
  const input = h("textarea", { rows: 8, placeholder: "Paste a proof copied from the History tab", style: "font-family:var(--mono);font-size:.85rem" });
  const out = h("div", { role: "status" });
  async function check() {
    let p;
    try { p = JSON.parse(input.value); } catch { out.replaceChildren(h("p", { class: "notice bad" }, "That isn't valid JSON.")); return; }
    const res = await R.checkProof(p);
    if (!res.ok) return out.replaceChildren(h("p", { class: "notice bad" }, h("b", {}, "✗ Not valid. "), res.why));
    const op = p.op;
    out.replaceChildren(h("div", { class: "evidence" },
      h("p", { class: "state ok" }, "✓ Valid signature"),
      h("p", {}, h("b", {}, op.author), ` ${VERB[op.op]} a record at ${new Date(op.ts * 1000).toLocaleString()}:`),
      h("blockquote", {}, op.title, op.body ? h("div", { class: "small" }, op.body) : null),
      h("p", { class: "small" }, "Signed with the key whose fingerprint is ", h("b", { class: "fp" }, res.fp), ". If that matches the fingerprint ", op.author, " read out loud, only ", op.author, " could have made this signature. They can't deny it."),
      h("p", { class: "small muted" }, "Change a single character in the proof and check again.")));
  }
  return [
    h("div", { class: "panel-intro" }, h("h2", {}, "Check a proof"),
      h("p", {}, "A proof is one signed operation plus the author's public key. Anyone can check it, without access to the database and without trusting whoever hands it over. This is non-repudiation: the author can't later claim they didn't do it.")),
    input, h("div", { class: "row", style: "margin:.7rem 0" }, h("button", { onclick: check }, "Check")), out,
  ];
}

// ---- database admin (the attacker) --------------------------------------------------------------
function viewAdmin() {
  const msg = h("p", { class: "small", role: "status" });
  const ops = S.doc.ops;
  const label = (o, i) => `#${i + 1} ${String(o.author)} ${String(o.op)} “${String(o.title ?? "").slice(0, 30)}”`;
  const pick = () => h("select", {}, ops.map((o, i) => h("option", { value: i }, label(o, i))));
  const rwPick = pick(), rmPick = pick();
  const field = h("select", {}, ["title", "body", "author"].map((f) => h("option", { value: f }, f)));
  const value = h("input", { type: "text", placeholder: "New value" });
  const fAuthor = h("input", { type: "text", placeholder: `Pretend to be… (e.g. ${(S.doc.users.find((m) => m.name !== S.me.name) || S.me).name})` });
  const fTitle = h("input", { type: "text", placeholder: "Title" });
  const fBody = h("input", { type: "text", placeholder: "Details" });
  const raw = h("textarea", { rows: 12, style: "font-family:var(--mono);font-size:.8rem" }, JSON.stringify(S.doc, null, 2));

  async function tamper(fn, done) {
    try {
      S.doc = await S.store.update(fn);
      msg.className = "small notice ok"; msg.textContent = done + " Now look at the Records and History tabs with signatures on, then off.";
      await recompute();
      renderTabs();
      raw.value = JSON.stringify(S.doc, null, 2);
    } catch (e) { msg.className = "small notice bad"; msg.textContent = e.message; }
  }
  const victim = () => (S.doc.users.find((m) => m.name !== S.me.name) || S.me).name;
  const sameAs = (a, b) => a && b && a.sig === b.sig;
  const fake = () => Array.from(crypto.getRandomValues(new Uint8Array(64)), (b) => b.toString(16).padStart(2, "0")).join("");
  const targetRec = () => { const live = [...S.view.records.values()].filter((r) => !r.deleted); return live.length ? live[0] : null; };

  return [
    h("div", { class: "city-head" }, h("h2", {}, "Database admin"),
      h("p", {}, "You have full access to the database but nobody's private key. In a plain CRUD app that's total control. Change anything you like here, then see who notices."),
      h("p", { class: "small" }, "Tip: try each attack with “Signatures ignored”, then switch them back on.")),
    msg,
    ops.length ? h("div", { class: "city-grid" },
      h("section", { class: "toolbox" }, h("h3", {}, "Rewrite an entry"),
        h("p", { class: "small muted" }, "Change what someone wrote, or who wrote it, without re-signing."),
        rwPick, h("div", { class: "row", style: "margin-top:.5rem;flex-wrap:nowrap" }, field, value),
        h("div", { class: "row", style: "margin-top:.6rem" }, h("button", { class: "danger", onclick: () => {
          const target = ops[rwPick.value];
          tamper((d) => { const o = d.ops.find((x) => sameAs(x, target)); if (!o) throw new Error("That entry is gone."); o[field.value] = value.value; }, "Entry rewritten.");
        } }, "Rewrite"))),
      h("section", { class: "toolbox" }, h("h3", {}, "Remove an entry"),
        h("p", { class: "small muted" }, "Make an action disappear, as if it never happened."),
        rmPick,
        h("div", { class: "row", style: "margin-top:.6rem" }, h("button", { class: "danger", onclick: () => {
          const target = ops[rmPick.value];
          tamper((d) => { d.ops = d.ops.filter((x) => !sameAs(x, target)); }, "Entry removed.");
        } }, "Remove"))),
      h("section", { class: "toolbox" }, h("h3", {}, "Insert a fake entry"),
        h("p", { class: "small muted" }, "Create a record in someone else's name. You can't sign it with their key, so the signature is made up."),
        fAuthor, h("div", { style: "margin-top:.5rem" }, fTitle), h("div", { style: "margin-top:.5rem" }, fBody),
        h("div", { class: "row", style: "margin-top:.6rem" },
          h("button", { class: "danger", onclick: () => tamper((d) => { d.ops.push({ v: 1, op: "create", rec: R.newRecordId(), author: fAuthor.value.trim() || victim(), ts: now(), prev: "", title: fTitle.value || "Free pizza for everyone", body: fBody.value, sig: fake() }); }, "Fake record inserted.") }, "Insert record"),
          h("button", { class: "danger", onclick: () => { const r = targetRec(); if (!r) { msg.textContent = "There's no record to delete."; return; } tamper((d) => { d.ops.push({ v: 1, op: "delete", rec: r.rec, author: r.owner, ts: now(), prev: r.head, title: r.title, body: "", sig: fake() }); }, `Fake deletion of “${r.title}” in ${r.owner}'s name inserted.`); } }, "Fake a deletion"))))
    : h("p", { class: "empty" }, "The database is empty. Create a few records first."),
    h("details", { class: "more" }, h("summary", {}, "Edit the raw database"),
      h("p", { class: "small muted" }, "This is the whole shared document, exactly as stored. Edit anything and save."),
      raw, h("div", { class: "row", style: "margin-top:.6rem" },
        h("button", { class: "danger", onclick: () => { let j; try { j = JSON.parse(raw.value); } catch { msg.className = "small notice bad"; msg.textContent = "That isn't valid JSON."; return; } tamper((d) => { for (const k of Object.keys(d)) delete d[k]; Object.assign(d, R.normalize(j)); }, "Database saved."); } }, "Save database"))),
  ];
}

// ---- lesson ----------------------------------------------------------------------------------------
function viewLearn() {
  return [h("div", { class: "lesson" },
    h("h2", { style: "margin-top:0" }, "How it works"),
    h("p", {}, "In an ordinary CRUD app the database is the truth: a row says Alice wrote it, so Alice wrote it. Anyone who can change the database can change the truth, and nobody can prove otherwise."),
    h("p", {}, "Here, nothing is edited in place. Every create, update and delete is a new operation, signed with its author's private key, and appended to a log. Your browser rebuilds the table from that log and checks every signature."),
    h("dl", {},
      h("dt", {}, "Create"), h("dd", {}, "A signed operation with a new record id."),
      h("dt", {}, "Read"), h("dd", {}, "Your device replays the log, keeping only operations whose signatures check out."),
      h("dt", {}, "Update"), h("dd", {}, "A signed operation that names the record's previous version (by its hash). Only the creator's updates count."),
      h("dt", {}, "Delete"), h("dd", {}, "A signed “tombstone”. The record disappears from the table, but the deletion and everything before it stays in the history.")),
    h("h2", {}, "What the signature proves"),
    h("dl", {},
      h("dt", {}, "Integrity"), h("dd", {}, "Change one character and the signature no longer matches."),
      h("dt", {}, "Authenticity"), h("dd", {}, "Only the holder of the private key can produce a valid signature for that key."),
      h("dt", {}, "Non-repudiation"), h("dd", {}, "Because only you could have signed it, you can't later deny it. A proof can be checked by anyone, even outside the app.")),
    h("h2", {}, "What it doesn't prove"),
    h("dl", {},
      h("dt", {}, "Whose key it is"), h("dd", {}, "That's what reading fingerprints out loud on the Members tab is for."),
      h("dt", {}, "That nothing was removed"), h("dd", {}, "A signature can't show that a row is missing. Your browser catches it only because it remembers what it saw before. Real systems use signed receipts or transparency logs."),
      h("dt", {}, "Secrecy"), h("dd", {}, "Anyone with database access can read every record. Signing is not encryption.")))];
}

boot();
