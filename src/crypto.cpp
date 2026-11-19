#include "siegeseal/crypto.hpp"

#include <openssl/crypto.h>
#include <openssl/evp.h>
#include <openssl/rand.h>

#include <cctype>

namespace siegeseal {

namespace {
struct PkeyDeleter { void operator()(EVP_PKEY* p) const { EVP_PKEY_free(p); } };
struct MdCtxDeleter { void operator()(EVP_MD_CTX* c) const { EVP_MD_CTX_free(c); } };
using PkeyPtr = std::unique_ptr<EVP_PKEY, PkeyDeleter>;
using MdCtxPtr = std::unique_ptr<EVP_MD_CTX, MdCtxDeleter>;

int hexval(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}
}  // namespace

std::string to_hex(const std::uint8_t* data, std::size_t len) {
    static const char* digits = "0123456789abcdef";
    std::string out;
    out.reserve(len * 2);
    for (std::size_t i = 0; i < len; ++i) {
        out.push_back(digits[data[i] >> 4]);
        out.push_back(digits[data[i] & 0xF]);
    }
    return out;
}

Bytes from_hex(std::string_view hex) {
    if (hex.size() % 2) throw CryptoError("hex string has odd length");
    Bytes out(hex.size() / 2);
    for (std::size_t i = 0; i < out.size(); ++i) {
        int hi = hexval(hex[2 * i]), lo = hexval(hex[2 * i + 1]);
        if (hi < 0 || lo < 0) throw CryptoError("invalid hex character");
        out[i] = static_cast<std::uint8_t>((hi << 4) | lo);
    }
    return out;
}

Digest sha256(const std::uint8_t* data, std::size_t len) {
    Digest d{};
    unsigned int outlen = 0;
    if (EVP_Digest(data, len, d.data(), &outlen, EVP_sha256(), nullptr) != 1 || outlen != 32)
        throw CryptoError("SHA-256 failed");
    return d;
}

Bytes random_bytes(std::size_t n) {
    Bytes b(n);
    if (n && RAND_bytes(b.data(), static_cast<int>(n)) != 1) throw CryptoError("RAND_bytes failed");
    return b;
}

bool ct_equal(const std::uint8_t* a, const std::uint8_t* b, std::size_t len) {
    return CRYPTO_memcmp(a, b, len) == 0;
}

std::string fingerprint(const PublicKey& pk) {
    Digest d = sha256(pk.data(), pk.size());
    std::string hex = to_hex(d.data(), 8);
    std::string out;
    for (std::size_t i = 0; i < hex.size(); ++i) {
        if (i && i % 4 == 0) out.push_back('-');
        out.push_back(static_cast<char>(std::toupper(static_cast<unsigned char>(hex[i]))));
    }
    return out;
}

namespace {
bool verify_with(EVP_PKEY* key, const std::uint8_t* msg, std::size_t len, const Signature& sig) {
    MdCtxPtr ctx(EVP_MD_CTX_new());
    if (!ctx || EVP_DigestVerifyInit(ctx.get(), nullptr, nullptr, nullptr, key) != 1) return false;
    return EVP_DigestVerify(ctx.get(), sig.data(), sig.size(), msg, len) == 1;
}
}  // namespace

bool ed25519_verify(const PublicKey& pk, const std::uint8_t* msg, std::size_t len,
                    const Signature& sig) {
    PkeyPtr key(EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, nullptr, pk.data(), pk.size()));
    return key && verify_with(key.get(), msg, len, sig);
}

VerifyKey::VerifyKey(const PublicKey& pk) : raw_(pk) {
    EVP_PKEY* k = EVP_PKEY_new_raw_public_key(EVP_PKEY_ED25519, nullptr, pk.data(), pk.size());
    if (!k) throw CryptoError("invalid Ed25519 public key");
    key_.reset(k, EVP_PKEY_free);
}

bool VerifyKey::verify(const std::uint8_t* msg, std::size_t len, const Signature& sig) const {
    return verify_with(key_.get(), msg, len, sig);
}

// ---- SigningKey -----------------------------------------------------------
struct SigningKey::Impl {
    PkeyPtr key;
};

SigningKey::SigningKey(std::unique_ptr<Impl> impl) : impl_(std::move(impl)) {
    std::size_t len = pub_.size();
    if (EVP_PKEY_get_raw_public_key(impl_->key.get(), pub_.data(), &len) != 1 || len != 32)
        throw CryptoError("could not extract Ed25519 public key");
}

SigningKey::SigningKey(SigningKey&&) noexcept = default;
SigningKey& SigningKey::operator=(SigningKey&&) noexcept = default;
SigningKey::~SigningKey() = default;

SigningKey SigningKey::generate() {
    EVP_PKEY* raw = EVP_PKEY_Q_keygen(nullptr, nullptr, "ED25519");
    if (!raw) throw CryptoError("Ed25519 key generation failed");
    auto impl = std::make_unique<Impl>();
    impl->key.reset(raw);
    return SigningKey(std::move(impl));
}

SigningKey SigningKey::from_seed(const Bytes& seed32) {
    if (seed32.size() != 32) throw CryptoError("Ed25519 seed must be 32 bytes");
    EVP_PKEY* raw =
        EVP_PKEY_new_raw_private_key(EVP_PKEY_ED25519, nullptr, seed32.data(), seed32.size());
    if (!raw) throw CryptoError("invalid Ed25519 seed");
    auto impl = std::make_unique<Impl>();
    impl->key.reset(raw);
    return SigningKey(std::move(impl));
}

Signature SigningKey::sign(const std::uint8_t* msg, std::size_t len) const {
    Signature sig{};
    MdCtxPtr ctx(EVP_MD_CTX_new());
    std::size_t siglen = sig.size();
    if (!ctx || EVP_DigestSignInit(ctx.get(), nullptr, nullptr, nullptr, impl_->key.get()) != 1 ||
        EVP_DigestSign(ctx.get(), sig.data(), &siglen, msg, len) != 1 || siglen != 64)
        throw CryptoError("Ed25519 signing failed");
    return sig;
}

Bytes SigningKey::seed() const {
    Bytes out(32);
    std::size_t len = out.size();
    if (EVP_PKEY_get_raw_private_key(impl_->key.get(), out.data(), &len) != 1 || len != 32)
        throw CryptoError("could not export seed");
    return out;
}

}  // namespace siegeseal
