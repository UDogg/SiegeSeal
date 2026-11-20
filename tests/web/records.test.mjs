// Tests for SiegeSeal Records (docs/js/records.js): signed CRUD and every
// attack the Database admin tab offers.
//
//   node tests/web/records.test.mjs

import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
globalThis.nacl = createRequire(import.meta.url)(join(root, "docs/js/vendor/nacl-fast.min.js"));
const R = await import(join(root, "docs/js/records.js"));

let checks = 0, failures = 0;
function check(cond, what) {
  checks++;
  if (!cond) { failures++; console.error("    FAIL:", what); }
}
const clone = (x) => JSON.parse(JSON.stringify(x));

// Three students on one board.
const seeds = { Ana: R.generateSeed(), Ben: R.generateSeed(), Cleo: R.generateSeed() };
const doc = R.newBoard("Test");
for (const [n, s] of Object.entries(seeds)) doc.users.push(R.signMember(s, n));
const dir = () => R.directory(doc).keys;
const view = (d = doc, opts = {}) => R.rebuild(d, { keys: R.directory(d).keys, ...opts });
const status = async (d, i) => (await view(d)).log[i].status;

// ---- create / read / update / delete --------------------------------------------
const rec = R.newRecordId();
doc.ops.push(R.signOp(seeds.Ana, { op: "create", rec, author: "Ana", title: "Lunch", body: "Pizza" }));
let v = await view();
check(v.records.get(rec)?.title === "Lunch" && v.log[0].status === "ok", "create is applied");

const head1 = v.records.get(rec).head;
check(head1 === await R.opId(doc.ops[0]), "head is the create's id");
doc.ops.push(R.signOp(seeds.Ana, { op: "update", rec, author: "Ana", prev: head1, title: "Lunch", body: "Salad" }));
v = await view();
check(v.records.get(rec).body === "Salad" && v.records.get(rec).history.length === 2, "owner's update is applied");

// Ben signs a genuine update to Ana's record: rejected, but attributable.
doc.ops.push(R.signOp(seeds.Ben, { op: "update", rec, author: "Ben", prev: v.records.get(rec).head, title: "Lunch", body: "Burgers" }));
v = await view();
check(v.log[2].status === "not-owner" && v.records.get(rec).body === "Salad", "non-owner update rejected");
check(v.records.get(rec).history.includes(v.log[2]), "rejected attempt shown in the record's history");

// Replaying Ana's first update (stale prev) is rejected.
doc.ops.push(clone(doc.ops[1]));
check(await status(doc, 3) === "stale", "replayed update rejected as stale");

const rec2 = R.newRecordId();
doc.ops.push(R.signOp(seeds.Cleo, { op: "create", rec: rec2, author: "Cleo", title: "Trip", body: "Museum" }));
v = await view();
doc.ops.push(R.signOp(seeds.Cleo, { op: "delete", rec: rec2, author: "Cleo", prev: v.records.get(rec2).head }));
v = await view();
check(v.records.get(rec2).deleted === true, "owner's delete is applied");
const n = doc.ops.length;
doc.ops.push(R.signOp(seeds.Cleo, { op: "update", rec: rec2, author: "Cleo", prev: v.records.get(rec2).head, title: "Back", body: "" }));
check(await status(doc, n) === "no-record", "update after delete rejected");
doc.ops.pop();

// Duplicate create of an existing id.
doc.ops.push(R.signOp(seeds.Ben, { op: "create", rec, author: "Ben", title: "Mine now", body: "" }));
check(await status(doc, doc.ops.length - 1) === "duplicate", "duplicate create rejected");
doc.ops.pop();

// ---- the Database admin's attacks ---------------------------------------------------
{ // rewrite text
  const d = clone(doc); d.ops = d.ops.slice(0, 2); d.ops[1].body = "Free pizza";
  const t = await view(d);
  check(t.log[1].status === "bad-sig", "rewritten text breaks the signature");
  check(t.records.get(rec).body === "Pizza", "table falls back to the last genuine version");
  const plain = await view(d, { check: false });
  check(plain.records.get(rec).body === "Free pizza", "with signatures ignored, the rewrite is believed");
}
{ // change author
  const d = clone(doc); d.ops[0].author = "Ben";
  check(await status(d, 0) === "bad-sig", "changed author breaks the signature");
}
{ // forged entry with a made-up signature
  const d = clone(doc);
  d.ops.push({ v: 1, op: "create", rec: R.newRecordId(), author: "Ana", ts: 1, prev: "", title: "Fake", body: "", sig: "ab".repeat(64) });
  check(await status(d, d.ops.length - 1) === "bad-sig", "forged signature rejected");
  d.ops.at(-1).author = "Zed";
  check(await status(d, d.ops.length - 1) === "unknown", "unknown author rejected");
}
{ // removing an entry in the middle of a record's chain
  const d = clone(doc); d.ops.splice(0, 1);
  const t = await view(d);
  check(t.log[0].status === "no-record", "removing a create orphans its later versions");
}
{ // garbage in the store
  const d = R.normalize({ users: "x", ops: [1, null, { v: 1 }, []] });
  check(d.ops.length === 1 && d.users.length === 0, "malformed store normalised");
  check((await R.rebuild(d)).log[0].status === "malformed", "malformed op flagged");
}
{ // key substitution: the store swaps Ana's key, the pin keeps the original
  const evil = R.generateSeed();
  const d = clone(doc); d.users[0] = R.signMember(evil, "Ana");
  const pinned = R.directory(d, { Ana: dir().Ana });
  check(pinned.conflicts.length === 1 && pinned.keys.Ana === dir().Ana, "key change detected against the pin");
  d.ops.push(R.signOp(evil, { op: "create", rec: R.newRecordId(), author: "Ana", title: "Impostor", body: "" }));
  const t = await R.rebuild(d, { keys: pinned.keys });
  check(t.log.at(-1).status === "bad-sig", "impostor's op fails under the pinned key");
}
{ // member registration must be self-signed
  const m = R.signMember(seeds.Ana, "Ana"); m.name = "Ben";
  check(!R.verifyMember(m), "renamed registration fails");
}

// ---- proofs ------------------------------------------------------------------------
{
  const proof = R.makeProof(doc.ops[2], doc.users[1]);
  const ok = await R.checkProof(clone(proof));
  check(ok.ok && ok.id === await R.opId(doc.ops[2]) && /^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(ok.fp), "proof of Ben's attempt verifies");
  const t1 = clone(proof); t1.op.body = "Pizza";
  check(!(await R.checkProof(t1)).ok, "tampered proof fails");
  const t2 = clone(proof); t2.member = doc.users[0];
  check(!(await R.checkProof(t2)).ok, "proof with someone else's key fails");
  check(!(await R.checkProof({})).ok, "garbage proof fails");
}

// What is signed covers every field.
{
  const op = doc.ops[0];
  const text = R.signedText(op);
  for (const f of ["op", "rec", "author", "ts", "title", "body"]) check(text.includes(JSON.stringify(op[f])), `signed text covers ${f}`);
}

console.log(`  ${failures ? "FAIL" : "ok  "}  records\n\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
