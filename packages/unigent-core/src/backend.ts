/** JSON Schema advertised to an agent backend. */
export type JsonSchema = Readonly<Record<string, unknown>>;

/** Result returned by a tool to the backend-owned agent loop. */
export interface BackendToolResult {
  readonly content: string;
  readonly isError: boolean;
  readonly terminate?: boolean;
}

/** Backend-neutral tool definition. */
export interface BackendTool {
  readonly name: string;
  readonly description: string;
  readonly promptSnippet?: string;
  readonly promptGuidelines?: readonly string[];
  readonly parameters: JsonSchema;
  readonly execute: (input: unknown) => Promise<BackendToolResult>;
}

/** Raw usage reported by one backend turn. */
export interface BackendUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly totalTokens: number;
  readonly cachedInputTokens?: number;
  readonly reasoningTokens?: number;
  readonly costUsd?: number;
}

/** Normalized incremental events emitted by a backend. */
export type BackendEvent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "reasoning"; readonly text: string }
  | {
      readonly type: "tool_call";
      readonly callId: string;
      readonly name: string;
      readonly input: unknown;
    }
  | {
      readonly type: "tool_result";
      readonly callId: string;
      readonly name: string;
      readonly output: unknown;
      readonly isError: boolean;
    };

/** Request for one backend-owned agent turn. */
export interface BackendTurnRequest {
  readonly systemPrompt: string;
  readonly systemPromptMode: "append" | "replace";
  readonly prompt: string;
  readonly tools: readonly BackendTool[];
  readonly thinking?: string;
  readonly signal: AbortSignal;
  readonly onEvent: (event: BackendEvent) => void;
}

/** Settled backend turn. */
export interface BackendTurnResult {
  readonly text: string;
  readonly usage: BackendUsage;
}

/** One stateful backend conversation. */
export interface BackendSession {
  readonly runTurn: (request: BackendTurnRequest) => Promise<BackendTurnResult>;
  readonly fork?: () => BackendSession;
}

/** Configuration fixed when a backend conversation opens. */
export interface BackendSessionOptions {
  readonly model: string;
}

/** Capabilities whose absence must reject dependent Unigent configuration. */
export interface BackendCapabilities {
  readonly reportsCost: boolean;
  readonly supportsSessionFork: boolean;
}

/** Universal port implemented by Pi, Claude CLI, and future backends. */
export interface Backend {
  readonly name: string;
  /** Stable adapter configuration identity included in checkpoint fingerprints. */
  readonly checkpointKey?: string;
  readonly capabilities: BackendCapabilities;
  readonly openSession: (
    options: BackendSessionOptions,
  ) => BackendSession | Promise<BackendSession>;
}
