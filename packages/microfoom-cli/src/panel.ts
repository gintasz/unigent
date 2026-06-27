// Live run panel: subscribes to the event stream, folds it into the span tree via
// core/trace's buildRunTree, and redraws in place with log-update (on stderr, so
// the program result on stdout stays clean and pipeable). Redraws are coalesced on
// a short timer to avoid flicker. The panel is presentation; the tree is shared.

import { type AgentEvent, buildRunTree } from "@microfoom/core/trace";
import { createLogUpdate } from "log-update";
import { renderRunTree } from "./render.js";

export interface Panel {
  readonly onEvent: (event: AgentEvent) => void;
  /** Freeze the final frame (call once the run settles). */
  readonly done: () => void;
}

const REDRAW_MS = 60;

/** Attach a live panel to a writable TTY stream (typically `process.stderr`). */
export function attachPanel(stream: NodeJS.WriteStream): Panel {
  const log = createLogUpdate(stream);
  const events: AgentEvent[] = [];
  const width = stream.columns ?? 80;
  let timer: NodeJS.Timeout | undefined;

  const flush = (): void => {
    timer = undefined;
    log(renderRunTree(buildRunTree(events), { width, color: true }));
  };
  const schedule = (): void => {
    if (timer === undefined) timer = setTimeout(flush, REDRAW_MS);
  };

  return {
    onEvent: (event) => {
      events.push(event);
      schedule();
    },
    done: () => {
      if (timer !== undefined) clearTimeout(timer);
      flush();
      log.done();
    },
  };
}
