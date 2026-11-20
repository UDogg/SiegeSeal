# Changelog

## 1.0.0 (2026-11-19)

First release.

### Protocol and library
- Ed25519-signed envelopes binding sender, recipient, sequence number, timestamp, nonce and a hash link to the sender's previous letter.
- Signed receipts (non-repudiation of receipt), multi-party treaties, and equivocation proofs.
- Canonical length-prefixed encoding with domain-separated signatures.
- Receipts matched to sent letters in constant time; equivocation scan checks signatures only where a fork is possible.
- Installable as a CMake package: `find_package(SiegeSeal)` gives `SiegeSeal::siegeseal`.

### Programs
- `siegeseal`: keygen, fingerprint, sign, verify, verify-envelope.
- `siege_sim`: the Siege of Vharos story.
- `siegeseal_bench`: throughput of each hot path.
- All three take `--version` and `--help`.

### Classroom web app
- **SiegeSeal Records** (the start page): signed create/read/update/delete for 3–5 students, with a Database admin attacker, a signatures on/off switch, removal detection and portable proofs.
- **Siege of Vharos** (`siege.html`): the messaging game; byte-compatible with the C++ library.
- Static site under `share/siegeseal/web`.

### Release build
- Binaries link OpenSSL and the C++ runtime statically, and need only the system C library.
- Hardened: PIE, full RELRO, non-executable stack, stack protector, `_FORTIFY_SOURCE=3`, CET.
