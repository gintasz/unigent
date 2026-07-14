import { createWriteStream } from "node:fs";
import process from "node:process";
import { subscribeRunControls, subscribeTrace } from "@unigent/core/trace";
import { environmentVariable } from "./environment.js";
import { fatalErrorMessage } from "./error_message.js";
import { serializeTraceEvent, TRACE_TRANSPORT_ENVIRONMENT_VARIABLE } from "./protocol.js";

const TRACE_FILE_DESCRIPTOR = 3;
const INTERRUPTED_EXIT_CODE = 130;
const INTERRUPT_GRACE_MILLISECONDS = 1000;
const traceStream =
  environmentVariable(TRACE_TRANSPORT_ENVIRONMENT_VARIABLE) === String(TRACE_FILE_DESCRIPTOR)
    ? createWriteStream("/dev/null", {
        fd: TRACE_FILE_DESCRIPTOR,
        autoClose: false,
      })
    : undefined;

traceStream?.on("error", () => {
  // Telemetry is best-effort and must never fail the script it observes.
});

const stopObserving =
  traceStream === undefined
    ? undefined
    : subscribeTrace((event) => {
        try {
          traceStream.write(serializeTraceEvent(event));
        } catch {
          // Hostile or unserializable tool payloads must not affect the observed run.
        }
      });
const activeRuns = new Map<string, (reason?: unknown) => void>();
let interrupted = false;
let fatalHandled = false;
const stopSupervising = subscribeRunControls((event) => {
  if (event.type === "run_start") {
    activeRuns.set(event.spanId, event.abort);
  } else {
    activeRuns.delete(event.spanId);
  }
});

process.on("SIGINT", () => {
  if (interrupted) {
    process.exit(INTERRUPTED_EXIT_CODE);
  }
  interrupted = true;
  for (const abort of activeRuns.values()) {
    abort(new Error("run interrupted by Unigent CLI"));
  }
  if (activeRuns.size === 0) {
    process.exit(INTERRUPTED_EXIT_CODE);
  }
  setTimeout(() => process.exit(INTERRUPTED_EXIT_CODE), INTERRUPT_GRACE_MILLISECONDS).unref();
});

function exitWithMessage(code: number, message: string): void {
  process.stderr.write(`${message}\n`, () => process.exit(code));
}

const handleFatalError = (error: unknown): void => {
  if (
    interrupted &&
    error instanceof Error &&
    (error.name === "AgentCancelledError" || error.name === "AbortError")
  ) {
    process.exit(INTERRUPTED_EXIT_CODE);
  }
  if (fatalHandled) {
    return;
  }
  fatalHandled = true;
  const details =
    error instanceof Error ? (error.stack ?? error.message) : fatalErrorMessage(error);
  exitWithMessage(1, `unigent: ${details}`);
};
process.on("uncaughtException", handleFatalError);
process.on("unhandledRejection", handleFatalError);

process.once("beforeExit", () => {
  stopObserving?.();
  stopSupervising();
  process.removeListener("uncaughtException", handleFatalError);
  process.removeListener("unhandledRejection", handleFatalError);
  traceStream?.end();
});
