# Contributing

Thanks for stopping by. Issues and pull requests are welcome; small, focused changes land fastest.

## Setup

```bash
git clone git@github.com:pitolabs/agent-docs.git && cd agent-docs
bun install          # also turns the git hooks on (core.hooksPath .githooks)
bun run typecheck && bun test && bun run format:check
```

Bun 1.4 (`packageManager` in `package.json`) and Biome 2.6 pinned in `devDependencies`; Biome runs only through
`scripts/biome.sh`, never from PATH. `bun run format` formats; `bun run build` emits `dist/`.

## The hooks

- **pre-commit** formats the staged files and refuses a commit whose staged changes carry a secret or personal data
  (`scripts/privacy-scan.sh --staged`: gitleaks with the rules in `.gitleaks.toml`, plus a private blocklist kept
  outside the repository).
- **pre-push** runs the same scan over every outgoing commit, and requires every author/committer e-mail to be a
  GitHub noreply address: `git config user.email "<id>+<login>@users.noreply.github.com"` (`gh api user --jq .id`).

The scan needs `~/.config/privacy/blocklist.txt` to exist; an empty file is fine for a contributor. Test fixtures must
use fictional identities: a Brazilian-shaped phone number is refused even when made up (use a US `555` number).

## Tests

`bun test` runs everything under `test/` against a stub S3 (`test/stub-s3.ts`), an in-memory libSQL and stub
extractor/embedder; no network, no keys. Keep new tests deterministic and about behaviour a consumer can see.

## Releasing

Bump `version` in `package.json`, commit, push, create a GitHub release tagged `vX.Y.Z`; `publish.yml` runs the checks
and publishes to npm.
