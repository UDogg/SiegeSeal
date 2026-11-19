// Minimal self-contained test runner — no external framework needed.
#include "siegeseal/party.hpp"
#include "siegeseal/wire.hpp"

#include <functional>
#include <iostream>
#include <string>
#include <vector>

using namespace siegeseal;

namespace {
int failures = 0, checks = 0;
#define CHECK(cond)                                                                   \
    do {                                                                              \
        ++checks;                                                                     \
        if (!(cond)) {                                                                \
            ++failures;                                                               \
            std::cerr << "  FAIL " << __FILE__ << ":" << __LINE__ << "  " #cond "\n"; \
        }                                                                             \
    } while (0)

std::vector<std::pair<const char*, std::function<void()>>>& registry() {
    static std::vector<std::pair<const char*, std::function<void()>>> r;
    return r;
}
struct Reg {
    Reg(const char* n, std::function<void()> f) { registry().emplace_back(n, std::move(f)); }
};
#define TEST(name) \
    void name();   \
    Reg reg_##name(#name, name); \
    void name()

constexpr std::uint64_t T0 = 1'000'000;

struct Trio {
    Party a{"A", SigningKey::generate()};
    Party b{"B", SigningKey::generate()};
    Party c{"C", SigningKey::generate()};
    Trio() {
        for (Party* x : {&a, &b, &c})
            for (Party* y : {&a, &b, &c})
                if (x != y) x->trust(y->name(), y->public_key());
    }
};
}  // namespace

TEST(sign_verify_roundtrip) {
    auto k = SigningKey::generate();
    Bytes m = {1, 2, 3};
    auto s = k.sign(m);
    CHECK(ed25519_verify(k.public_key(), m, s));
    m[0] ^= 1;
    CHECK(!ed25519_verify(k.public_key(), m, s));
}

TEST(seed_roundtrip) {
    auto k = SigningKey::generate();
    auto k2 = SigningKey::from_seed(k.seed());
    CHECK(k.public_key() == k2.public_key());
}

TEST(rfc8032_test_vector_1) {
    // RFC 8032 §7.1, TEST 1 (empty message)
    auto k = SigningKey::from_seed(
        from_hex("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60"));
    CHECK(to_hex(k.public_key()) ==
          "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a");
    CHECK(to_hex(k.sign(Bytes{})) ==
          "e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e06522490155"
          "5fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b");
}

TEST(envelope_wire_roundtrip) {
    Trio t;
    Envelope e = t.a.compose("B", "hello", T0);
    Envelope d = Envelope::decode(e.encode());
    CHECK(d.digest() == e.digest());
    CHECK(d.sig == e.sig);
}

TEST(honest_delivery_and_receipt) {
    Trio t;
    Envelope e = t.a.compose("B", "attack at dawn", T0);
    Verdict v = t.b.receive(e.encode(), T0 + 10);
    CHECK(v.status == Status::Accepted);
    CHECK(v.receipt.has_value());
    CHECK(t.a.unacknowledged().size() == 1);
    CHECK(t.a.accept_receipt(v.receipt->encode()));
    CHECK(t.a.unacknowledged().empty());
}

TEST(every_single_bit_flip_is_detected) {
    Trio t;
    Envelope e = t.a.compose("B", "attack at dawn", T0);
    Bytes wire = e.encode();
    int accepted = 0;
    for (std::size_t i = 0; i < wire.size(); ++i)
        for (int bit = 0; bit < 8; ++bit) {
            Party fresh("B", SigningKey::generate());
            fresh.trust("A", t.a.public_key());
            Bytes w = wire;
            w[i] ^= static_cast<std::uint8_t>(1u << bit);
            if (is_accepted(fresh.receive(w, T0).status)) ++accepted;
        }
    CHECK(accepted == 0);
}

TEST(payload_tamper_rejected) {
    Trio t;
    Envelope e = t.a.compose("B", "attack at dawn", T0);
    e.payload = "attack at dusk";
    CHECK(t.b.receive(e.encode(), T0).status == Status::BadSignature);
}

TEST(forged_sender_rejected) {
    Trio t;
    auto mallory = SigningKey::generate();
    Envelope e;
    e.sender = "C";
    e.recipient = "B";
    e.seq = 1;
    e.timestamp = T0;
    e.payload = "retreat";
    e.sig = mallory.sign(e.signed_bytes());
    CHECK(t.b.receive(e.encode(), T0).status == Status::BadSignature);
}

TEST(unknown_sender_rejected) {
    Trio t;
    Party m("Mallory", SigningKey::generate());
    m.trust("B", t.b.public_key());
    Envelope e = m.compose("B", "trust me", T0);
    CHECK(t.b.receive(e.encode(), T0).status == Status::UnknownSender);
}

TEST(replay_rejected) {
    Trio t;
    Bytes w = t.a.compose("B", "hold", T0).encode();
    CHECK(t.b.receive(w, T0).status == Status::Accepted);
    CHECK(t.b.receive(w, T0 + 5).status == Status::Replay);
}

TEST(old_sequence_rejected_even_with_new_nonce) {
    Trio t;
    Envelope e1 = t.a.compose("B", "one", T0);
    Envelope e2 = t.a.compose("B", "two", T0 + 1);
    CHECK(is_accepted(t.b.receive(e2.encode(), T0 + 2).status));
    CHECK(t.b.receive(e1.encode(), T0 + 3).status == Status::OutOfOrder);
}

TEST(drop_detected_as_gap) {
    Trio t;
    t.a.compose("B", "lost", T0);
    Envelope e2 = t.a.compose("B", "arrives", T0 + 1);
    Verdict v = t.b.receive(e2.encode(), T0 + 2);
    CHECK(v.status == Status::AcceptedWithGap);
}

TEST(reroute_rejected) {
    Trio t;
    Envelope e = t.a.compose("B", "for B only", T0);
    CHECK(t.c.receive(e.encode(), T0).status == Status::Misrouted);
}

TEST(expired_and_future_rejected) {
    Trio t;
    Envelope old = t.a.compose("B", "stale", T0);
    CHECK(t.b.receive(old.encode(), T0 + 7 * 3600).status == Status::Expired);
    Envelope fut = t.a.compose("C", "from the future", T0 + 3600);
    CHECK(t.c.receive(fut.encode(), T0).status == Status::Expired);
}

TEST(truncated_is_malformed) {
    Trio t;
    Bytes w = t.a.compose("B", "x", T0).encode();
    w.pop_back();
    CHECK(t.b.receive(w, T0).status == Status::Malformed);
    w.push_back(0);
    w.push_back(0);
    CHECK(t.b.receive(w, T0).status == Status::Malformed);
}

TEST(forged_receipt_rejected) {
    Trio t;
    Envelope e = t.a.compose("B", "x", T0);
    Receipt r;
    r.receiver = "B";
    r.original_sender = "A";
    r.envelope_digest = e.digest();
    r.received_at = T0;
    r.sig = SigningKey::generate().sign(r.signed_bytes());
    CHECK(!t.a.accept_receipt(r.encode()));
    CHECK(t.a.unacknowledged().size() == 1);
}

TEST(receipt_signature_not_reusable_as_envelope) {
    // Domain separation: B's receipt signature must not verify as an envelope.
    Trio t;
    Envelope e = t.a.compose("B", "x", T0);
    Verdict v = t.b.receive(e.encode(), T0);
    Envelope spoof = e;
    spoof.sender = "B";
    spoof.sig = v.receipt->sig;
    CHECK(!verify_envelope(t.c.directory(), spoof));
}

TEST(treaty_needs_all_signatures) {
    Trio t;
    Treaty tr;
    tr.terms = "joint siege";
    tr.parties = {"A", "B", "C"};
    t.a.sign_treaty(tr);
    t.b.sign_treaty(tr);
    std::vector<std::string> missing;
    CHECK(!verify_treaty(t.a.directory(), tr, &missing));
    CHECK(missing.size() == 1 && missing[0] == "C");
    t.c.sign_treaty(tr);
    CHECK(verify_treaty(t.a.directory(), tr));
    tr.terms += "!";
    CHECK(!verify_treaty(t.a.directory(), tr));
}

TEST(treaty_party_order_irrelevant) {
    Trio t;
    Treaty x, y;
    x.terms = y.terms = "t";
    x.parties = {"A", "B", "C"};
    y.parties = {"C", "A", "B"};
    CHECK(x.signed_bytes() == y.signed_bytes());
}

TEST(equivocation_detected) {
    Trio t;
    Envelope first = t.c.compose("A", "warmup", T0);
    Digest head = first.digest();
    Envelope x = t.c.compose_at("A", "I attack", T0 + 1, head);
    Envelope y = t.c.compose_at("B", "I hold back", T0 + 1, head);
    auto forks = find_equivocations(t.a.directory(), {first, x, y});
    CHECK(forks.size() == 1);
    CHECK(forks.size() == 1 && forks[0].sender == "C");
}

TEST(honest_chain_has_no_equivocation) {
    Trio t;
    std::vector<Envelope> all;
    for (int i = 0; i < 5; ++i) all.push_back(t.a.compose(i % 2 ? "B" : "C", "m", T0 + i));
    all.push_back(all[2]);  // duplicate copies are not forks
    CHECK(find_equivocations(t.b.directory(), all).empty());
}

TEST(forgeries_cannot_frame_equivocation) {
    Trio t;
    Envelope real = t.a.compose("B", "real", T0);
    Envelope fake = real;
    fake.payload = "fake";  // signature now invalid
    CHECK(find_equivocations(t.c.directory(), {real, fake}).empty());
}

TEST(equivocation_found_among_many_honest_letters) {
    // The fast path skips signature checks for positions used once; a fork
    // hidden in a large honest pool, plus forgeries at the fork, must still
    // give exactly one genuine report.
    Trio t;
    std::vector<Envelope> pool;
    for (int i = 0; i < 300; ++i) pool.push_back(t.a.compose(i % 2 ? "B" : "C", "m" + std::to_string(i), T0 + i));
    Digest head = t.b.compose("A", "warmup", T0).digest();
    Envelope x = t.b.compose_at("A", "I attack", T0 + 1, head);
    Envelope y = t.b.compose_at("C", "I hold back", T0 + 1, head);
    Envelope forged = x;
    forged.payload = "framed";
    pool.insert(pool.begin() + 100, x);
    pool.push_back(forged);
    pool.push_back(y);
    pool.push_back(y);  // duplicate copy
    auto forks = find_equivocations(t.c.directory(), pool);
    CHECK(forks.size() == 1);
    CHECK(forks.size() == 1 && forks[0].sender == "B" && forks[0].first.payload == "I attack" &&
          forks[0].second.payload == "I hold back");
}

TEST(receipt_relabelled_to_another_party_rejected) {
    // B's genuine receipt, relabelled as if C had signed it, must not count.
    Trio t;
    Envelope e = t.a.compose("B", "for B", T0);
    Verdict v = t.b.receive(e.encode(), T0);
    Receipt relabelled = *v.receipt;
    relabelled.receiver = "C";
    CHECK(!t.a.accept_receipt(relabelled.encode()));
    CHECK(t.a.unacknowledged().size() == 1);
    CHECK(t.a.accept_receipt(v.receipt->encode()));
    CHECK(t.a.unacknowledged().empty());
}

TEST(receipt_for_unknown_letter_rejected) {
    Trio t;
    Envelope e = t.a.compose("B", "x", T0);
    Verdict v = t.b.receive(e.encode(), T0);
    Receipt r = *v.receipt;
    r.envelope_digest[0] ^= 1;
    CHECK(!t.a.accept_receipt(r.encode()));
    CHECK(t.a.unacknowledged().size() == 1);
}

TEST(digest_in_receipt_matches_envelope_digest) {
    Trio t;
    Envelope e = t.a.compose("B", "x", T0);
    Verdict v = t.b.receive(e.encode(), T0);
    CHECK(v.receipt && v.receipt->envelope_digest == e.digest());
}

int main() {
    for (auto& [name, fn] : registry()) {
        int before = failures;
        fn();
        std::cout << (failures == before ? "  ok    " : "  FAIL  ") << name << "\n";
    }
    std::cout << "\n" << checks - failures << "/" << checks << " checks passed\n";
    return failures ? 1 : 0;
}
