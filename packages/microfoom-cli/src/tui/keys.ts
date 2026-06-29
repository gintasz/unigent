// Pure key-binding logic, kept out of app.tsx so it imports no @opentui graph
// (bun-only) and stays unit-testable under vitest.

/** Resolve the run-control intent of a key: Ctrl+R aborts an in-flight run, plain
 *  `r` reruns a settled one. Either is a no-op (undefined) in the wrong run state,
 *  so abort can't fire when there's nothing to stop and rerun can't fire mid-run. */
function runControlAction(
  key: { readonly name?: string; readonly ctrl?: boolean },
  running: boolean,
): "abort" | "rerun" | undefined {
  if (key.ctrl === true && key.name === "r") {
    return running ? "abort" : undefined;
  }
  if (key.ctrl !== true && key.name === "r") {
    return running ? undefined : "rerun";
  }
  return;
}

export { runControlAction };
