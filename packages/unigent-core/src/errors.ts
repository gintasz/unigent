/** Base class for every consumer-facing Unigent failure. */
export class AgentError extends Error {
  public constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** Deliberate failure raised by the opt-in `fail` tool. */
export class AgentRaisedError extends AgentError {
  public readonly code: string | undefined;

  public constructor(message: string, code?: string) {
    super(message);
    this.code = code;
  }
}

/** Run was cancelled through `abort()` or a parent signal. */
export class AgentCancelledError extends AgentError {}

/** A configured wall-clock limit expired. */
export class AgentTimeoutError extends AgentError {}

/** A cumulative cost limit was exceeded. */
export class AgentBudgetExceededError extends AgentError {}

/** Agent output or tool input could not be repaired within the configured attempts. */
export class AgentRepairExhaustedError extends AgentError {}

/** Invalid or unsupported Unigent configuration. */
export class AgentConfigError extends AgentError {}

/** Script arguments could not be parsed through their declared schema. */
export class AgentInputError extends AgentError {}

/** Overlapping turns attempted on one stateful session. */
export class AgentConcurrencyError extends AgentError {}

/** Base class for backend boundary failures. */
export abstract class AgentBackendError extends AgentError {
  public abstract readonly retryable: boolean;
}

/** Transient backend/provider failure. */
export class AgentBackendUnavailableError extends AgentBackendError {
  public readonly retryable = true;
}

/** Non-transient backend rejection or unsupported request. */
export class AgentBackendRejectedError extends AgentBackendError {
  public readonly retryable = false;
}
