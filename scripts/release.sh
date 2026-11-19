#!/bin/sh
# Build a SiegeSeal release: hardened binaries, tested, packaged and checksummed.
#
#   scripts/release.sh [output-dir]           (default: dist/)
#
# Produces in the output directory:
#   siegeseal-<ver>-linux-x86_64-static.tar.gz  fully static tools: run on any x86-64 Linux
#   siegeseal-<ver>-linux-x86_64-static         the siegeseal CLI alone, as one executable
#   siegeseal-<ver>-linux-x86_64.tar.gz         glibc build: tools + library, headers, CMake package
#   siegeseal-<ver>-source.tar.gz               the source tree
#   SHA256SUMS
#
# The static build needs Zig (`zig` on PATH, or `pip install ziglang`); set
# SIEGESEAL_SKIP_STATIC=1 to build only the glibc variant.
set -eu

root=$(cd "$(dirname "$0")/.." && pwd)
out=${1:-"$root/dist"}
jobs=$(nproc 2>/dev/null || echo 2)
version=$(sed -n 's/^  VERSION \([0-9.]*\)$/\1/p' "$root/CMakeLists.txt")
mkdir -p "$out"
rm -f "$out"/siegeseal-* "$out/SHA256SUMS"

build_variant() { # <build-dir> <cmake args...>
  dir=$1; shift
  echo "==> [$(basename "$dir")] configure, build, test"
  cmake --fresh -S "$root" -B "$dir" -DCMAKE_BUILD_TYPE=Release -DSIEGESEAL_HARDEN=ON -DSIEGESEAL_RELEASE_LAYOUT=ON "$@" > /dev/null
  cmake --build "$dir" -j "$jobs" > "$dir.build.log" 2>&1 || { tail -30 "$dir.build.log"; exit 1; }
  ctest --test-dir "$dir" --output-on-failure > "$dir.test.log" 2>&1 || { cat "$dir.test.log"; exit 1; }
  grep -E "tests passed" "$dir.test.log"
  (cd "$dir" && cpack -G TGZ -B "$out" > /dev/null)
}

verify_tarball() { # <tarball> <glibc|static>
  echo "==> verify $(basename "$1")"
  check=$(mktemp -d)
  tar -xzf "$1" -C "$check"
  pkg=$(find "$check" -mindepth 1 -maxdepth 1 -type d)
  "$pkg/bin/siegeseal" --version
  sh "$root/tests/cli_roundtrip.sh" "$pkg/bin/siegeseal" > /dev/null
  "$pkg/bin/siege_sim" --no-color | grep -q "EQUIVOCATION by Cyrene"
  "$pkg/bin/siegeseal_bench" 200 > /dev/null
  for b in "$pkg"/bin/*; do
    deps=$(readelf -d "$b" 2> /dev/null | sed -n 's/.*(NEEDED).*\[\(.*\)\]/\1/p' | tr '\n' ' ')
    interp=$(readelf -lW "$b" | grep -c "Requesting program interpreter" || true)
    case "$2" in
      static) [ -z "$deps" ] && [ "$interp" = 0 ] || { echo "$(basename "$b") is not fully static ($deps)" >&2; exit 1; } ;;
      glibc) case "$deps" in *libssl*|*libcrypto*|*libstdc++*|*libgcc_s*) echo "$(basename "$b") depends on: $deps" >&2; exit 1;; esac ;;
    esac
    readelf -h "$b" | grep -q "DYN (Position-Independent" || { echo "$(basename "$b") is not PIE" >&2; exit 1; }
  done
  rm -rf "$check"
}

# ---- glibc variant: OpenSSL and the C++ runtime linked statically, glibc shared --
build_variant "$root/build-release" -DSIEGESEAL_PORTABLE=ON
verify_tarball "$out/siegeseal-$version-linux-x86_64.tar.gz" glibc

# ---- fully static variant: musl, built with Zig -----------------------------------
if [ "${SIEGESEAL_SKIP_STATIC:-0}" != 1 ]; then
  . "$root/scripts/zig-wrappers.sh"
  zdir="$root/build-static-toolchain"
  make_zig_wrappers "$zdir/zig"
  echo "==> OpenSSL for musl"
  ossl=$(sh "$root/scripts/build-openssl-musl.sh" "$zdir")
  build_variant "$root/build-static" -DSIEGESEAL_FULLY_STATIC=ON \
    -DCMAKE_CXX_COMPILER="$zdir/zig/zc++" \
    -DCMAKE_AR="$zdir/zig/zar" -DCMAKE_RANLIB="$zdir/zig/zranlib" \
    -DOPENSSL_ROOT_DIR="$ossl" -DOPENSSL_INCLUDE_DIR="$ossl/include" \
    -DOPENSSL_CRYPTO_LIBRARY="$ossl/libcrypto.a" -DOPENSSL_SSL_LIBRARY="$ossl/libcrypto.a"
  static_tgz="$out/siegeseal-$version-linux-x86_64-static.tar.gz"
  verify_tarball "$static_tgz" static
  # The CLI on its own, for curl-and-run use.
  tar -xzf "$static_tgz" -O "siegeseal-$version-linux-x86_64-static/bin/siegeseal" > "$out/siegeseal-$version-linux-x86_64-static"
  chmod 755 "$out/siegeseal-$version-linux-x86_64-static"
fi

# ---- source ------------------------------------------------------------------------
echo "==> source tarball"
(cd "$root/build-release" && cpack --config CPackSourceConfig.cmake -B "$out" > /dev/null)
rm -rf "$out/_CPack_Packages" "$out"/*.sha256

(cd "$out" && sha256sum siegeseal-* > SHA256SUMS)
echo
echo "Release $version in $out:"
(cd "$out" && ls -l siegeseal-* SHA256SUMS | awk '{print $5, $9}' && echo && cat SHA256SUMS)
