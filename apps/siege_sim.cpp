// The Siege of Vharos — an executable story.
//
// Three armies (Aurelia, Borealis, Cyrene) plan to besiege the city of Vharos.
// Every courier between them must ride past the city walls, so Vharos can
// stop, read, rewrite, forge, replay, reroute or kill any message. The allies
// also do not trust each other: any of them might later deny an order, or
// tell different allies different stories.
//
// Act I shows what happens with plain letters. Acts II–V run the same
// campaign with SiegeSeal and show every attack being caught — and finally a
// tribunal where signed evidence settles who lied.

#include "siegeseal/party.hpp"
#include "siegeseal/version.hpp"
#include "siegeseal/wire.hpp"

#include <cstdlib>
#include <cstring>
#include <unistd.h>
#include <functional>
#include <iomanip>
#include <iostream>
#include <sstream>
#include <string>

using namespace siegeseal;

// ---- presentation -----------------------------------------------------------
namespace ui {
bool color = true;
std::string c(const char* code, const std::string& s) {
    return color ? std::string("\033[") + code + "m" + s + "\033[0m" : s;
}
std::string bold(const std::string& s) { return c("1", s); }
std::string dim(const std::string& s) { return c("2", s); }
std::string red(const std::string& s) { return c("31", s); }
std::string green(const std::string& s) { return c("32", s); }
std::string yellow(const std::string& s) { return c("33", s); }
std::string cyan(const std::string& s) { return c("36", s); }

void act(const std::string& title) {
    std::string rule;
    for (std::size_t i = title.size(); i < 64; ++i) rule += "━";
    std::cout << "\n" << bold(cyan("━━━ " + title + " " + rule)) << "\n";
}
void scene(int n, const std::string& title) {
    std::cout << "\n" << bold("  [" + std::to_string(n) + "] " + title) << "\n";
}
void say(const std::string& s) { std::cout << "      " << s << "\n"; }
void city(const std::string& s) { std::cout << "      " << red("Vharos ▸ ") << s << "\n"; }

std::string clock(std::uint64_t t) {
    std::uint64_t h = (t / 3600) % 24, m = (t / 60) % 60;
    std::ostringstream os;
    os << "day " << (t / 86400) << " " << std::setw(2) << std::setfill('0') << h << ":"
       << std::setw(2) << std::setfill('0') << m;
    return os.str();
}

void verdict(const Party& who, const Verdict& v) {
    std::string tag = is_accepted(v.status)
                          ? (v.status == Status::Accepted ? green("✔ " + std::string(status_name(v.status)))
                                                          : yellow("⚠ " + std::string(status_name(v.status))))
                          : red("✘ " + std::string(status_name(v.status)));
    std::cout << "      " << bold(who.name()) << " " << tag << dim(" — " + v.detail) << "\n";
    if (v.envelope)
        std::cout << "      " << dim("  reads: ") << "\"" << v.envelope->payload << "\"\n";
}
}  // namespace ui

// ---- the road past the city walls -------------------------------------------
using Tamper = std::function<Bytes(Bytes)>;
const Tamper untouched = [](Bytes b) { return b; };

// Re-encode an envelope with one field changed, the way a scribe in the city
// would rewrite a letter and re-seal it with wax of their own.
Bytes rewrite(const Bytes& wire, const std::function<void(Envelope&)>& edit) {
    Envelope e = Envelope::decode(wire);
    edit(e);
    return e.encode();
}

// Deliver via courier; the recipient returns a receipt by courier too.
Verdict ride(Party& from, Party& to, const Envelope& e, std::uint64_t now,
             const Tamper& on_the_way = untouched, bool receipt_reaches_home = true) {
    Bytes wire = on_the_way(e.encode());
    Verdict v = to.receive(wire, now);
    ui::verdict(to, v);
    if (v.receipt && receipt_reaches_home) from.accept_receipt(v.receipt->encode());
    return v;
}

int main(int argc, char** argv) {
    for (int i = 1; i < argc; ++i) {
        if (std::strcmp(argv[i], "--no-color") == 0) ui::color = false;
        else if (std::strcmp(argv[i], "--version") == 0 || std::strcmp(argv[i], "-V") == 0) {
            std::cout << siegeseal::version_line() << "\n";
            return 0;
        } else if (std::strcmp(argv[i], "--help") == 0 || std::strcmp(argv[i], "-h") == 0) {
            std::cout << "usage: siege_sim [--no-color] [--version] [--help]\n"
                         "Runs the Siege of Vharos: three armies, one city, every attack on the road.\n";
            return 0;
        } else {
            std::cerr << "siege_sim: unknown option '" << argv[i] << "' (try --help)\n";
            return 2;
        }
    }
    // Plain output when piped or when NO_COLOR is set (https://no-color.org).
    if (std::getenv("NO_COLOR") || !isatty(STDOUT_FILENO)) ui::color = false;

    std::uint64_t now = 86400 + 6 * 3600;  // day 1, 06:00

    std::cout << ui::bold("\n  THE SIEGE OF VHAROS") << ui::dim("  —  a non-repudiation demonstration\n");
    std::cout << ui::dim("  Three armies. One city. Every courier rides past the walls.\n");

    // ======================================================================
    ui::act("ACT I · Plain letters");
    // ======================================================================
    {
        std::string letter = "Aurelia to Borealis: all armies strike the north gate at DAWN on day 3.";
        ui::say("Aurelia writes:  \"" + letter + "\"");
        ui::city("stops the courier, scrapes the ink, writes " + ui::red("DUSK") + " instead.");
        std::string altered = letter;
        altered.replace(altered.find("DAWN"), 4, "DUSK");
        ui::say("Borealis reads:  \"" + altered + "\"");
        ui::say(ui::dim("Borealis has no way to tell. The handwriting is good; the wax is plausible."));
        ui::say("Day 3: Aurelia and Cyrene attack at dawn and are cut down without support.");
        ui::say("Borealis arrives at dusk to an empty field. Each army blames the others.");
        ui::say(ui::bold("Vharos wins by editing a single word."));
    }

    // ======================================================================
    ui::act("ACT II · The seal ceremony");
    // ======================================================================
    Party aurelia("Aurelia", SigningKey::generate());
    Party borealis("Borealis", SigningKey::generate());
    Party cyrene("Cyrene", SigningKey::generate());
    Party* armies[] = {&aurelia, &borealis, &cyrene};

    ui::say("Before the campaign the three commanders meet in person on neutral ground.");
    ui::say("Each forges a private seal (Ed25519 key) that never leaves their tent, and");
    ui::say("hands the others its public impression. They read fingerprints aloud:");
    for (Party* p : armies)
        std::cout << "        " << std::left << std::setw(10) << p->name()
                  << ui::yellow(fingerprint(p->public_key())) << "\n";
    for (Party* a : armies)
        for (Party* b : armies)
            if (a != b) a->trust(b->name(), b->public_key());
    ui::say(ui::dim("This face-to-face exchange is the trust anchor. Vharos was not in the room."));

    // ======================================================================
    ui::act("ACT III · The treaty");
    // ======================================================================
    Treaty treaty;
    treaty.terms =
        "The armies of Aurelia, Borealis and Cyrene will jointly besiege Vharos. "
        "No party treats separately with the city. Spoils divided equally.";
    treaty.parties = {"Aurelia", "Borealis", "Cyrene"};
    ui::say("Terms: \"" + treaty.terms + "\"");
    aurelia.sign_treaty(treaty);
    borealis.sign_treaty(treaty);
    std::vector<std::string> missing;
    verify_treaty(aurelia.directory(), treaty, &missing);
    ui::say("After two signatures, binding? " + ui::yellow("no") + ui::dim(" — still missing: " + missing[0]));
    cyrene.sign_treaty(treaty);
    ui::say("After all three, binding? " +
            (verify_treaty(aurelia.directory(), treaty) ? ui::green("yes") : ui::red("no")));

    Treaty forged = treaty;
    forged.terms.replace(forged.terms.find("divided equally"), 15, "to Borealis alone");
    ui::city("copies the treaty and changes the spoils clause to stir resentment.");
    ui::say("Doctored treaty binding? " +
            (verify_treaty(cyrene.directory(), forged) ? ui::green("yes") : ui::red("no — all three signatures break")));

    // ======================================================================
    ui::act("ACT IV · The campaign (Vharos attacks every road)");
    // ======================================================================
    int n = 0;

    ui::scene(++n, "Honest delivery");
    Envelope plan = aurelia.compose("Borealis", "Strike the north gate at DAWN on day 3.", now);
    ui::say(ui::dim("Aurelia → Borealis, seq " + std::to_string(plan.seq) + ", " + ui::clock(now)));
    Verdict honest = ride(aurelia, borealis, plan, now);

    ui::scene(++n, "Tampering: change one word");
    now += 600;
    Envelope plan_c = aurelia.compose("Cyrene", "Strike the north gate at DAWN on day 3.", now);
    ui::city("rewrites DAWN → DUSK in the letter to Cyrene.");
    ride(aurelia, cyrene, plan_c, now, [](Bytes w) {
        return rewrite(w, [](Envelope& e) { e.payload.replace(e.payload.find("DAWN"), 4, "DUSK"); });
    });
    ui::say(ui::dim("Cyrene discards it. Aurelia gets no receipt and will know to resend."));

    ui::scene(++n, "Forgery: impersonate an ally");
    now += 600;
    {
        SigningKey city_key = SigningKey::generate();
        Envelope fake;
        fake.sender = "Cyrene";
        fake.recipient = "Borealis";
        fake.seq = 1;
        fake.timestamp = now;
        fake.payload = "Cyrene to Borealis: Aurelia has betrayed us. Withdraw your army.";
        fake.sig = city_key.sign(fake.signed_bytes());
        ui::city("writes a letter in Cyrene's name and seals it with the city's own wax.");
        Verdict v = borealis.receive(fake.encode(), now);
        ui::verdict(borealis, v);
    }

    ui::scene(++n, "Unknown seal: a 'deserter' writes in");
    {
        SigningKey city_key = SigningKey::generate();
        Envelope fake;
        fake.sender = "Captain of the Vharos Guard";
        fake.recipient = "Aurelia";
        fake.seq = 1;
        fake.timestamp = now;
        fake.payload = "I will open the south postern at midnight. Bring only a small force.";
        fake.sig = city_key.sign(fake.signed_bytes());
        ui::city("sends a signed offer of betrayal — a trap.");
        ui::verdict(aurelia, aurelia.receive(fake.encode(), now));
        ui::say(ui::dim("A valid signature from a stranger proves only that a stranger wrote it."));
    }

    ui::scene(++n, "Replay: resend a genuine old order");
    now += 1800;
    Envelope hold = borealis.compose("Aurelia", "Hold position. Do not advance until my signal.", now);
    ui::say(ui::dim("Borealis → Aurelia, genuine order, " + ui::clock(now)));
    Bytes captured = hold.encode();
    ride(borealis, aurelia, hold, now);
    now += 3600;
    Envelope go = borealis.compose("Aurelia", "Signal given. Advance now.", now);
    ride(borealis, aurelia, go, now);
    ui::city("re-delivers the captured \"Hold position\" letter, hoping Aurelia stalls.");
    ui::verdict(aurelia, aurelia.receive(captured, now + 60));

    ui::scene(++n, "Rerouting: deliver a real letter to the wrong ally");
    now += 600;
    Envelope private_note = aurelia.compose("Borealis", "Your cavalry takes the east flank; Cyrene's archers cover you.", now);
    ui::city("diverts Aurelia's letter for Borealis to Cyrene instead.");
    ui::verdict(cyrene, cyrene.receive(private_note.encode(), now));
    ui::say(ui::dim("The signature is real, but it covers the recipient's name too."));
    ride(aurelia, borealis, private_note, now);

    ui::scene(++n, "Killing the courier");
    now += 900;
    Envelope lost = cyrene.compose("Borealis", "Archers in place on the ridge.", now);
    ui::city("ambushes Cyrene's courier. The letter to Borealis is burned.");
    now += 900;
    Envelope next = cyrene.compose("Borealis", "Ridge secured; awaiting dawn.", now);
    ride(cyrene, borealis, next, now);
    ui::say(ui::dim("Borealis knows exactly which message is missing."));
    ui::say("Cyrene's unacknowledged letters: ");
    for (const auto& e : cyrene.unacknowledged())
        if (e.recipient == "Borealis")
            std::cout << "        " << ui::yellow("seq " + std::to_string(e.seq)) << " \"" << e.payload << "\"\n";
    (void)lost;

    ui::scene(++n, "Delay: hold a letter until it is useless");
    Envelope urgent = borealis.compose("Cyrene", "Gate is weak — attack within the hour!", now);
    ui::city("detains the courier for eight hours, then lets him go.");
    ride(borealis, cyrene, urgent, now + 8 * 3600);

    ui::scene(++n, "Fake receipt: pretend a letter arrived");
    now += 600;
    Envelope ping = aurelia.compose("Cyrene", "Confirm you received the revised plan.", now);
    ui::city("kills the courier and sends Aurelia a receipt 'from Cyrene'.");
    {
        Receipt fake;
        fake.receiver = "Cyrene";
        fake.original_sender = "Aurelia";
        fake.envelope_digest = ping.digest();
        fake.received_at = now;
        fake.sig = SigningKey::generate().sign(fake.signed_bytes());
        bool ok = aurelia.accept_receipt(fake.encode());
        ui::say(std::string("Aurelia accepts receipt? ") + (ok ? ui::green("yes") : ui::red("no — not Cyrene's seal")));
    }

    ui::scene(++n, "Garbage on the wire");
    {
        Bytes wire = plan.encode();
        wire.resize(wire.size() / 2);
        ui::city("delivers half a letter, smeared and torn.");
        ui::verdict(borealis, borealis.receive(wire, now));
    }

    // ======================================================================
    ui::act("ACT V · The tribunal (the allies don't trust each other)");
    // ======================================================================
    ui::say("Day 3 goes badly. The commanders convene. Each brings only signed evidence;");
    ui::say("anyone holding the three public seals can check it, no trust in the bearer needed.");

    ui::scene(++n, "\"I never promised that\" — non-repudiation of origin");
    now += 3600;
    Envelope promise = borealis.compose("Aurelia", "Borealis will breach the EAST gate at dawn. You have my word.", now);
    ride(borealis, aurelia, promise, now);
    ui::say("Borealis never breached the east gate, and now claims the letter is a city forgery.");
    ui::say("Aurelia lays it before the tribunal. Checked against Borealis's seal: " +
            (verify_envelope(cyrene.directory(), promise) ? ui::green("GENUINE") : ui::red("forged")));
    ui::say(ui::dim("Only Borealis's private seal can produce that signature. The denial fails."));

    ui::scene(++n, "\"I never got your order\" — non-repudiation of receipt");
    ui::say("Borealis then claims Aurelia's DAWN order never reached him.");
    ui::say("Aurelia produces Borealis's own signed receipt for envelope " +
            ui::yellow(to_hex(honest.receipt->envelope_digest).substr(0, 16) + "…") + ":");
    ui::say("Receipt valid: " +
            (verify_receipt(cyrene.directory(), *honest.receipt) ? ui::green("yes") : ui::red("no")) +
            ",  matches the DAWN order: " +
            (honest.receipt->envelope_digest == plan.digest() ? ui::green("yes") : ui::red("no")));

    ui::scene(++n, "A doctored exhibit");
    {
        Envelope exhibit = Envelope::decode(go.encode());
        exhibit.payload = "Aurelia ordered all armies to retreat.";
        exhibit.sender = "Aurelia";
        ui::say("Borealis presents a letter 'from Aurelia' ordering retreat, to excuse himself.");
        ui::say("Checked against Aurelia's seal: " +
                (verify_envelope(cyrene.directory(), exhibit) ? ui::green("GENUINE") : ui::red("FORGED — exhibit rejected")));
    }

    ui::scene(++n, "Two faces — catching equivocation");
    {
        // Cyrene secretly hedges: tells Aurelia one thing and Borealis another,
        // writing both letters as if each were her next and only message.
        Digest head = cyrene.sent().back().digest();
        Envelope to_a = cyrene.compose_at("Aurelia", "Cyrene attacks the WEST wall at dawn.", now, head);
        Envelope to_b = cyrene.compose_at("Borealis", "Cyrene holds back; let Aurelia bleed first.", now, head);
        ride(cyrene, aurelia, to_a, now);
        ride(cyrene, borealis, to_b, now);
        ui::say("Each letter alone is valid. The tribunal pools every archived letter:");
        std::vector<Envelope> pool;
        for (Party* p : armies) pool.insert(pool.end(), p->archive().begin(), p->archive().end());
        auto forks = find_equivocations(aurelia.directory(), pool);
        for (const auto& f : forks) {
            ui::say(ui::red("✘ EQUIVOCATION by " + f.sender) + " — two signed letters claim the same place in her chain:");
            std::cout << "          to " << f.first.recipient << ": \"" << f.first.payload << "\"\n";
            std::cout << "          to " << f.second.recipient << ": \"" << f.second.payload << "\"\n";
        }
        if (forks.empty()) ui::say("no equivocation found");
    }

    // ======================================================================
    ui::act("Verdict");
    // ======================================================================
    ui::say("Vharos could read every letter, but could not change one word, forge one seal,");
    ui::say("replay one order, reroute one letter, or hide one ambush without it being noticed.");
    ui::say("And among the allies, no one could deny what they signed, deny what they");
    ui::say("received, or tell two allies two different stories without signed proof of it.");
    ui::say(ui::dim("(Secrecy is a separate problem: SiegeSeal provides integrity and accountability,"));
    ui::say(ui::dim(" not confidentiality. See README for how encryption would layer on top.)"));
    std::cout << "\n";
    return 0;
}
