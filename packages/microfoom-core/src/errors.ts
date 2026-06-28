// Public error taxonomy (F7). These are the thrown, consumer-facing classes at
// the Promise/exception facade (F6) — plain Error subclasses.
// Every failure is a subclass of FoomtimeError, discriminated by `instanceof`.
//
//   FoomtimeError                      base for all of the below
//   ├─ FoomtimeThrowError              deliberate `foom_throw` in a prompt; ALWAYS carries user `code`
//   ├─ FoomtimeAbortError              run ended early
//   │  ├─ FoomtimeTimeoutError         exceeded maxTurnDuration (turn) or maxProgramDuration (program)
//   │  └─ FoomtimeCancelledError       aborted via signal / .abort()
//   ├─ FoomtimeBudgetExceededError     exceeded maxBudgetUsd
//   ├─ FoomtimeTokenLimitExceededError exceeded maxOutputTokens
//   ├─ FoomtimeCallDepthError          exceeded maxCallDepth
//   ├─ FoomtimeRepairExhaustedError    repair loop gave up; `.channel` names the fault
//   ├─ FoomtimeHarnessError            boundary failure; split by retryability
//   │  ├─ FoomtimeHarnessUnavailableError  transient — disconnect / 5xx / rate-limit (retryable)
//   │  └─ FoomtimeHarnessRejectedError     non-transient — permission / model-not-allowed / overflow
//   ├─ FoomtimeConfigError             bad config (no such model, invalid thinking, ...)
//   ├─ FoomtimeInputError              /run input failed the program's input schema
//   ├─ FoomtimeDispatchError           exposed method has no implementation on the instance (defect)
//   └─ FoomtimeConcurrencyError        overlapping turns on one session (programming error)
//
// Repairable agent faults — bad `foom_call` args, a call to an unexposed method, a
// `foom_return` whose value fails its schema, a turn that omits `foom_return` — are
// NOT thrown when they happen. The runtime feeds each back to the model in-band as
// an error tool-result and re-prompts, up to `repairAttempts` (E1/E3). They surface
// as one exception only once repair is exhausted: FoomtimeRepairExhaustedError,
// whose `.channel` ("args" | "return" | "dispatch") names the fault that exhausted.

/** Options accepted by every Foomtime error: an underlying cause and free-form data. */
export interface FoomtimeErrorOptions {
  cause?: unknown;
  data?: unknown;
}

/** Base for the whole taxonomy. Each subclass reports its own class name. */
export class FoomtimeError extends Error {
  readonly data?: unknown;
  constructor(message: string, options?: FoomtimeErrorOptions) {
    super(message, { cause: options?.cause });
    this.name = new.target.name;
    this.data = options?.data;
  }
}

/**
 * Raised ONLY by a deliberate `foom_throw` in a prompt. ALWAYS carries the
 * user-defined `code` from `foom_throw` (the caller's namespace, e.g. "123" /
 * "E_TOO_LOW"); it has no runtime meaning. Runtime-caught failures are
 * FoomtimeRepairExhaustedError, NOT this — they have no `code`.
 */
export class FoomtimeThrowError extends FoomtimeError {
  readonly code: string;
  constructor(message: string, code: string, options?: FoomtimeErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/** Run ended early. */
export class FoomtimeAbortError extends FoomtimeError {}
/** Exceeded maxTurnDuration (turn) or maxProgramDuration (program). */
export class FoomtimeTimeoutError extends FoomtimeAbortError {}
/** Aborted via signal / .abort(). */
export class FoomtimeCancelledError extends FoomtimeAbortError {}

/** Exceeded maxBudgetUsd. */
export class FoomtimeBudgetExceededError extends FoomtimeError {}
/** Exceeded maxOutputTokens. */
export class FoomtimeTokenLimitExceededError extends FoomtimeError {}
/** Exceeded maxCallDepth. */
export class FoomtimeCallDepthError extends FoomtimeError {}
/** Which repairable agent fault exhausted the repair loop. */
export type RepairChannel = "args" | "return" | "dispatch";
/**
 * The repair loop gave up after `repairAttempts` consecutive invalid attempts.
 * `channel` names the fault: "args" (bad `foom_call` arguments), "return" (a
 * `foom_return` value that failed its schema, or a turn that never returned), or
 * "dispatch" (a call to an unexposed method).
 */
export class FoomtimeRepairExhaustedError extends FoomtimeError {
  readonly channel: RepairChannel;
  constructor(message: string, channel: RepairChannel, options?: FoomtimeErrorOptions) {
    super(message, options);
    this.channel = channel;
  }
}

/**
 * The harness (or its backend) failed to fulfill a turn. foomtime runs inside the
 * harness and delegates turns to it, so this is the boundary-failure class —
 * origin (provider vs harness internals) is often indistinguishable from here.
 */
export abstract class FoomtimeHarnessError extends FoomtimeError {
  /** HTTP-ish status, if the harness surfaced one. */
  readonly status?: number;
  /** True when retrying the same turn may succeed — the only thing a catcher needs. */
  abstract readonly retryable: boolean;
}
/** Transient: harness disconnected, model 5xx, rate-limited. Safe to retry. */
export class FoomtimeHarnessUnavailableError extends FoomtimeHarnessError {
  readonly retryable = true;
  /** Honor a harness/provider backoff hint, if any. */
  readonly retryAfterMs?: number;
}
/** Non-transient: permission denied, model not allowed, context overflow, content filtered. */
export class FoomtimeHarnessRejectedError extends FoomtimeHarnessError {
  readonly retryable = false;
}

/** Bad config (no such model, invalid thinking, unenforceable cap, ...). */
export class FoomtimeConfigError extends FoomtimeError {}
/** /run input failed the program's input schema. */
export class FoomtimeInputError extends FoomtimeError {}
/**
 * An exposed method has no callable implementation on the program instance —
 * contradictory program state (a defect), not an agent-repairable miss, so it fails
 * fast rather than entering the repair loop. A call to an *unexposed* method is
 * repairable and is handled in-band (see the header note); it never reaches here.
 */
export class FoomtimeDispatchError extends FoomtimeError {}
/** Overlapping turns on one session — a programming error, not repairable/retryable. */
export class FoomtimeConcurrencyError extends FoomtimeError {}
