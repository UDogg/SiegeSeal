// Canonical, length-prefixed binary encoding. Every signed structure is
// signed over exactly these bytes, so there is one and only one byte string
// a signature can refer to (no JSON whitespace / field-order ambiguity).
#pragma once

#include "siegeseal/crypto.hpp"

#include <string>

namespace siegeseal {

struct WireError : std::runtime_error {
    using std::runtime_error::runtime_error;
};

class Writer {
public:
    Writer() = default;
    explicit Writer(std::size_t reserve) { buf_.reserve(reserve); }
    void u8(std::uint8_t v) { buf_.push_back(v); }
    void u32(std::uint32_t v) {
        for (int i = 3; i >= 0; --i) buf_.push_back(static_cast<std::uint8_t>(v >> (8 * i)));
    }
    void u64(std::uint64_t v) {
        for (int i = 7; i >= 0; --i) buf_.push_back(static_cast<std::uint8_t>(v >> (8 * i)));
    }
    void raw(const std::uint8_t* p, std::size_t n) { buf_.insert(buf_.end(), p, p + n); }
    template <std::size_t N> void fixed(const std::array<std::uint8_t, N>& a) { raw(a.data(), N); }
    void bytes(const Bytes& b) { u32(static_cast<std::uint32_t>(b.size())); raw(b.data(), b.size()); }
    void str(const std::string& s) {
        u32(static_cast<std::uint32_t>(s.size()));
        raw(reinterpret_cast<const std::uint8_t*>(s.data()), s.size());
    }
    const Bytes& data() const { return buf_; }
    Bytes take() { return std::move(buf_); }

private:
    Bytes buf_;
};

class Reader {
public:
    explicit Reader(const Bytes& b) : b_(b) {}
    std::uint8_t u8() { need(1); return b_[pos_++]; }
    std::uint32_t u32() {
        need(4);
        std::uint32_t v = 0;
        for (int i = 0; i < 4; ++i) v = (v << 8) | b_[pos_++];
        return v;
    }
    std::uint64_t u64() {
        need(8);
        std::uint64_t v = 0;
        for (int i = 0; i < 8; ++i) v = (v << 8) | b_[pos_++];
        return v;
    }
    template <std::size_t N> std::array<std::uint8_t, N> fixed() {
        need(N);
        std::array<std::uint8_t, N> a{};
        std::copy(b_.begin() + pos_, b_.begin() + pos_ + N, a.begin());
        pos_ += N;
        return a;
    }
    Bytes bytes() {
        std::uint32_t n = u32();
        need(n);
        Bytes out(b_.begin() + pos_, b_.begin() + pos_ + n);
        pos_ += n;
        return out;
    }
    std::string str() {
        std::uint32_t n = u32();
        need(n);
        std::string out(b_.begin() + pos_, b_.begin() + pos_ + n);
        pos_ += n;
        return out;
    }
    void expect_end() const {
        if (pos_ != b_.size()) throw WireError("trailing bytes after message");
    }

private:
    void need(std::size_t n) const {
        if (b_.size() - pos_ < n) throw WireError("truncated message");
    }
    const Bytes& b_;
    std::size_t pos_ = 0;
};

}  // namespace siegeseal
