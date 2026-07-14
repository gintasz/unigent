/** Marker selecting side-effect-only completion for `agent.run(prompt, done)`. */
interface Done {
  readonly kind: "done";
}

/** Require a structured completion signal without asking the agent for a value. */
const done: Done = Object.freeze({ kind: "done" });

export type { Done };
export { done };
