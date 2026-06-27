// Public error taxonomy (F7). These are the thrown, consumer-facing classes at
// the Promise/exception facade (F6) — plain Error subclasses.
// Every failure is a subclass of FoomtimeError, discriminated by `instanceof`.
//
//   FoomtimeError                      base for all of the below
//   ├─ FoomtimeThrowError              deliberate FOOMTHROW in a prompt; ALWAYS carries user `code`
//   ├─ FoomtimeValidationError         repairable; catch-all for the three below (no `code`)
//   │  ├─ FoomtimeArgError             bad FOOMCALL args
//   │  ├─ FoomtimeReturnError          bad/missing FOOMRETURN
//   │  └─ FoomtimeDispatchError        unexposed/unknown method
//   ├─ FoomtimeAbortError              run ended early
//   │  ├─ FoomtimeTimeoutError         exceeded maxTurnDuration (turn) or maxProgramDuration (program)
//   │  └─ FoomtimeCancelledError       aborted via signal / .abort()
//   ├─ FoomtimeBudgetExceededError     exceeded maxBudgetUsd
//   ├─ FoomtimeTokenLimitExceededError exceeded maxOutputTokens
//   ├─ FoomtimeCallDepthError          exceeded maxCallDepth
//   ├─ FoomtimeRepairExhaustedError    exceeded repairAttempts consecutive validation failures
//   ├─ FoomtimeHarnessError            boundary failure; split by retryability
//   │  ├─ FoomtimeHarnessUnavailableError  transient — disconnect / 5xx / rate-limit (retryable)
//   │  └─ FoomtimeHarnessRejectedError     non-transient — permission / model-not-allowed / overflow
//   ├─ FoomtimeConfigError             bad config (no such model, invalid thinking, ...)
//   ├─ FoomtimeInputError              /run input failed the program's input schema
//   └─ FoomtimeConcurrencyError        overlapping turns on one session (programming error)

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
 * Raised ONLY by a deliberate FOOMTHROW in a prompt. ALWAYS carries the
 * user-defined `code` from FOOMTHROW (the caller's namespace, e.g. "123" /
 * "E_TOO_LOW"); it has no runtime meaning. Runtime-caught failures are
 * FoomtimeValidationError, NOT this — they have no `code`.
 */
export class FoomtimeThrowError extends FoomtimeError {
  readonly code: string;
  constructor(message: string, code: string, options?: FoomtimeErrorOptions) {
    super(message, options);
    this.code = code;
  }
}

/**
 * Repairable failure — the runtime rejected what the agent produced. Base for the
 * three below, so `instanceof FoomtimeValidationError` catches all of them. No
 * `code`; inspect `message` / `data`. All three count toward repairAttempts.
 */
export class FoomtimeValidationError extends FoomtimeError {}
/** Bad FOOMCALL args. */
export class FoomtimeArgError extends FoomtimeValidationError {}
/** Bad or missing FOOMRETURN. */
export class FoomtimeReturnError extends FoomtimeValidationError {}
/** Unexposed or unknown method. */
export class FoomtimeDispatchError extends FoomtimeValidationError {}

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
/** Exceeded repairAttempts consecutive validation failures. */
export class FoomtimeRepairExhaustedError extends FoomtimeError {}

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
/** Overlapping turns on one session — a programming error, not repairable/retryable. */
export class FoomtimeConcurrencyError extends FoomtimeError {}
