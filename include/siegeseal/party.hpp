// A Party is one commander: it holds a private seal, a directory of the seals
// it trusts, and the per-peer state needed to detect replay, reordering and
// dropped messages. Every envelope it accepts is archived as evidence.
#pragma once

#include "siegeseal/protocol.hpp"

#include <optional>
#include <string>
#include <unordered_map>
#include <unordered_set>
#include <vector>

namespace siegeseal {

enum class Status {
    Accepted,         // authentic, fresh, in order
    AcceptedWithGap,  // authentic and fresh, but earlier messages never arrived
    Malformed,        // bytes don't parse
    UnknownSender,    // no seal on record for the claimed sender
    Misrouted,        // validly signed, but addressed to someone else
    BadSignature,     // altered in transit, or forged
    Replay,           // exact nonce seen before
    OutOfOrder,       // sequence number already consumed (stale/replayed copy)
    Expired,          // timestamp outside the freshness window
};

const char* status_name(Status s);
inline bool is_accepted(Status s) { return s == Status::Accepted || s == Status::AcceptedWithGap; }

struct Verdict {
    Status status;
    std::string detail;
    std::optional<Envelope> envelope;  // set when accepted
    std::optional<Receipt> receipt;    // signed ack to send back, set when accepted
};

struct Policy {
    std::uint64_t max_age = 6 * 3600;  // reject messages older than this (seconds)
    std::uint64_t max_skew = 300;      // reject messages this far in the future
};

class Party {
public:
    Party(std::string name, SigningKey key, Policy policy = {});

    const std::string& name() const { return name_; }
    const PublicKey& public_key() const { return key_.public_key(); }

    // The seal ceremony: record a peer's public key, obtained in person.
    void trust(const std::string& peer, const PublicKey& pk) { dir_.add(peer, pk); }
    const KeyDirectory& directory() const { return dir_; }

    Envelope compose(const std::string& recipient, const std::string& payload, std::uint64_t now);
    Verdict receive(const Bytes& wire, std::uint64_t now);

    // Process a receipt for something we sent. Returns false if forged or unknown.
    bool accept_receipt(const Bytes& wire);
    std::vector<Envelope> unacknowledged() const;

    void sign_treaty(Treaty& t) const;

    const std::vector<Envelope>& archive() const { return archive_; }
    const std::vector<Envelope>& sent() const { return sent_; }

    // For demonstrating a *dishonest* commander: compose an envelope that
    // reuses a given chain position (to send conflicting orders to two peers).
    Envelope compose_at(const std::string& recipient, const std::string& payload,
                        std::uint64_t now, const Digest& prev);

private:
    // Signs, records and returns a new envelope; *digest_out receives its digest.
    Envelope sign_new(const std::string& recipient, const std::string& payload,
                      std::uint64_t now, const Digest& prev, Digest* digest_out);

    std::string name_;
    SigningKey key_;
    Policy policy_;
    KeyDirectory dir_;

    Digest chain_head_{};                              // digest of our last sent envelope
    std::unordered_map<std::string, std::uint64_t> next_seq_out_;
    std::unordered_map<std::string, std::uint64_t> last_seq_in_;
    std::unordered_set<Nonce, ByteArrayHash> seen_nonces_;

    // Sent envelopes, with their digests indexed so a receipt is matched in O(1).
    std::vector<Envelope> sent_;
    std::vector<bool> acked_;                          // parallel to sent_
    std::unordered_map<Digest, std::size_t, ByteArrayHash> sent_by_digest_;
    std::vector<Envelope> archive_;
};

}  // namespace siegeseal
