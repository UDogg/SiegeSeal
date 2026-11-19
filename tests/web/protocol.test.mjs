// Tests for the JavaScript port (docs/js/protocol.js), including interop
// with the C++ implementation.
//
//   node tests/web/protocol.test.mjs [path/to/siegeseal]
//
// If the C++ CLI path is given (or found at build/siegeseal), letters signed
// in JavaScript are verified by the C++ code, and their digests compared.

import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
globalThis.nacl = createRequire(import.meta.url)(join(root, "docs/js/vendor/nacl-fast.min.js"));
const P = await import(join(root, "docs/js/protocol.js"));

let checks = 0, failures = 0;
const tests = [];
const test = (name, fn) => tests.push([name, fn]);
function check(cond, what) {
  checks++;
  if (!cond) { failures++; console.error("    FAIL:", what); }
}

const T0 = 1_800_000_000;
const policy = { freshness: 600, skew: 120 };
function trio() {
  const ids = {};
  for (const n of ["A", "B", "C"]) {
    const seed = P.generateSeed();
    ids[n] = { seed, pub: P.publicKeyFromSeed(seed) };
  }
  const keyOf = (n) => ids[n]?.pub || null;
  const fresh = () => ({ lastSeq: {}, nonces: {} });
  return { ids, keyOf, fresh };
}
const letter = (t, from, to, extra = {}) =>
  P.signEnvelope(t.ids[from].seed, { from, to, seq: 1, ts: T0, prev: P.ZERO_PREV, body: "attack at dawn", ...extra });

test("RFC 8032 test vector 1", () => {
  const seed = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";
  check(P.publicKeyFromSeed(seed) === "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a", "public key");
  const kp = nacl.sign.keyPair.fromSeed(P.fromHex(seed, 32));
  check(P.toHex(nacl.sign.detached(new Uint8Array(0), kp.secretKey)) ===
    "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155" +
    "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b", "signature");
});

test("fingerprint format matches C++", async () => {
  const fp = await P.fingerprint("d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
  check(/^[0-9A-F]{4}(-[0-9A-F]{4}){3}$/.test(fp), "shape " + fp);
});

test("honest letter is accepted", () => {
  const t = trio();
  const r = P.receive({ me: "B", env: letter(t, "A", "B"), keyOf: t.keyOf, now: T0 + 5, policy, state: t.fresh() });
  check(r.status === P.Status.ACCEPTED, r.status);
});

test("every field is covered by the seal", () => {
  const t = trio();
  const e = letter(t, "A", "B");
  const edits = {
    body: "attack at dusk", from: "C", to: "C", seq: 2, ts: T0 + 1,
    nonce: "f".repeat(32), prev: "1".repeat(64),
  };
  for (const [k, v] of Object.entries(edits)) {
    check(!P.verifyEnvelope({ ...e, [k]: v }, t.keyOf("A")), "edit to " + k + " went unnoticed");
  }
});

test("receiver verdicts mirror the C++ Party", () => {
  const t = trio();
  const st = t.fresh();
  const rx = (env, now = T0) => P.receive({ me: "B", env, keyOf: t.keyOf, now, policy, state: st }).status;

  check(rx({ v: 1, from: "A" }) === P.Status.MALFORMED, "malformed");
  check(rx(P.signEnvelope(P.generateSeed(), { from: "Z", to: "B", seq: 1, ts: T0, prev: P.ZERO_PREV, body: "x" })) === P.Status.UNKNOWN, "unknown");
  check(rx({ ...letter(t, "A", "B"), body: "changed" }) === P.Status.BAD_SIG, "tamper");
  check(rx(P.signEnvelope(t.ids.C.seed, { from: "A", to: "B", seq: 1, ts: T0, prev: P.ZERO_PREV, body: "forged" })) === P.Status.BAD_SIG, "forgery");
  check(rx(letter(t, "A", "C")) === P.Status.MISROUTED, "misrouted");
  check(rx(letter(t, "A", "B", { ts: T0 - 3600 })) === P.Status.EXPIRED, "too old");
  check(rx(letter(t, "A", "B", { ts: T0 + 3600 })) === P.Status.EXPIRED, "future");

  const first = letter(t, "A", "B");
  check(rx(first) === P.Status.ACCEPTED, "first");
  check(rx(first) === P.Status.REPLAY, "replay");
  check(rx(letter(t, "A", "B", { seq: 1 })) === P.Status.OUT_OF_ORDER, "old seq, new nonce");
  check(rx(letter(t, "A", "B", { seq: 4 })) === P.Status.GAP, "gap");
});

test("receipts", async () => {
  const t = trio();
  const e = letter(t, "A", "B");
  const r = P.signReceipt(t.ids.B.seed, { by: "B", for: "A", env: await P.envelopeDigest(e), at: T0 });
  check(P.verifyReceipt(r, t.keyOf("B")), "genuine receipt");
  const fake = P.signReceipt(P.generateSeed(), { by: "B", for: "A", env: r.env, at: T0 });
  check(!P.verifyReceipt(fake, t.keyOf("B")), "forged receipt");
  check(!P.verifyEnvelope({ ...e, from: "B", sig: r.sig }, t.keyOf("B")), "domain separation");
});

test("treaty: all must sign, order and unicode safe", () => {
  const t = trio();
  const tr = { terms: "Spoils shared equally — même pour Cyrène", parties: ["C", "A", "B"], sigs: {} };
  tr.sigs.A = P.signTreaty(t.ids.A.seed, tr);
  tr.sigs.B = P.signTreaty(t.ids.B.seed, tr);
  let r = P.checkTreaty(tr, t.keyOf);
  check(!r.binding && r.missing.join() === "C", "missing C");
  tr.sigs.C = P.signTreaty(t.ids.C.seed, { ...tr, parties: ["B", "C", "A"] });
  check(P.checkTreaty(tr, t.keyOf).binding, "binding regardless of party order");
  r = P.checkTreaty({ ...tr, terms: tr.terms + "!" }, t.keyOf);
  check(!r.binding && r.broken.length === 3, "doctored terms break all seals");
});

test("equivocation", async () => {
  const t = trio();
  const first = letter(t, "C", "A", { body: "warmup" });
  const head = await P.envelopeDigest(first);
  const x = letter(t, "C", "A", { seq: 2, prev: head, body: "I attack" });
  const y = letter(t, "C", "B", { seq: 1, prev: head, body: "I hold back" });
  const forks = await P.findEquivocations([first, x, y, x], t.keyOf);
  check(forks.length === 1 && forks[0].sender === "C", "one fork by C");
  const fake = { ...x, body: "framed" };
  check((await P.findEquivocations([first, x, fake], t.keyOf)).length === 0, "forgeries can't frame");
});

test("verification cache never vouches for changed bytes", () => {
  const t = trio();
  const e = letter(t, "A", "B");
  check(P.verifyEnvelope(e, t.keyOf("A")), "genuine first time");
  const before = P.stats.verifications;
  check(P.verifyEnvelope(e, t.keyOf("A")), "genuine again");
  check(P.stats.verifications === before, "second check served from cache");
  // Same signature, different text: must be a fresh check, and must fail.
  check(!P.verifyEnvelope({ ...e, body: "attack at dusk" }, t.keyOf("A")), "tampered text with genuine sig rejected");
  check(P.stats.verifications === before + 1, "tampered letter was actually verified");
  // Same bytes, someone else's key: also a fresh check, and a failure.
  check(!P.verifyEnvelope(e, t.keyOf("C")), "wrong key rejected despite cached success");
});

test("fork scan only verifies shared positions", async () => {
  const t = trio();
  const pool = [];
  for (let i = 0; i < 200; i++) pool.push(letter(t, "A", "B", { seq: i + 1, prev: P.toHex(P.randomBytes(32)) }));
  const before = P.stats.verifications + P.stats.cacheHits;
  check((await P.findEquivocations(pool, t.keyOf)).length === 0, "no forks in honest pool");
  check(P.stats.verifications + P.stats.cacheHits === before, "honest pool needed no signature checks");
  const head = "cd".repeat(32);
  pool.push(letter(t, "C", "A", { prev: head, body: "attack" }), letter(t, "C", "B", { prev: head, body: "hold" }));
  check((await P.findEquivocations(pool, t.keyOf)).length === 1, "hidden fork found");
});

test("digest cache returns the same digest", async () => {
  const t = trio();
  const e = letter(t, "A", "B");
  const d1 = await P.envelopeDigest(e), d2 = await P.envelopeDigest({ ...e });
  check(d1 === d2 && /^[0-9a-f]{64}$/.test(d1), "stable digest");
  check(d1 !== (await P.envelopeDigest({ ...e, body: "x" })), "changed letter, changed digest");
});

// ---- interop with the C++ CLI ---------------------------------------------
const cli = process.argv[2] || join(root, "build/siegeseal");
if (existsSync(cli)) {
  test("C++ verifies letters sealed in JavaScript", async () => {
    const dir = mkdtempSync(join(tmpdir(), "siegeseal-"));
    const seed = P.generateSeed();
    const pub = P.publicKeyFromSeed(seed);
    writeFileSync(join(dir, "Aurelia.pub"), `siegeseal-public Aurelia ${pub}\n`);
    for (const body of ["Strike the north gate at DAWN.", "भोर में हमला 🏰 — l'aube", ""]) {
      const e = P.signEnvelope(seed, { from: "Aurelia", to: "Borealis", seq: 7, ts: T0, prev: "ab".repeat(32), body });
      writeFileSync(join(dir, "ok.hex"), P.toHex(P.envelopeWire(e)));
      const out = execFileSync(cli, ["verify-envelope", join(dir, "Aurelia.pub"), join(dir, "ok.hex")]).toString();
      check(out.includes("GENUINE"), "C++ accepts JS letter: " + JSON.stringify(body));
      check(out.includes("digest:  " + (await P.envelopeDigest(e))), "same digest in both languages");

      writeFileSync(join(dir, "bad.hex"), P.toHex(P.envelopeWire({ ...e, body: body + "." })));
      let rejected = false;
      try { execFileSync(cli, ["verify-envelope", join(dir, "Aurelia.pub"), join(dir, "bad.hex")]); } catch (err) { rejected = err.status === 1; }
      check(rejected, "C++ rejects altered JS letter");
    }
  });
} else {
  console.log(`  (skipping C++ interop: ${cli} not found)`);
}

for (const [name, fn] of tests) {
  const before = failures;
  await fn();
  console.log((failures === before ? "  ok    " : "  FAIL  ") + name);
}
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
