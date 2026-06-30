// Shipped OpenCode plugin (loaded by the child `opencode serve` via config `plugin`).
// OpenCode appends `session.prompt`'s `system` onto its own base persona AND the
// ambient AGENTS.md/CLAUDE.md/skill catalog, so a harness can't get a clean prompt
// through the request alone. This `experimental.chat.system.transform` hook rewrites
// the final system array to exactly what microfoom wants: a hermetic REPLACE by
// default, or an opt-in APPEND onto OpenCode's base.
//
// The desired prompt + mode arrive via a per-server env var keyed by this child's
// port — `OPENCODE_FOOM_<port>` — because OpenCode rejects unknown config keys, and
// a plain env var would race across concurrent servers. The port is read from the
// plugin's own `serverUrl`, so each child reads exactly its own turn's prompt.

import process from "node:process";

export const FoomSystemPrompt = async (input) => {
  let foom = {};
  try {
    const { port } = new URL(String(input?.serverUrl ?? ""));
    // biome-ignore lint/style/noProcessEnv: this runs inside the spawned OpenCode child; the per-server prompt is delivered via its environment.
    foom = JSON.parse(process.env[`OPENCODE_FOOM_${port}`] ?? "{}");
  } catch {
    foom = {};
  }
  return {
    "experimental.chat.system.transform": async (_inputArg, output) => {
      if (typeof foom.system !== "string") {
        return;
      }
      // omitBase (default true): replace OpenCode's base + ambient instructions
      // entirely. omitBase === false: keep them and append microfoom's prompt.
      output.system = foom.omitBase === false ? [...output.system, foom.system] : [foom.system];
    },
  };
};
