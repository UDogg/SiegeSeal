// siegeseal_bench — throughput of the protocol's hot paths.
//
//   siegeseal_bench [messages]      default 20000
//
// Each scenario is timed end to end, so the numbers include canonical
// encoding, hashing and bookkeeping, not just the raw Ed25519 call.
#include "siegeseal/party.hpp"
#include "siegeseal/version.hpp"

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <string>
#include <vector>

using namespace siegeseal;
using Clock = std::chrono::steady_clock;

namespace {
constexpr std::uint64_t T0 = 1'800'000'000;

template <class F>
double time_ms(F&& f) {
    auto t = Clock::now();
    f();
    return std::chrono::duration<double, std::milli>(Clock::now() - t).count();
}

void row(const char* what, std::size_t n, double ms) {
    std::printf("  %-40s %8zu ops %9.1f ms %10.0f ops/s %8.2f us/op\n", what, n, ms, n / (ms / 1000.0),
                ms * 1000.0 / static_cast<double>(n));
}

// Keep results observable so the optimizer cannot discard the work.
volatile std::size_t sink = 0;
}  // namespace

int main(int argc, char** argv) {
    if (argc > 1 && (std::string(argv[1]) == "--version" || std::string(argv[1]) == "-V")) {
        std::printf("%s\n", version_line());
        return 0;
    }
    if (argc > 1 && (std::string(argv[1]) == "--help" || std::string(argv[1]) == "-h")) {
        std::printf("usage: siegeseal_bench [messages]   (default 20000)\n");
        return 0;
    }
    char* end = nullptr;
    const std::size_t N = argc > 1 ? std::strtoull(argv[1], &end, 10) : 20000;
    if (argc > 1 && (*end != '\0' || N == 0)) {
        std::fprintf(stderr, "siegeseal_bench: messages must be a positive number\n");
        return 2;
    }
    std::printf("SiegeSeal benchmark, %zu messages\n\n", N);

    Party a("Aurelia", SigningKey::generate()), b("Borealis", SigningKey::generate());
    a.trust("Borealis", b.public_key());
    b.trust("Aurelia", a.public_key());

    // 1. Seal letters.
    std::vector<Bytes> wires;
    wires.reserve(N);
    double ms = time_ms([&] {
        for (std::size_t i = 0; i < N; ++i)
            wires.push_back(a.compose("Borealis", "Strike the north gate at dawn, wave " + std::to_string(i), T0).encode());
    });
    row("compose + sign + encode", N, ms);

    // 2. Receive: parse, verify, replay/order checks, archive, signed receipt.
    std::vector<Bytes> receipts;
    receipts.reserve(N);
    ms = time_ms([&] {
        for (const auto& w : wires) {
            Verdict v = b.receive(w, T0);
            if (v.receipt) receipts.push_back(v.receipt->encode());
        }
    });
    row("receive (verify + checks + receipt)", N, ms);
    if (receipts.size() != N) { std::fprintf(stderr, "unexpected rejection\n"); return 1; }

    // 3. Receipts coming back, matched against everything the sender has sent.
    std::size_t ok = 0;
    ms = time_ms([&] { for (const auto& r : receipts) ok += a.accept_receipt(r); });
    row("accept_receipt (match among all sent)", N, ms);
    sink += ok;

    // 4. Rejecting tampered letters must cost no more than accepting good ones.
    Party c("Cyrene", SigningKey::generate());
    c.trust("Aurelia", a.public_key());
    std::size_t rejected = 0;
    ms = time_ms([&] {
        for (auto w : wires) {
            w[w.size() - 70] ^= 1;  // flip a payload bit
            rejected += c.receive(w, T0).status == Status::BadSignature;
        }
    });
    row("reject tampered letter", N, ms);
    sink += rejected;

    // 5. Tribunal: scan the pooled archive for equivocation.
    std::vector<Envelope> pool(b.archive().begin(), b.archive().end());
    std::size_t forks = 0;
    ms = time_ms([&] { forks = find_equivocations(b.directory(), pool).size(); });
    row("find_equivocations over archive", pool.size(), ms);
    sink += forks;

    std::printf("\n  accepted %zu, receipts matched %zu, tampered rejected %zu, forks %zu\n", receipts.size(), ok, rejected, forks);
    return (ok == N && rejected == N && forks == 0) ? 0 : 1;
}
