#!/bin/sh
# Refuses content that must not reach a public repository, with three checks:
#   1. gitleaks (pinned in mise.toml, from base-repo-standard): secrets with its default rules, plus the personal-data
#      rules in .gitleaks.toml (phone numbers, e-mail addresses, IP addresses, home-directory paths);
#   2. identities: every commit's author and committer e-mail must be a GitHub noreply address, since a public
#      repository publishes them;
#   3. private lists of exact text kept OUTSIDE the repository, one entry per line (# comments; entries shorter
#      than 4 characters are ignored), matched case-insensitively:
#      - the blocklist, personal data (names, phone numbers, e-mail addresses, hosts): $PRIVACY_BLOCKLIST, default
#        ~/.config/privacy/blocklist.txt; in CI its text comes from $PRIVACY_BLOCKLIST_TEXT (a repository secret);
#      - the local-only list, exact secret values (tokens, passwords) that must never be uploaded anywhere, CI
#        included: $PRIVACY_LOCAL_LIST, default ~/.config/privacy/local-only.txt, read when present.
#      Matches are reported by list and entry number, and every line printed (paths, gitleaks' report, e-mails) has
#      list entries replaced by ***, so no entry shows up in a terminal or a CI log.
#
#   privacy-scan.sh --staged            what is staged (pre-commit)
#   privacy-scan.sh --commits "<revs>"  commits given as git log arguments, e.g. "A..B" or "B --not --remotes=origin"
#                                       (pre-push: everything about to be published)
#   privacy-scan.sh --history           every commit on every ref (CI, and once before a repository goes public)
set -eu
mode=${1:-}
revs=${2:-}
top=$(git rev-parse --show-toplevel)
command -v mise >/dev/null || { echo "privacy-scan: mise is required (brew install mise)" >&2; exit 1; }
case "$mode" in
  --staged) ;;
  --commits) [ -n "$revs" ] || { echo "privacy-scan: --commits needs git log arguments" >&2; exit 2; } ;;
  --history) revs="--all" ;;
  *)
    echo "usage: privacy-scan.sh --staged | --commits \"<git log revs>\" | --history" >&2
    exit 2
    ;;
esac

failed=""
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# The private lists, loaded first: every line this script prints goes through `mask`, which replaces any entry with
# *** (a file named after a person, gitleaks' File: and Fingerprint: lines, an author e-mail that is itself an entry).
list="$tmp/blocklist"
default_list="${XDG_CONFIG_HOME:-$HOME/.config}/privacy/blocklist.txt"
if [ -n "${PRIVACY_BLOCKLIST_TEXT:-}" ]; then
  printf '%s\n' "$PRIVACY_BLOCKLIST_TEXT" >"$list"
elif [ "${PRIVACY_BLOCKLIST:-}" = none ]; then
  : >"$list"
elif [ -f "${PRIVACY_BLOCKLIST:-$default_list}" ]; then
  cp "${PRIVACY_BLOCKLIST:-$default_list}" "$list"
elif [ "${PRIVACY_BLOCKLIST_OPTIONAL:-false}" = true ]; then
  echo "privacy-scan: no blocklist here (a pull request from a fork gets no secrets); scanning without it" >&2
  : >"$list"
else
  echo "privacy-scan: no blocklist at ${PRIVACY_BLOCKLIST:-$default_list}. Create it outside any repository (one name," >&2
  echo "  number or host per line; it may be empty), or set PRIVACY_BLOCKLIST to another file. In CI, set the" >&2
  echo "  PRIVACY_BLOCKLIST repository secret." >&2
  exit 1
fi
local_list="${PRIVACY_LOCAL_LIST:-${XDG_CONFIG_HOME:-$HOME/.config}/privacy/local-only.txt}"
[ -f "$local_list" ] || local_list=/dev/null

# One awk library for both uses: load() reads the lists (trimmed, # comments and entries under 4 characters skipped,
# lower-cased), masked() replaces every entry in a string, case-insensitively.
cat >"$tmp/lists.awk" <<'AWK'
function load(path, name,   l, k) {
  k = 0
  while ((getline l < path) > 0) {
    sub(/\r$/, "", l); gsub(/^[ \t]+|[ \t]+$/, "", l)
    if (l == "" || l ~ /^#/) continue
    k++
    if (length(l) < 4) continue
    e[++n] = tolower(l); label[n] = name " entry " k
  }
}
function masked(s,   i, p, out, t) {
  for (i = 1; i <= n; i++) {
    out = ""; t = tolower(s)
    while ((p = index(t, e[i])) > 0) {
      out = out substr(s, 1, p - 1) "***"
      s = substr(s, p + length(e[i])); t = substr(t, p + length(e[i]))
    }
    s = out s
  }
  return s
}
AWK
# Programs go in files (several -f), not `awk -e`: macOS's awk has no -e.
# shellcheck disable=SC2016 # an awk program, not shell: $0 is awk's
echo 'BEGIN { load(list, "b"); load(local_list, "l") } { print masked($0) }' >"$tmp/mask.awk"
mask() { awk -v list="$list" -v local_list="$local_list" -f "$tmp/lists.awk" -f "$tmp/mask.awk"; }

# 1. gitleaks. .gitleaks.toml at the top of the repository is picked up automatically. `git log -p` shows no diff for a
# merge commit, so content that only a conflict resolution introduced would pass unseen: --diff-merges=first-parent
# diffs each merge against its first parent (gitleaks runs git log -p with these options).
if [ "$mode" = --staged ]; then
  set -- git --pre-commit --staged
else
  set -- git --log-opts="--diff-merges=first-parent $revs"
fi
{ mise -C "$top" exec -- gitleaks "$@" --redact -v --no-banner --log-level warn "$top" 2>&1 || : >"$tmp/gitleaks.failed"; } | mask >&2
[ ! -f "$tmp/gitleaks.failed" ] || failed="$failed gitleaks"

# 2. identities. GitHub's own web commits use noreply@github.com as committer.
if [ "$mode" != --staged ]; then
  # shellcheck disable=SC2086 # $revs is a list of git log arguments
  git -C "$top" log --format='%h author %ae%n%h committer %ce' $revs >"$tmp/ids"
  bad=$(grep -vE ' (author|committer) ([^@ ]+@users\.noreply\.github\.com|noreply@github\.com)$' "$tmp/ids" || true)
  if [ -n "$bad" ]; then
    echo "privacy-scan: commits that would publish an e-mail address (use your GitHub noreply address):" >&2
    printf '%s\n' "$bad" | sed 's/^/  /' | mask >&2
    failed="$failed identities"
  fi
fi

# 3. the private lists.
if [ "$mode" = --staged ]; then
  git -C "$top" diff --cached --no-color --no-ext-diff -U0 >"$tmp/stream"
  start=staged
else
  # shellcheck disable=SC2086
  git -C "$top" log -p --diff-merges=first-parent --no-color --no-ext-diff -U0 --format='@@privacy-commit %h%n%an <%ae>%n%cn <%ce>%n%B' $revs >"$tmp/stream"
  start=""
fi
# Added lines, added paths, and (for commits) author, committer and message. Removed lines are not checked: a commit
# that deletes an entry is the fix, not a leak. The location printed is masked too: the path may be the entry.
cat >"$tmp/scan.awk" <<'AWK'
function check(s, what,   i, t, where, key) {
  t = tolower(s)
  for (i = 1; i <= n; i++) if (index(t, e[i])) {
    where = (commit == "staged" ? "staged changes" : "commit " commit)
    if (file != "") where = where " " masked(file) (what == "line" ? ":" line : "")
    key = where SUBSEP i SUBSEP what
    if (!(key in seen)) { seen[key] = 1; printf "privacy-scan: %s in %s (%s)\n", label[i], where, what > "/dev/stderr"; found = 1 }
  }
}
BEGIN {
  load(list, "blocklist"); load(local_list, "local-only list")
  commit = start; indiff = (start == "staged")
}
/^@@privacy-commit / { commit = $2; indiff = 0; file = ""; next }
/^diff --git / { indiff = 1; file = ""; next }
indiff && /^\+\+\+ / { file = substr($0, 5); sub(/^b\//, "", file); if (file != "/dev/null") check(file, "path"); next }
indiff && /^@@ / { split($3, h, ","); line = substr(h[1], 2) + 0; next }
indiff && /^\+/ { check(substr($0, 2), "line"); line++; next }
indiff { next }
{ check($0, "author, committer or message") }
END { exit found ? 1 : 0 }
AWK
awk -v list="$list" -v local_list="$local_list" -v start="$start" -f "$tmp/lists.awk" -f "$tmp/scan.awk" "$tmp/stream" ||
  failed="$failed blocklist"

if [ -n "$failed" ]; then
  echo "privacy-scan: refused (${failed# }). Remove it, from earlier commits too (git rebase -i, git commit --amend)," >&2
  echo "  before anything is pushed: a push to a public repository publishes every commit it carries." >&2
  exit 1
fi
