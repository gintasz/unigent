# ADR-0005: Release — changesets → tag-based lockstep publish

- **Status:** accepted
- **Date:** 2026-07-01
- **Constitution refs:** C3, L1, I3, X1

## Context

The repo publishes 7 tightly-coupled packages (`@microfoom/core` + five adapters + the CLI), all at `0.1.0`, pre-first-release. Release ran on **changesets**, configured for *independent* versioning (`fixed: []`): each change adds a changeset file naming the affected packages + bump type, a bot accumulates them into a "Version Packages" PR, and merging that PR publishes only the bumped packages.

That machinery pays off when loosely-coupled packages release on different cadences. These don't — the adapters and CLI all depend on `core` and ship together. So independent versioning bought divergent version numbers nobody needs, at the cost of two rituals: the per-change changeset file and the version-PR merge.

## Decision

**Lockstep versioning + tag-triggered publish.** Every public package shares one version; a release is a git tag.

- **Cut a release locally**, then push the tag:
  ```
  pnpm -r exec npm version X.Y.Z --no-git-tag-version   # bump all packages
  git commit -am "release: vX.Y.Z"
  git tag vX.Y.Z && git push --follow-tags
  ```
- **`release.yml`** triggers on `push: tags: ['v*']` → build, test, then `pnpm run release` (build + copy README/LICENSE into each package + `pnpm -r publish --access public` + cleanup). `pnpm publish` skips any version already on npm, so re-running a tag is safe.
- **Removed:** `@changesets/cli`, `.changeset/`, and the `changeset` / `version-packages` scripts. The `release` script now calls `pnpm -r publish` instead of `changeset publish`.
- Auth unchanged: `NPM_TOKEN` secret + `NPM_CONFIG_PROVENANCE`. Without the token the publish step fails loudly — an ordinary tag can't leak a release.

## Consequences

- **Gain:** no changeset-file ritual, no version PR, one version number consumers understand, a one-shot release the maintainer controls end-to-end.
- **Lose:** per-package versions, changesets' auto-accumulated changelog, and "publish only what changed" (lockstep republishes all — but `pnpm publish` skips unchanged versions, and coupled packages move together anyway).
- **Reversible later:** if adapters ever need independent versions (post-1.0, external consumers pinning a specific adapter), re-adopting changesets is a new ADR. Recorded now because the flip is costly and divergent (C3).
- Fits I3/X1 (break-freely, all-in-repo consumers): a release is a deliberate tag, not a continuously-open PR.
