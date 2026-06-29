// Public error taxonomy (F7). These are the thrown, consumer-facing classes at
// the Promise/exception facade (F6) — plain Error subclasses.
// Every failure is a subclass of FoomError, discriminated by `instanceof`.
//
//   FoomError                      base for all of the below
//   ├─ FoomThrowError              deliberate `foom_throw` in a prompt; ALWAYS carries user `code`
//   ├─ FoomAbortError              run ended early
//   │  ├─ FoomTimeoutError         exceeded maxTurnDuration (turn) or maxProgramDuration (program)
//   │  └─ FoomCancelledError       aborted via signal / .abort()
//   ├─ FoomBudgetExceededError     exceeded maxBudgetUsd
//   ├─ FoomTokenLimitExceededError exceeded maxOutputTokens
//   ├─ FoomCallDepthError          exceeded maxCallDepth
//   ├─ FoomRepairExhaustedError    repair loop gave up; `.channel` names the fault
//   ├─ FoomHarnessError            boundary failure; split by retryability
//   │  ├─ FoomHarnessUnavailableError  transient — disconnect / 5xx / rate-limit (retryable)
//   │  └─ FoomHarnessRejectedError     non-transient — permission / model-not-allowed / overflow
//   ├─ FoomConfigError             bad config (no such model, invalid thinking, ...)
//   ├─ FoomInputError              /run input failed the program's input schema
//   ├─ FoomDispatchError           exposed method has no implementation on the instance (defect)
//   └─ FoomConcurrencyError        overlapping turns on one session (programming error)
//
// Repairable agent faults — bad `foom_call` args, a call to an unexposed method, a
// `foom_return` whose value fails its schema, a turn that omits `foom_return` — are
// NOT thrown when they happen. The runtime feeds each back to the model in-band as
// an error tool-result and re-prompts, up to `repairAttempts` (E1/E3). They surface
// as one exception only once repair is exhausted: FoomRepairExhaustedError,
// whose `.channel` ("args" | "return" | "dispatch") names the fault that exhausted.

/** Options accepted by every Foom error: an underlying cause and free-form data. */
export interface FoomErrorOptions {
  cause?: unknown;
  data?: unknown;
}

/** Base for the whole taxonomy. Each subclass reports its own class name. */
export class FoomError extends Error {
  public readonly data?: unknown;
  public constructor(message: string, options?: FoomErrorOptions) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    this.data = options?.data;
  }
}

/**
 * Raised ONLY by a deliberate `foom_throw` in a prompt. ALWAYS carries the
 * user-defined `code` from `foom_throw` (the caller's namespace, e.g. "123" /
 * "E_TOO_LOW"); it has no runtime meaning. Runtime-caught failures are
 * FoomRepairExhaustedError, NOT this — they have no `code`.
 */
export class FoomThrowError extends FoomError {
  public readonly code: string;
  public constructor(message: string, code: string, options?: FoomErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** Run ended early. */
export class FoomAbortError extends FoomError {}
/** Exceeded maxTurnDuration (turn) or maxProgramDuration (program). */
export class FoomTimeoutError extends FoomAbortError {}
/** Aborted via signal / .abort(). */
export class FoomCancelledError extends FoomAbortError {}

/** Exceeded maxBudgetUsd. */
export class FoomBudgetExceededError extends FoomError {}
/** Exceeded maxOutputTokens. */
export class FoomTokenLimitExceededError extends FoomError {}
/** Exceeded maxCallDepth. */
export class FoomCallDepthError extends FoomError {}
/** Which repairable agent fault exhausted the repair loop. */
export type RepairChannel = "args" | "return" | "dispatch";
/**
 * The repair loop gave up after `repairAttempts` consecutive invalid attempts.
 * `channel` names the fault: "args" (bad `foom_call` arguments), "return" (a
 * `foom_return` value that failed its schema, or a turn that never returned), or
 * "dispatch" (a call to an unexposed method).
 */
export class FoomRepairExhaustedError extends FoomError {
  public readonly channel: RepairChannel;
  public constructor(message: string, channel: RepairChannel, options?: FoomErrorOptions) {
    super(message, options);
    this.channel = channel;
  }
}

/**
 * The harness (or its backend) failed to fulfill a turn. foomtime runs inside the
 * harness and delegates turns to it, so this is the boundary-failure class —
 * origin (provider vs harness internals) is often indistinguishable from here.
 */
export abstract class FoomHarnessError extends FoomError {
  /** HTTP-ish status, if the harness surfaced one. */
  public readonly status?: number;
  /** True when retrying the same turn may succeed — the only thing a catcher needs. */
  public abstract readonly retryable: boolean;
}
/** Transient: harness disconnected, model 5xx, rate-limited. Safe to retry. */
export class FoomHarnessUnavailableError extends FoomHarnessError {
  public readonly retryable = true;
  /** Honor a harness/provider backoff hint, if any. */
  public readonly retryAfterMs?: number;
}
/** Non-transient: permission denied, model not allowed, context overflow, content filtered. */
export class FoomHarnessRejectedError extends FoomHarnessError {
  public readonly retryable = false;
}

/** Bad config (no such model, invalid thinking, unenforceable cap, ...). */
export class FoomConfigError extends FoomError {}
/** /run input failed the program's input schema. */
export class FoomInputError extends FoomError {}
/**
 * An exposed method has no callable implementation on the program instance —
 * contradictory program state (a defect), not an agent-repairable miss, so it fails
 * fast rather than entering the repair loop. A call to an *unexposed* method is
 * repairable and is handled in-band (see the header note); it never reaches here.
 */
export class FoomDispatchError extends FoomError {}
/** Overlapping turns on one session — a programming error, not repairable/retryable. */
export class FoomConcurrencyError extends FoomError {}
