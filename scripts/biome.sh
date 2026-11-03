#!/bin/sh
# Runs the Biome pinned in package.json, from this checkout's node_modules, and nothing else. Not `bunx`/`npx biome`
# (they download whatever npm has under that name; `biome` on npm is an unrelated package), not `npm exec`, and not a
# bare `biome` or `bun run biome` (both fall back to PATH, where a global Biome of another version may be): without
# `bun install` this fails. Used by the package.json scripts and the pre-commit hook.
set -eu
root=$(cd "$(dirname "$0")/.." && pwd)
bin="$root/node_modules/@biomejs/biome/bin/biome"
if [ ! -f "$bin" ]; then
  echo "biome: $bin is missing; run bun install in $root" >&2
  exit 1
fi
want=$(bun --print "require('$root/package.json').devDependencies['@biomejs/biome']")
have=$(bun --print "require('$root/node_modules/@biomejs/biome/package.json').version")
if [ "$want" != "$have" ]; then
  echo "biome: node_modules has $have but package.json pins $want; run bun install in $root" >&2
  exit 1
fi
exec bun "$bin" "$@"
