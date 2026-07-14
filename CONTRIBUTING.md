# Contributing

Issues and PRs welcome — PRs adding adapters for other model harnesses are especially welcome.

## Publishing policy

The two public packages, `@unigent/sdk` and `@unigent/cli`, are ESM-only. Core, adapter, and test
workspaces are private and bundled into the public packages that use them; they must never be
published independently. Package metadata identifies the author by name only and must not publish
a private email address.
