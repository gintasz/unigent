// Pure text helpers for the transcript pane. No OpenTUI imports, so these are
// unit-testable under vitest (app.tsx is the only bun/OpenTUI module).

const TRAILING_WS = /[ \t]+$/gm;
const BLANK_RUN = /\n{3,}/g;

/**
 * Collapse a message body's interstitial/trailing whitespace so a body that is
 * mostly blank lines — e.g. padding a model streamed before a tool call — does not
 * render as a tall empty gap in the transcript. Runs of 3+ newlines become one
 * blank line, trailing spaces per line are dropped, and the ends are trimmed.
 *
 * Render-only: the raw text stays in the store, so the system-prompt and
 * full-message toggles remain faithful to what the model actually sent.
 */
function tidy(text: string): string {
  return text.replace(TRAILING_WS, "").replace(BLANK_RUN, "\n\n").trim();
}

export { tidy };
