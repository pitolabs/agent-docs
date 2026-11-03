#!/bin/sh
# Runs the gitleaks pinned below and nothing else: the release binary for this platform, downloaded once into the
# user cache and checked against the sha256 published with the release. Not a gitleaks found on PATH (another
# version, other default rules) and not `go run`/docker. Used by scripts/privacy-scan.sh.
set -eu
VERSION=8.30.1
os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  arm64 | aarch64) arch=arm64 ;;
  *) arch=$(uname -m) ;;
esac
# From https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_checksums.txt
case "$os-$arch" in
  darwin-arm64) sum=b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
  darwin-x64) sum=dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
  linux-arm64) sum=e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080 ;;
  linux-x64) sum=551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
  *)
    echo "gitleaks: no pinned build for $os-$arch" >&2
    exit 1
    ;;
esac
dir="${XDG_CACHE_HOME:-$HOME/.cache}/gitleaks/$VERSION"
bin="$dir/gitleaks"
if [ ! -x "$bin" ]; then
  mkdir -p "$dir"
  tmp=$(mktemp -d)
  trap 'rm -rf "$tmp"' EXIT
  url="https://github.com/gitleaks/gitleaks/releases/download/v$VERSION/gitleaks_${VERSION}_${os}_${arch}.tar.gz"
  curl -fsSL "$url" -o "$tmp/gitleaks.tar.gz"
  got=$({ sha256sum "$tmp/gitleaks.tar.gz" 2>/dev/null || shasum -a 256 "$tmp/gitleaks.tar.gz"; } | awk '{print $1}')
  if [ "$got" != "$sum" ]; then
    echo "gitleaks: $url has sha256 $got, expected $sum; not running it" >&2
    exit 1
  fi
  tar -xzf "$tmp/gitleaks.tar.gz" -C "$tmp" gitleaks
  chmod +x "$tmp/gitleaks"
  mv "$tmp/gitleaks" "$bin"
fi
exec "$bin" "$@"
