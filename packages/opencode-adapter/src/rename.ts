// The prefix reconciliation. OpenCode namespaces every MCP tool as `<server>_<tool>`
// (underscore, not Claude Code's `mcp__<server>__`), so the model never sees the bare
// control-tool names core hard-codes. The reconcile logic (rewrite/strip/idempotency)
// is shared across adapters in adapter-base; this binds it to OpenCode's underscore
// scheme. OpenCode strips its own prefix before invoking the MCP server, so tools are
// still registered (and called) under their canonical basenames.

import { makeNaming } from "@microfoom/adapter-base";

const { applyRename, stripPrefix } = makeNaming("underscore");

export { applyRename, stripPrefix };
