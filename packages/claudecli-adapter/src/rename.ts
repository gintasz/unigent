// The prefix reconciliation. Claude Code namespaces every MCP tool as
// `mcp__<server>__<tool>`, so the model never sees the bare control-tool names
// (`foom_return`, …) that core hard-codes in its tool descriptions and repair
// prompts. The reconcile logic (rewrite/strip/idempotency) is shared across
// adapters in adapter-base; this binds it to Claude Code's bracket scheme.

import { makeNaming } from "@microfoom/adapter-base";

const { applyRename, prefixedToolName, stripPrefix } = makeNaming("bracket");

export { applyRename, prefixedToolName, stripPrefix };
