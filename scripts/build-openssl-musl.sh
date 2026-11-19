#!/bin/sh
# Build a static OpenSSL libcrypto for x86_64 musl with Zig, for fully static releases.
#
#   scripts/build-openssl-musl.sh <work-dir>
#
# Downloads a pinned OpenSSL release, checks it against a pinned SHA-256, and
# builds libcrypto.a. Prints the OpenSSL tree's path on success. Needs: curl,
# perl, make, and Zig (`zig` on PATH, or `pip install ziglang`).
set -eu
OPENSSL_VERSION=3.0.17
OPENSSL_SHA256=dfdd77e4ea1b57ff3a6dbde6b0bdc3f31db5ac99e7fdd4eaf9e1fbb6ec2db8ce

work=$(mkdir -p "$1" && cd "$1" && pwd)
src="$work/openssl-$OPENSSL_VERSION"
[ -f "$src/libcrypto.a" ] && { echo "$src"; exit 0; }

. "$(dirname "$0")/zig-wrappers.sh"
make_zig_wrappers "$work/zig"

tarball="$work/openssl-$OPENSSL_VERSION.tar.gz"
if [ ! -f "$tarball" ]; then
  curl -sSfL -o "$tarball.part" \
    "https://github.com/openssl/openssl/releases/download/openssl-$OPENSSL_VERSION/openssl-$OPENSSL_VERSION.tar.gz"
  mv "$tarball.part" "$tarball"
fi
echo "$OPENSSL_SHA256  $tarball" | sha256sum -c - > /dev/null || { echo "OpenSSL checksum mismatch" >&2; exit 1; }

tar -xzf "$tarball" -C "$work"
cd "$src"
CC="$work/zig/zcc" AR="$work/zig/zar" RANLIB="$work/zig/zranlib" ./Configure linux-x86_64 \
  no-shared no-module no-dso no-engine no-async no-tests no-afalgeng no-ui-console \
  -fPIE -fstack-protector-strong -ffunction-sections -fdata-sections --openssldir=/etc/ssl > configure.log 2>&1
make -j"$(nproc 2>/dev/null || echo 2)" build_generated libcrypto.a > make.log 2>&1
echo "$src"
