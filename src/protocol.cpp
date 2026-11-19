#include "siegeseal/protocol.hpp"

#include "siegeseal/wire.hpp"

#include <algorithm>
#include <cstring>
#include <set>
#include <unordered_map>

namespace siegeseal {

namespace {
// Domain separation tags: a signature over an Envelope can never be replayed
// as a signature over a Receipt or Treaty, even if the bytes happened to align.
constexpr const char* kEnvTag = "SIEGESEAL/ENVELOPE/v1";
constexpr const char* kRcptTag = "SIEGESEAL/RECEIPT/v1";
constexpr const char* kTreatyTag = "SIEGESEAL/TREATY/v1";
}  // namespace

// ---- Envelope ---------------------------------------------------------------
Bytes Envelope::signed_bytes() const {
    Writer w(32 + 1 + 12 + sender.size() + recipient.size() + 16 + 16 + 32 + payload.size() + 16);
    w.str(kEnvTag);
    w.u8(version);
    w.str(sender);
    w.str(recipient);
    w.u64(seq);
    w.u64(timestamp);
    w.fixed(nonce);
    w.fixed(prev);
    w.str(payload);
    return w.take();
}

Digest Envelope::digest() const { return sha256(signed_bytes()); }

Bytes Envelope::encode() const {
    Writer w(1 + 12 + sender.size() + recipient.size() + 16 + 16 + 32 + payload.size() + 4 + 64);
    w.u8(version);
    w.str(sender);
    w.str(recipient);
    w.u64(seq);
    w.u64(timestamp);
    w.fixed(nonce);
    w.fixed(prev);
    w.str(payload);
    w.fixed(sig);
    return w.take();
}

Envelope Envelope::decode(const Bytes& wire) {
    Reader r(wire);
    Envelope e;
    e.version = r.u8();
    if (e.version != kProtocolVersion) throw WireError("unsupported protocol version");
    e.sender = r.str();
    e.recipient = r.str();
    e.seq = r.u64();
    e.timestamp = r.u64();
    e.nonce = r.fixed<16>();
    e.prev = r.fixed<32>();
    e.payload = r.str();
    e.sig = r.fixed<64>();
    r.expect_end();
    return e;
}

// ---- Receipt ----------------------------------------------------------------
Bytes Receipt::signed_bytes() const {
    Writer w;
    w.str(kRcptTag);
    w.str(receiver);
    w.str(original_sender);
    w.fixed(envelope_digest);
    w.u64(received_at);
    return w.take();
}

Bytes Receipt::encode() const {
    Writer w;
    w.str(receiver);
    w.str(original_sender);
    w.fixed(envelope_digest);
    w.u64(received_at);
    w.fixed(sig);
    return w.take();
}

Receipt Receipt::decode(const Bytes& wire) {
    Reader r(wire);
    Receipt rc;
    rc.receiver = r.str();
    rc.original_sender = r.str();
    rc.envelope_digest = r.fixed<32>();
    rc.received_at = r.u64();
    rc.sig = r.fixed<64>();
    r.expect_end();
    return rc;
}

// ---- Treaty -----------------------------------------------------------------
Bytes Treaty::signed_bytes() const {
    std::vector<std::string> sorted = parties;
    std::sort(sorted.begin(), sorted.end());
    Writer w;
    w.str(kTreatyTag);
    w.str(terms);
    w.u32(static_cast<std::uint32_t>(sorted.size()));
    for (const auto& p : sorted) w.str(p);
    return w.take();
}

// ---- verification -----------------------------------------------------------
bool verify_envelope(const KeyDirectory& dir, const Envelope& e, const Bytes& sb) {
    const VerifyKey* vk = dir.verifier(e.sender);
    return vk && vk->verify(sb, e.sig);
}

bool verify_envelope(const KeyDirectory& dir, const Envelope& e) {
    return dir.verifier(e.sender) && verify_envelope(dir, e, e.signed_bytes());
}

bool verify_receipt(const KeyDirectory& dir, const Receipt& r) {
    const VerifyKey* vk = dir.verifier(r.receiver);
    return vk && vk->verify(r.signed_bytes(), r.sig);
}

bool verify_treaty(const KeyDirectory& dir, const Treaty& t, std::vector<std::string>* missing) {
    const Bytes msg = t.signed_bytes();
    bool ok = !t.parties.empty();
    for (const auto& party : t.parties) {
        auto it = t.signatures.find(party);
        const VerifyKey* vk = dir.verifier(party);
        if (it == t.signatures.end() || !vk || !vk->verify(msg, it->second)) {
            ok = false;
            if (missing) missing->push_back(party);
        }
    }
    return ok;
}

std::vector<Equivocation> find_equivocations(const KeyDirectory& dir,
                                             const std::vector<Envelope>& pooled) {
    // A fork needs two envelopes claiming the same (sender, predecessor). Find
    // those positions first with no cryptography at all; only envelopes at a
    // shared position need their signature checked. An honest archive costs
    // one hash-map pass.
    auto position = [](const Envelope& e) {
        std::string k = e.sender;
        k.push_back('\0');
        k.append(reinterpret_cast<const char*>(e.prev.data()), e.prev.size());
        return k;
    };
    std::unordered_map<std::string, std::size_t> count;
    count.reserve(pooled.size());
    for (const auto& e : pooled) ++count[position(e)];

    // position -> (first valid envelope there, its digest)
    std::unordered_map<std::string, std::pair<const Envelope*, Digest>> first;
    std::set<std::pair<Digest, Digest>> reported;
    std::vector<Equivocation> out;
    for (const auto& e : pooled) {
        std::string key = position(e);
        if (count[key] < 2) continue;
        const Bytes sb = e.signed_bytes();
        if (!verify_envelope(dir, e, sb)) continue;  // forgeries prove nothing about the sender
        const Digest d = sha256(sb);
        auto [it, inserted] = first.try_emplace(std::move(key), &e, d);
        if (inserted) continue;
        const Digest& a = it->second.second;
        if (ct_equal(a.data(), d.data(), d.size())) continue;  // same envelope, two copies
        if (reported.insert(std::minmax(a, d)).second) out.push_back({e.sender, *it->second.first, e});
    }
    return out;
}

}  // namespace siegeseal
