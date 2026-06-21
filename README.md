# thoughtcode

TypeScript workspace for Thoughtcode harness integrations.

## Packages

1. `thoughtcode-core`: harness-neutral tool names, argument types, and model-facing descriptions.
2. `pi-thoughtcode`: PI coding-agent extension that registers the Thoughtcode tools.

## Commands

1. `npm install`
2. `npm run build`
3. `npm test`

## PI Usage

Build the workspace, then load the PI package extension:

```bash
pi -e ./packages/pi-thoughtcode/dist/index.js
```
