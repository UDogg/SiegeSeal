# Sourced by the release scripts: make_zig_wrappers <dir> writes zcc/zc++/zar/zranlib
# that drive Zig as an x86_64-linux-musl cross toolchain.
make_zig_wrappers() {
  if command -v zig > /dev/null; then zig="zig"
  elif python3 -c "import ziglang" 2> /dev/null; then zig="python3 -m ziglang"
  else echo "Zig not found: install it, or run 'pip install ziglang'" >&2; return 1; fi
  mkdir -p "$1"
  printf '#!/bin/sh\nexec %s cc -target x86_64-linux-musl "$@"\n' "$zig" > "$1/zcc"
  printf '#!/bin/sh\nexec %s c++ -target x86_64-linux-musl "$@"\n' "$zig" > "$1/zc++"
  printf '#!/bin/sh\nexec %s ar "$@"\n' "$zig" > "$1/zar"
  printf '#!/bin/sh\nexec %s ranlib "$@"\n' "$zig" > "$1/zranlib"
  chmod +x "$1"/z*
}
