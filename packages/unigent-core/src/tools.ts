/** Marker for the opt-in deliberate-failure tool. */
export interface FailTool {
  readonly kind: "fail";
}

/** Let the agent deliberately terminate a run with `AgentRaisedError`. */
export const fail: FailTool = Object.freeze({ kind: "fail" });
