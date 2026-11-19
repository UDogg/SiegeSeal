// Tests the GitHub Gist backend against a mock of the GitHub API.
//   node tests/web/store.test.mjs
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const { GistStore, FILE, LIMITS } = await import(join(root, "docs/js/store.js"));

let checks = 0, failures = 0;
const check = (c, what) => { checks++; if (!c) { failures++; console.error("    FAIL:", what); } };

// ---- a tiny fake GitHub -------------------------------------------------------
const gh = { content: "", version: 0, calls: [], truncate: false, failNext: null };
const etag = () => `W/"v${gh.version}"`;
globalThis.fetch = async (url, opts = {}) => {
  const method = opts.method || "GET";
  const headers = opts.headers || {};
  gh.calls.push({ method, url, auth: headers.Authorization, inm: headers["If-None-Match"] });
  const res = (status, body, extra = {}) => new Response(body === null ? null : JSON.stringify(body), { status, headers: { etag: etag(), ...extra } });
  if (gh.failNext) { const f = gh.failNext; gh.failNext = null; return res(f.status, { message: "nope" }, f.headers || {}); }
  if (url.startsWith("https://raw.example/")) return new Response(gh.content, { status: 200 });
  if (method === "POST" && url === "https://api.github.com/gists") {
    const body = JSON.parse(opts.body);
    gh.content = body.files[FILE].content; gh.version++;
    check(body.public === false, "gist is created secret");
    return res(201, { id: "g1" });
  }
  if (url === "https://api.github.com/gists/g1") {
    if (method === "GET") {
      if (headers["If-None-Match"] === etag()) return new Response(null, { status: 304, headers: { etag: etag() } });
      const f = gh.truncate ? { content: gh.content.slice(0, 10), truncated: true, raw_url: "https://raw.example/x" } : { content: gh.content, truncated: false };
      return res(200, { files: { [FILE]: f } });
    }
    if (method === "PATCH") {
      gh.content = JSON.parse(opts.body).files[FILE].content; gh.version++;
      return res(200, {});
    }
  }
  return res(404, { message: "Not Found" });
};

// ---- tests ------------------------------------------------------------------------
const id = await GistStore.create("tok", "Test room");
check(id === "g1", "create returns id");

const a = new GistStore("g1", "tok");
const b = new GistStore("g1", "tok");
check(a.pollMs < 10000 && new GistStore("g1", "").pollMs > 60000, "polls slowly without a token");

let doc = await a.pull();
check(doc && doc.title === "Test room" && Array.isArray(doc.delivered), "first pull returns the room");
check((await a.pull()) === null, "unchanged room returns null (304)");
check(gh.calls.at(-1).inm && gh.calls.at(-1).auth === "Bearer tok", "conditional request is authenticated");

await b.update((d) => d.delivered.push({ id: "x1" }));
doc = await a.pull();
check(doc && doc.delivered.length === 1, "other client's write is seen");

// Two clients writing one after another both keep their entries (fresh read before each write).
await a.update((d) => d.delivered.push({ id: "x2" }));
await b.update((d) => d.delivered.push({ id: "x3" }));
doc = await a.pull();
check(doc.delivered.map((x) => x.id).join() === "x1,x2,x3", "sequential writes merge");

// Updates from one client are serialised.
await Promise.all([a.update((d) => d.receipts.push({ n: 1 })), a.update((d) => d.receipts.push({ n: 2 }))]);
doc = await b.pull();
check(doc && doc.receipts.length === 2, "concurrent updates from one client both land: " + JSON.stringify(doc && doc.receipts));

// Our own write is not news: the next pull refetches once but reports no change.
await a.update((d) => d.delivered.push({ id: "x4" }));
check((await a.pull()) === null, "own write not reported as a change");

// A full re-download whose text is identical (etag changed, content didn't) is not a change.
gh.version++;
check((await a.pull()) === null, "identical content after etag change is not a change");

// Truncated large files are fetched from raw_url.
await b.update((d) => d.delivered.push({ id: "x5" }));
gh.truncate = true; gh.version++;
doc = await a.pull();
check(doc && doc.delivered.length === 5, "truncated content is fetched in full");
gh.truncate = false;

// Rooms are trimmed to their newest entries on every write, and written compactly.
await a.update((d) => { for (let i = 0; i < LIMITS.delivered + 50; i++) d.delivered.push({ id: "bulk" + i }); });
const stored = JSON.parse(gh.content);
check(stored.delivered.length === LIMITS.delivered, "delivered trimmed to limit");
check(stored.delivered.at(-1).id === "bulk" + (LIMITS.delivered + 49), "newest entries kept");
check(!gh.content.includes("\n"), "written without pretty-printing");

// Garbage in the store is normalised, not trusted.
gh.content = JSON.stringify({ delivered: "lol", seals: [null, 3, { name: "A" }] }); gh.version++;
doc = await a.pull();
check(Array.isArray(doc.delivered) && doc.delivered.length === 0 && doc.seals.length === 1, "malformed store normalised");

// Errors are explained.
gh.failNext = { status: 403, headers: { "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 60) } };
try { await a.pull(); check(false, "rate limit should throw"); } catch (e) { check(/rate limit/i.test(e.message), "rate limit message: " + e.message); }
gh.failNext = { status: 401 };
try { await a.pull(); check(false, "401 should throw"); } catch (e) { check(/token/i.test(e.message), "bad token message"); }
try { await new GistStore("g1", "").update(() => {}); check(false, "write without token should throw"); } catch (e) { check(/write key/i.test(e.message), "no-token write message"); }
try { await new GistStore("nope", "tok").pull(); check(false, "404 should throw"); } catch (e) { check(/not found/i.test(e.message), "404 message"); }

console.log(`  ${failures ? "FAIL" : "ok  "}  gist store\n\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
