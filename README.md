# SiegeSeal

[![CI](https://github.com/UDogg/SiegeSeal/actions/workflows/ci.yml/badge.svg)](https://github.com/UDogg/SiegeSeal/actions/workflows/ci.yml) · [Classroom app](https://udogg.github.io/SiegeSeal/) · [Releases](https://github.com/UDogg/SiegeSeal/releases)

**Non-repudiable messaging for parties who don't trust the channel — or each other.**

SiegeSeal is a C++17 library, CLI and simulation, plus a classroom messaging web app that speaks the same protocol, built around a variant of the Byzantine Generals problem:

> Three armies from three nations — **Aurelia**, **Borealis** and **Cyrene** — plan a joint siege of the city of **Vharos**. Every courier between them must ride past the city walls, so Vharos can read, rewrite, forge, replay, reroute, delay or kill any message. And the allies don't trust each other either: any of them might later deny an order, claim a message never arrived, or tell two allies two different stories.

Plain messages lose to this adversary immediately (one altered word, *DAWN → DUSK*, and the alliance destroys itself). SiegeSeal makes every one of those attacks either impossible or provably detectable, and leaves behind evidence that any third party can verify.

```
  [2] Tampering: change one word
      Vharos ▸ rewrites DAWN → DUSK in the letter to Cyrene.
      Cyrene ✘ BAD SIGNATURE — signature does not match Aurelia's seal — altered in transit or forged

  [14] Two faces — catching equivocation
      ✘ EQUIVOCATION by Cyrene — two signed letters claim the same place in her chain:
          to Aurelia: "Cyrene attacks the WEST wall at dawn."
          to Borealis: "Cyrene holds back; let Aurelia bleed first."
```

## Two implementations, one protocol

| | What it is | Where |
|---|---|---|
| **C++ library + tools** | The reference implementation: `siege_sim` tells the story in five acts, `siegeseal` signs and verifies real files | `include/`, `src/`, `apps/` |
| **SiegeSeal Classroom** | A static web app for teaching. Students send sealed letters while one student plays the city and attacks them | `docs/` (served by GitHub Pages) |

They are byte-for-byte compatible: a letter sealed in the browser verifies with `siegeseal verify-envelope`, and the test suite checks this on every push.

## Install a release

Every release ships these files, all listed in `SHA256SUMS`:

| File | What it is | Runs on |
|---|---|---|
| `siegeseal-1.0.0-linux-x86_64-static` | The `siegeseal` CLI as one self-contained executable | Any x86-64 Linux |
| `siegeseal-1.0.0-linux-x86_64-static.tar.gz` | All three programs, man pages, docs and the web app | Any x86-64 Linux |
| `siegeseal-1.0.0-linux-x86_64.tar.gz` | The same tools, plus the library, headers and CMake package for building against SiegeSeal | glibc 2.38 or newer (Ubuntu 24.04, Debian 13, Fedora 39) |
| `siegeseal-1.0.0-source.tar.gz` | The source tree | |

```bash
sha256sum -c SHA256SUMS --ignore-missing
tar -xzf siegeseal-1.0.0-linux-x86_64-static.tar.gz
cd siegeseal-1.0.0-linux-x86_64-static
./bin/siegeseal --version
./bin/siege_sim
man ./share/man/man1/siegeseal.1
```

To install system-wide, copy `bin/` and `share/` into `/usr/local`. To build against the library, unpack the glibc tarball and point CMake at it:

```cmake
find_package(SiegeSeal 1.0 REQUIRED)          # cmake -DCMAKE_PREFIX_PATH=/path/to/siegeseal-1.0.0-linux-x86_64
target_link_libraries(app PRIVATE SiegeSeal::siegeseal)
```

The static build is a static PIE: no dynamic loader and no shared libraries, linked with musl and OpenSSL 3.0.17. The glibc build links OpenSSL and the C++ runtime statically, and needs only the system C library. Both are compiled with PIE, full RELRO, a non-executable stack and stack protection. The glibc build also has `_FORTIFY_SOURCE=3` and CET; musl doesn't implement fortify, and the static build's startup code lacks CET markings.

## Classroom web app

Plain HTML and JavaScript with no build step, served from `docs/` by GitHub Pages. Two pages share the same signing code and storage:

| Page | For | What students do |
|---|---|---|
| **SiegeSeal Records** (`index.html`, the start page) | CRUD and non-repudiation, 3–5 students per board | Create, read, update and delete records; every operation is signed. A *Database admin* tab rewrites, removes and forges entries; a switch shows the same board with signatures ignored; any entry exports as a proof anyone can check. |
| **Siege of Vharos** (`siege.html`) | Going further: replay, ordering, receipts, equivocation | Send sealed letters between three armies while one student plays the city and attacks them. |

The shared state is a single JSON document in a secret GitHub Gist (or browser storage for a one-computer practice run). The apps treat that store as hostile: anyone with the link can rewrite it, and every check happens on the reader's own device. Lesson plans and classroom limits are in [TEACHING.md](TEACHING.md).

**Live:** https://udogg.github.io/SiegeSeal/

**Deploy:** in the repo's *Settings → Pages → Build and deployment*, set *Source* to **GitHub Actions** (one time). After that, every push to `main` runs the full test suite and, if it passes, publishes `docs/` to Pages ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). A fork works the same way.

**Try it locally:** `python3 -m http.server -d docs 8000` and open http://localhost:8000. Choose *Practice on this computer* and open several tabs, one per student.

In the Siege of Vharos, students can:
- **Letters:** send sealed letters, see each one verified (or its seal cracked) and get signed receipts back.
- **Check seals switch:** turn verification off to see that tampered letters look exactly like real ones.
- **Seal ceremony:** compare key fingerprints in person; a seal that changes later raises an alarm.
- **Vharos tab:** stop couriers, rewrite, forge, replay, reroute, delay, burn and fake receipts, post fake seals, doctor treaties.
- **Tribunal:** export a letter or receipt as evidence that anyone can check; catch an ally telling two stories.
- **Treaty:** a joint plan that binds only when everyone seals the identical words.

Storage backends: GitHub Gist (classroom) or browser storage (one computer, many tabs); the Siege also accepts any JSON URL that answers GET and PUT.

## Build the C++ code

Requires a C++17 compiler, CMake ≥ 3.18 and OpenSSL ≥ 3.0.

```bash
cmake -S . -B build
cmake --build build -j
ctest --test-dir build      # unit tests, CLI round trip, simulation, benchmark, web tests (if node is installed)
./build/siege_sim           # the full story
cmake --install build --prefix ~/.local
```

| Option | Default | Effect |
|---|---|---|
| `SIEGESEAL_HARDEN` | `ON` | Stack protector, `_FORTIFY_SOURCE=3`, stack-clash and CET protection, full RELRO, non-executable stack |
| `SIEGESEAL_PORTABLE` | `OFF` | Link OpenSSL and the C++ runtime statically |
| `SIEGESEAL_FULLY_STATIC` | `OFF` | Link everything, libc included, into a static PIE (use with a musl toolchain) |
| `SIEGESEAL_BUILD_TESTS` | `ON` | Build and register the tests |

### Building a release

```bash
scripts/release.sh          # writes dist/
```

To publish one, bump `VERSION` in `CMakeLists.txt`, add a `CHANGELOG.md` entry, and push a matching tag (`git tag v1.0.0 && git push origin v1.0.0`). [`.github/workflows/release.yml`](.github/workflows/release.yml) runs the script and attaches everything in `dist/` to a GitHub release, with the changelog entry as its notes.

The script builds both variants, runs every test on each, packages them with CPack, unpacks the tarballs and re-runs the checks on the packaged binaries, and writes `SHA256SUMS`. For the static variant it downloads OpenSSL 3.0.17, checks it against a pinned SHA-256, and builds it for musl with [Zig](https://ziglang.org) (`pip install ziglang`). Set `SIEGESEAL_SKIP_STATIC=1` to build only the glibc variant.

## Threat model → defence

| Attack by the city (man in the middle) | Defence | Result |
|---|---|---|
| Change words in a letter | Ed25519 signature over a canonical encoding of every field | `BAD SIGNATURE` |
| Write a letter in an ally's name | Only the ally's private key can sign; keys pinned at the seal ceremony | `BAD SIGNATURE` |
| A "deserter" with their own valid signature | Only pre-registered seals are trusted | `UNKNOWN SENDER` |
| Re-deliver an old genuine order | 128-bit random nonce + per-pair monotonic sequence number | `REPLAY` / `OUT OF ORDER` |
| Deliver a letter to the wrong ally | Recipient name is inside the signed bytes | `MISROUTED` |
| Kill a courier | Sequence gap at the receiver; missing signed receipt at the sender | `ACCEPTED (GAP)` + unacknowledged list |
| Hold a letter until it is useless | Signed timestamp + freshness window | `EXPIRED` |
| Fake a delivery receipt | Receipts are signed by the receiver | rejected |
| Send garbage / truncated data | Strict length-prefixed parser, no trailing bytes | `MALFORMED` |

| Dishonesty by an ally | Defence | Evidence |
|---|---|---|
| "I never sent that" | Non-repudiation of **origin**: the signature verifies only under the sender's key | the signed envelope |
| "I never received that" | Non-repudiation of **receipt**: receiver signs the envelope's digest | the signed receipt |
| Presenting a doctored "order" as an excuse | Anyone with the public keys re-verifies it | fails verification |
| Telling two allies two different stories | Each envelope hash-links to the sender's previous one; two valid envelopes with the same predecessor are a signed fork | `find_equivocations()` |
| Signing a treaty, then disputing its terms | Treaty is binding only when every named party has signed identical bytes | `verify_treaty()` |

## Design

```
include/siegeseal/
  crypto.hpp     Ed25519, SHA-256, CSPRNG, constant-time compare (RAII over OpenSSL 3 EVP)
  wire.hpp       canonical big-endian, length-prefixed encoding — one byte string per message
  protocol.hpp   Envelope, Receipt, Treaty, KeyDirectory, stateless third-party verification
  party.hpp      a commander: seal, trusted keys, replay/order/gap state, evidence archive
  version.hpp.in version stamp, generated at configure time
apps/
  siege_sim.cpp      the five-act story
  siegeseal_cli.cpp  keygen / sign / verify / verify-envelope
  siegeseal_bench.cpp  throughput of the hot paths
tests/
  test_main.cpp      C++ tests
  cli_roundtrip.sh   end-to-end CLI check (keys, signing, tampering)
  web/               JavaScript protocol tests (incl. C++ interop) and storage tests
scripts/
  release.sh         build, test, package and checksum both release variants
  build-openssl-musl.sh  pinned, checksummed OpenSSL build for the static variant
cmake/               CMake package config (find_package(SiegeSeal))
man/                 siegeseal(1), siege_sim(1)
docs/                the classroom web app (GitHub Pages root)
  js/protocol.js     JavaScript port of the protocol
  js/records.js      signed CRUD log: operations, rebuild, proofs (SiegeSeal Records)
  js/crud.js         the SiegeSeal Records interface (index.html)
  js/store.js        Gist / browser / JSON-URL storage
  js/seal.js         draws a wax seal unique to each public key
  js/app.js          the Siege of Vharos interface (siege.html)
  js/vendor/         TweetNaCl (public domain) for Ed25519
```

**Envelope** — what gets signed:

```
"SIEGESEAL/ENVELOPE/v1" | version | sender | recipient | seq | timestamp | nonce[16] | prev[32] | payload
```

Choices worth noting:

- **Signature checked first.** Nothing in an unauthenticated message (sequence numbers, timestamps, recipient) is trusted until the signature verifies.
- **Domain separation.** Envelopes, receipts, treaties and files each sign under a different tag, so a signature for one can never be passed off as another (there's a test for this).
- **Canonical encoding** instead of JSON — no whitespace or field-order ambiguity about what was signed.
- **Hash-chained history.** `prev` links every envelope to the sender's previous one across *all* recipients. A sender who wants to say different things to different allies must fork their own chain, and the fork is signed proof against them.
- **Ed25519** is deterministic (no nonce-reuse disasters like ECDSA), fast, and its 32-byte keys are easy to read aloud as fingerprints.

## CLI

```bash
siegeseal keygen aurelia                 # aurelia.seal (mode 600) + aurelia.pub
siegeseal fingerprint aurelia.pub        # aurelia  D40D-7D26-E02F-977D
siegeseal sign aurelia.seal orders.txt   # -> orders.txt.sig
siegeseal verify aurelia.pub orders.txt  # GENUINE … (exit 0) / REJECTED … (exit 1)
siegeseal verify-envelope Aurelia.pub letter.hex   # check a letter exported from the web app
siegeseal --version
```

Exit status: 0 genuine, 1 signature does not match, 2 usage or file error. Full reference: `man siegeseal`.

## Tests

```bash
./build/siegeseal_tests                          # C++
node tests/web/protocol.test.mjs build/siegeseal # JS protocol + C++ interop
node tests/web/store.test.mjs                    # Gist backend against a mock GitHub API
node tests/web/records.test.mjs                  # signed CRUD: every Database admin attack
```

GitHub Actions runs all of them on every push.

## Performance

`./build/siegeseal_bench [messages]` times each hot path end to end. Measured on one core of a cloud VM, 20,000 messages:

| Path | Before tuning | After | What changed |
|---|---|---|---|
| Match a receipt to a sent letter | 13,860 µs | 142 µs | Sent letters indexed by digest (was a rehash of every sent letter, O(n) per receipt) |
| Scan an archive for equivocation | 143 µs / letter | 0.35 µs / letter | Group by chain position first; only shared positions are signature-checked |
| Receive a letter (verify, checks, signed receipt) | 198 µs | 187 µs | Encode and hash once; public keys parsed once |
| Seal a letter | 56 µs | 56 µs | Already bound by Ed25519 signing |

What remains on every path is the Ed25519 operation itself, which no shortcut may skip.

The web app follows the same rules. It re-renders only when the room actually changes. It remembers signature results keyed on the key, the signature *and the exact signed bytes*, so tampered text under a genuine signature is always checked afresh (there is a test for this). It trims the shared room to its newest entries. An idle tab now does no DOM work and no signature checks. Before, the Tribunal tab re-verified about 29 signatures a second.

## Limits — what SiegeSeal does *not* do

- **Confidentiality.** Vharos can still *read* the letters. Secrecy would layer on top: X25519 key agreement between each pair, HKDF, then AES-256-GCM or ChaCha20-Poly1305 over the payload, with the ciphertext inside the signed envelope (sign-then-encrypt with the recipient bound in, as here, avoids surreptitious forwarding).
- **Key distribution.** Everything rests on the seal ceremony: if the city could substitute a public key *before* the campaign, it could impersonate anyone. That is why fingerprints are compared in person. A real deployment would use a PKI, a key-transparency log, or an out-of-band fingerprint check (as Signal's safety numbers do).
- **Availability.** The city can still kill every courier. SiegeSeal guarantees that silence is *noticed* (gaps, missing receipts), not that messages get through.
- **Equivocation detection needs gossip.** A fork is only caught once the allies pool what they received. The tribunal does this explicitly; a live system would cross-check digests periodically.
- **Key compromise.** If a private seal is stolen, signatures stop proving authorship. Real systems add revocation and timestamped key validity.
- **Clocks.** The freshness window assumes roughly synchronised clocks (within `max_skew`).

## Licence

MIT
