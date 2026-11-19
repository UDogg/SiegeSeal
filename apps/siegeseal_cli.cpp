// siegeseal — command-line tool for signing and verifying real files.
//
//   siegeseal keygen <name>                       -> <name>.seal (secret), <name>.pub
//   siegeseal fingerprint <name.pub>
//   siegeseal sign <name.seal> <file>             -> <file>.sig
//   siegeseal verify <name.pub> <file> [<sig>]    exit 0 = genuine, 1 = not
//   siegeseal verify-envelope <sender.pub> <envelope.hex>
//                                                 checks a letter exported from the web app
#include "siegeseal/crypto.hpp"
#include "siegeseal/protocol.hpp"
#include "siegeseal/version.hpp"

#include <cstring>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <sstream>

using namespace siegeseal;
namespace fs = std::filesystem;

namespace {
constexpr const char* kFileTag = "SIEGESEAL/FILE/v1";

Bytes read_file(const std::string& path) {
    std::ifstream in(path, std::ios::binary);
    if (!in) throw std::runtime_error("cannot open " + path);
    return Bytes(std::istreambuf_iterator<char>(in), {});
}

// "<kind> <name> <hex>"
std::pair<std::string, Bytes> read_keyfile(const std::string& path, const std::string& kind) {
    std::ifstream in(path);
    std::string k, name, hex;
    if (!(in >> k >> name >> hex) || k != kind)
        throw std::runtime_error(path + " is not a " + kind + " file");
    return {name, from_hex(hex)};
}

Bytes message_for(const Bytes& content) {
    Bytes m(kFileTag, kFileTag + std::strlen(kFileTag));
    m.push_back(0);
    m.insert(m.end(), content.begin(), content.end());
    return m;
}

int usage(std::ostream& out = std::cerr, int code = 2) {
    out << "usage:\n"
                 "  siegeseal keygen <name>\n"
                 "  siegeseal fingerprint <name.pub>\n"
                 "  siegeseal sign <name.seal> <file>\n"
                 "  siegeseal verify <name.pub> <file> [<file.sig>]\n"
                 "  siegeseal verify-envelope <sender.pub> <envelope.hex>\n"
                 "  siegeseal --version | --help\n";
    return code;
}
}  // namespace

int main(int argc, char** argv) {
    if (argc < 2) return usage();
    std::string cmd = argv[1];
    if (cmd == "--version" || cmd == "-V") { std::cout << version_line() << "\n"; return 0; }
    if (cmd == "--help" || cmd == "-h") return usage(std::cout, 0);
    try {
        if (cmd == "keygen" && argc == 3) {
            std::string name = argv[2];
            SigningKey key = SigningKey::generate();
            std::string secret = name + ".seal", pub = name + ".pub";
            if (fs::exists(secret)) throw std::runtime_error(secret + " already exists; refusing to overwrite");
            {
                std::ofstream out(secret);
                out << "siegeseal-secret " << name << " " << to_hex(key.seed()) << "\n";
            }
            fs::permissions(secret, fs::perms::owner_read | fs::perms::owner_write, fs::perm_options::replace);
            std::ofstream(pub) << "siegeseal-public " << name << " " << to_hex(key.public_key()) << "\n";
            std::cout << "wrote " << secret << " (keep private) and " << pub << "\n"
                      << "fingerprint: " << fingerprint(key.public_key()) << "\n";
            return 0;
        }
        if (cmd == "fingerprint" && argc == 3) {
            auto [name, raw] = read_keyfile(argv[2], "siegeseal-public");
            PublicKey pk{};
            if (raw.size() != pk.size()) throw std::runtime_error("bad public key length");
            std::copy(raw.begin(), raw.end(), pk.begin());
            std::cout << name << "  " << fingerprint(pk) << "\n";
            return 0;
        }
        if (cmd == "sign" && argc == 4) {
            auto [name, seed] = read_keyfile(argv[2], "siegeseal-secret");
            SigningKey key = SigningKey::from_seed(seed);
            Signature sig = key.sign(message_for(read_file(argv[3])));
            std::string out = std::string(argv[3]) + ".sig";
            std::ofstream(out) << "siegeseal-signature " << name << " " << to_hex(sig) << "\n";
            std::cout << "signed by " << name << " -> " << out << "\n";
            return 0;
        }
        if (cmd == "verify" && (argc == 4 || argc == 5)) {
            auto [name, raw] = read_keyfile(argv[2], "siegeseal-public");
            std::string sigpath = argc == 5 ? argv[4] : std::string(argv[3]) + ".sig";
            auto [signer, sraw] = read_keyfile(sigpath, "siegeseal-signature");
            PublicKey pk{};
            Signature sig{};
            if (raw.size() != pk.size() || sraw.size() != sig.size())
                throw std::runtime_error("bad key or signature length");
            std::copy(raw.begin(), raw.end(), pk.begin());
            std::copy(sraw.begin(), sraw.end(), sig.begin());
            bool ok = ed25519_verify(pk, message_for(read_file(argv[3])), sig);
            if (ok)
                std::cout << "GENUINE: " << argv[3] << " was signed by " << name << " ["
                          << fingerprint(pk) << "] and has not been altered\n";
            else
                std::cout << "REJECTED: signature does not match " << name
                          << "'s key — file altered or not signed by them\n";
            return ok ? 0 : 1;
        }
        if (cmd == "verify-envelope" && argc == 4) {
            auto [name, raw] = read_keyfile(argv[2], "siegeseal-public");
            PublicKey pk{};
            if (raw.size() != pk.size()) throw std::runtime_error("bad public key length");
            std::copy(raw.begin(), raw.end(), pk.begin());
            std::ifstream in(argv[3]);
            std::string hex;
            in >> hex;
            Envelope e = Envelope::decode(from_hex(hex));
            KeyDirectory dir;
            dir.add(name, pk);
            bool ok = e.sender == name && verify_envelope(dir, e);
            std::cout << "from:    " << e.sender << "\n"
                      << "to:      " << e.recipient << "\n"
                      << "seq:     " << e.seq << "\n"
                      << "time:    " << e.timestamp << "\n"
                      << "text:    " << e.payload << "\n"
                      << "digest:  " << to_hex(e.digest()) << "\n";
            if (ok)
                std::cout << "GENUINE: sealed by " << name << " [" << fingerprint(pk) << "]\n";
            else if (e.sender != name)
                std::cout << "REJECTED: letter claims to be from " << e.sender << ", but the key given is " << name << "'s\n";
            else
                std::cout << "REJECTED: signature does not match " << name << "'s key\n";
            return ok ? 0 : 1;
        }
    } catch (const std::exception& e) {
        std::cerr << "error: " << e.what() << "\n";
        return 2;
    }
    return usage();
}
