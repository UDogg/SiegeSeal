// SiegeSeal protocol objects.
//
//   Envelope  — a signed message. Binds sender, recipient, a per-pair sequence
//               number, a timestamp, a random nonce and a hash link to the
//               sender's previous envelope. Any change to any byte breaks the
//               signature; the hash link makes the sender's history a chain
//               that cannot be forked without leaving signed proof.
//   Receipt   — the recipient's signed acknowledgement of exactly which
//               envelope (by digest) it received. Non-repudiation of receipt.
//   Treaty    — a joint plan that is only binding once every named party has
//               signed the identical bytes.
#pragma once

#include "siegeseal/crypto.hpp"

#include <map>
#include <optional>
#include <string>
#include <vector>

namespace siegeseal {

using Nonce = std::array<std::uint8_t, 16>;
inline constexpr std::uint8_t kProtocolVersion = 1;

struct Envelope {
    std::uint8_t version = kProtocolVersion;
    std::string sender;
    std::string recipient;
    std::uint64_t seq = 0;        // per (sender, recipient) pair, starts at 1
    std::uint64_t timestamp = 0;  // seconds (sender's clock)
    Nonce nonce{};
    Digest prev{};                // digest of the sender's previous envelope (all zero for first)
    std::string payload;
    Signature sig{};

    Bytes signed_bytes() const;   // domain-separated canonical encoding, excludes sig
    Digest digest() const;        // SHA-256 of signed_bytes(); the envelope's identity
    Bytes encode() const;         // full wire format, includes sig
    static Envelope decode(const Bytes& wire);
};

struct Receipt {
    std::string receiver;
    std::string original_sender;
    Digest envelope_digest{};
    std::uint64_t received_at = 0;
    Signature sig{};

    Bytes signed_bytes() const;
    Bytes encode() const;
    static Receipt decode(const Bytes& wire);
};

struct Treaty {
    std::string terms;
    std::vector<std::string> parties;           // canonical (sorted) list of required signers
    std::map<std::string, Signature> signatures;

    Bytes signed_bytes() const;
};

// Who holds which public key. Populated out-of-band ("the seal ceremony")
// before any message is sent — this is the trust anchor the whole scheme
// rests on. If the adversary could substitute keys here, no signature
// scheme would help.
class KeyDirectory {
public:
    // Throws CryptoError if the key cannot be parsed.
    void add(const std::string& name, const PublicKey& pk) { keys_.insert_or_assign(name, VerifyKey(pk)); }
    const PublicKey* find(const std::string& name) const {
        auto it = keys_.find(name);
        return it == keys_.end() ? nullptr : &it->second.raw();
    }
    const VerifyKey* verifier(const std::string& name) const {
        auto it = keys_.find(name);
        return it == keys_.end() ? nullptr : &it->second;
    }

private:
    std::map<std::string, VerifyKey> keys_;
};

// ---- stateless verification (usable by any third party) -------------------
bool verify_envelope(const KeyDirectory& dir, const Envelope& e);
// Same check when the caller already holds e.signed_bytes() (avoids re-encoding).
bool verify_envelope(const KeyDirectory& dir, const Envelope& e, const Bytes& signed_bytes);
bool verify_receipt(const KeyDirectory& dir, const Receipt& r);
bool verify_treaty(const KeyDirectory& dir, const Treaty& t, std::vector<std::string>* missing = nullptr);

// Two validly-signed envelopes from the same sender that both claim the same
// predecessor are a signed fork: proof the sender told different parties
// different stories (equivocation).
struct Equivocation {
    std::string sender;
    Envelope first;
    Envelope second;
};
std::vector<Equivocation> find_equivocations(const KeyDirectory& dir,
                                             const std::vector<Envelope>& pooled);

}  // namespace siegeseal
