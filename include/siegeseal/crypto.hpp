// SiegeSeal — cryptographic primitives (thin RAII wrappers over OpenSSL 3).
//
// Ed25519 for signatures, SHA-256 for digests, OS CSPRNG for nonces.
#pragma once

#include <array>
#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>
#include <string_view>
#include <vector>

struct evp_pkey_st;  // OpenSSL's EVP_PKEY, kept out of this header

namespace siegeseal {

using Bytes = std::vector<std::uint8_t>;
using Digest = std::array<std::uint8_t, 32>;
using PublicKey = std::array<std::uint8_t, 32>;
using Signature = std::array<std::uint8_t, 64>;

struct CryptoError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

// ---- helpers --------------------------------------------------------------
std::string to_hex(const std::uint8_t* data, std::size_t len);
template <class C> std::string to_hex(const C& c) { return to_hex(c.data(), c.size()); }
Bytes from_hex(std::string_view hex);

Digest sha256(const std::uint8_t* data, std::size_t len);
inline Digest sha256(const Bytes& b) { return sha256(b.data(), b.size()); }

Bytes random_bytes(std::size_t n);

// Constant-time equality.
bool ct_equal(const std::uint8_t* a, const std::uint8_t* b, std::size_t len);

// Short human-checkable fingerprint, e.g. "3F9A-11C0-7B2E-D4A8".
std::string fingerprint(const PublicKey& pk);

// Hash for fixed-size byte arrays that are already uniformly random
// (digests, nonces): the first 8 bytes are as good a hash as any.
struct ByteArrayHash {
    template <std::size_t N>
    std::size_t operator()(const std::array<std::uint8_t, N>& a) const noexcept {
        static_assert(N >= 8, "need at least 8 bytes");
        std::size_t h = 0;
        for (std::size_t i = 0; i < 8; ++i) h = (h << 8) | a[i];
        return h;
    }
};

// ---- Ed25519 --------------------------------------------------------------
bool ed25519_verify(const PublicKey& pk, const std::uint8_t* msg, std::size_t len,
                    const Signature& sig);
inline bool ed25519_verify(const PublicKey& pk, const Bytes& msg, const Signature& sig) {
    return ed25519_verify(pk, msg.data(), msg.size(), sig);
}

// A public key parsed once and reused for every verification.
class VerifyKey {
public:
    explicit VerifyKey(const PublicKey& pk);  // throws CryptoError if OpenSSL rejects the key
    bool verify(const std::uint8_t* msg, std::size_t len, const Signature& sig) const;
    bool verify(const Bytes& msg, const Signature& sig) const { return verify(msg.data(), msg.size(), sig); }
    const PublicKey& raw() const { return raw_; }

private:
    PublicKey raw_;
    std::shared_ptr<::evp_pkey_st> key_;
};

class SigningKey {
public:
    static SigningKey generate();
    static SigningKey from_seed(const Bytes& seed32);

    SigningKey(SigningKey&&) noexcept;
    SigningKey& operator=(SigningKey&&) noexcept;
    ~SigningKey();

    Signature sign(const std::uint8_t* msg, std::size_t len) const;
    Signature sign(const Bytes& msg) const { return sign(msg.data(), msg.size()); }

    const PublicKey& public_key() const { return pub_; }
    Bytes seed() const;  // 32-byte private seed (handle with care)

private:
    struct Impl;
    explicit SigningKey(std::unique_ptr<Impl> impl);
    std::unique_ptr<Impl> impl_;
    PublicKey pub_{};
};

}  // namespace siegeseal
