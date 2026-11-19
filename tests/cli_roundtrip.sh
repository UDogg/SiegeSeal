#!/bin/sh
# End-to-end check of the siegeseal CLI: keys, signing, verifying, tampering.
#   cli_roundtrip.sh /path/to/siegeseal
set -eu
cli="$1"
dir=$(mktemp -d)
trap 'rm -rf "$dir"' EXIT
cd "$dir"

"$cli" --version | grep -q '^SiegeSeal [0-9]'
"$cli" keygen aurelia > /dev/null
[ "$(stat -c %a aurelia.seal)" = 600 ] || { echo "secret key is not mode 600"; exit 1; }
if "$cli" keygen aurelia > /dev/null 2>&1; then echo "keygen overwrote an existing key"; exit 1; fi

printf 'Strike the north gate at DAWN on day 3.\n' > orders.txt
"$cli" sign aurelia.seal orders.txt > /dev/null
"$cli" verify aurelia.pub orders.txt | grep -q '^GENUINE'

sed 's/DAWN/DUSK/' orders.txt > tampered.txt && cp orders.txt.sig tampered.txt.sig
if "$cli" verify aurelia.pub tampered.txt > /dev/null; then echo "tampered file verified"; exit 1; fi

"$cli" keygen vharos > /dev/null
if "$cli" verify vharos.pub orders.txt orders.txt.sig > /dev/null; then echo "wrong key verified"; exit 1; fi

if "$cli" nonsense > /dev/null 2>&1; then echo "bad command accepted"; exit 1; fi
echo "cli round trip ok"
