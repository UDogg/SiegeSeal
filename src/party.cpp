#include "siegeseal/party.hpp"

#include "siegeseal/wire.hpp"

namespace siegeseal {

const char* status_name(Status s) {
    switch (s) {
        case Status::Accepted: return "ACCEPTED";
        case Status::AcceptedWithGap: return "ACCEPTED (GAP)";
        case Status::Malformed: return "MALFORMED";
        case Status::UnknownSender: return "UNKNOWN SENDER";
        case Status::Misrouted: return "MISROUTED";
        case Status::BadSignature: return "BAD SIGNATURE";
        case Status::Replay: return "REPLAY";
        case Status::OutOfOrder: return "OUT OF ORDER";
        case Status::Expired: return "EXPIRED";
    }
    return "?";
}

Party::Party(std::string name, SigningKey key, Policy policy)
    : name_(std::move(name)), key_(std::move(key)), policy_(policy) {
    dir_.add(name_, key_.public_key());
}

Envelope Party::sign_new(const std::string& recipient, const std::string& payload,
                         std::uint64_t now, const Digest& prev, Digest* digest_out) {
    Envelope e;
    e.sender = name_;
    e.recipient = recipient;
    e.seq = ++next_seq_out_[recipient];
    e.timestamp = now;
    Bytes n = random_bytes(e.nonce.size());
    std::copy(n.begin(), n.end(), e.nonce.begin());
    e.prev = prev;
    e.payload = payload;
    const Bytes sb = e.signed_bytes();  // encode once: sign it and hash it
    e.sig = key_.sign(sb);
    const Digest d = sha256(sb);
    sent_by_digest_.emplace(d, sent_.size());
    sent_.push_back(e);
    acked_.push_back(false);
    if (digest_out) *digest_out = d;
    return e;
}

Envelope Party::compose(const std::string& recipient, const std::string& payload,
                        std::uint64_t now) {
    return sign_new(recipient, payload, now, chain_head_, &chain_head_);
}

Envelope Party::compose_at(const std::string& recipient, const std::string& payload,
                           std::uint64_t now, const Digest& prev) {
    return sign_new(recipient, payload, now, prev, nullptr);
}

Verdict Party::receive(const Bytes& wire, std::uint64_t now) {
    Envelope e;
    try {
        e = Envelope::decode(wire);
    } catch (const std::exception& ex) {
        return {Status::Malformed, ex.what(), {}, {}};
    }

    // 1. Authenticity first — nothing else in an unauthenticated message can be believed.
    if (!dir_.find(e.sender))
        return {Status::UnknownSender, "no seal on record for '" + e.sender + "'", {}, {}};
    const Bytes sb = e.signed_bytes();  // encode once: verify it, then hash it for the receipt
    if (!verify_envelope(dir_, e, sb))
        return {Status::BadSignature,
                "signature does not match " + e.sender + "'s seal — altered in transit or forged",
                {}, {}};

    // 2. Authentic, but is it for us?
    if (e.recipient != name_)
        return {Status::Misrouted, "signed for '" + e.recipient + "', not for us", {}, {}};

    // 3. Freshness.
    if (e.timestamp + policy_.max_age < now)
        return {Status::Expired, "message is older than the freshness window", {}, {}};
    if (e.timestamp > now + policy_.max_skew)
        return {Status::Expired, "message is dated in the future", {}, {}};

    // 4. Replay and ordering.
    if (seen_nonces_.count(e.nonce))
        return {Status::Replay, "nonce already seen — this exact message was delivered before", {}, {}};
    std::uint64_t& last = last_seq_in_[e.sender];
    if (e.seq <= last)
        return {Status::OutOfOrder,
                "sequence " + std::to_string(e.seq) + " already consumed (last was " +
                    std::to_string(last) + ")",
                {}, {}};

    Status status = Status::Accepted;
    std::string detail = "verified against " + e.sender + "'s seal";
    if (e.seq != last + 1) {
        status = Status::AcceptedWithGap;
        detail += (e.seq - 1 == last + 1)
                      ? "; message " + std::to_string(last + 1)
                      : "; messages " + std::to_string(last + 1) + ".." + std::to_string(e.seq - 1);
        detail += " from " + e.sender + " never arrived";
    }
    last = e.seq;
    seen_nonces_.insert(e.nonce);

    Receipt r;
    r.receiver = name_;
    r.original_sender = e.sender;
    r.envelope_digest = sha256(sb);
    r.received_at = now;
    r.sig = key_.sign(r.signed_bytes());
    archive_.push_back(e);
    return {status, std::move(detail), std::move(e), std::move(r)};
}

bool Party::accept_receipt(const Bytes& wire) {
    Receipt r;
    try {
        r = Receipt::decode(wire);
    } catch (const std::exception&) {
        return false;
    }
    if (r.original_sender != name_) return false;
    // Look up the envelope first (cheap) so receipts for unknown letters cost no signature check.
    auto it = sent_by_digest_.find(r.envelope_digest);
    if (it == sent_by_digest_.end()) return false;  // a receipt for a message we never sent
    if (sent_[it->second].recipient != r.receiver || !verify_receipt(dir_, r)) return false;
    acked_[it->second] = true;
    return true;
}

std::vector<Envelope> Party::unacknowledged() const {
    std::vector<Envelope> out;
    for (std::size_t i = 0; i < sent_.size(); ++i)
        if (!acked_[i]) out.push_back(sent_[i]);
    return out;
}

void Party::sign_treaty(Treaty& t) const { t.signatures[name_] = key_.sign(t.signed_bytes()); }

}  // namespace siegeseal
