// Turn-result store (resume after termination). A program is ordinary TypeScript
// whose only expensive, non-reproducible steps are turns; a TurnStore records each
// completed stateless turn's settled outcome keyed by a content hash of its inputs,
// so a killed run can be restarted and recall finished work instead of re-paying
// the model. Identity is the hash (NOT position): a turn recalls the same record
// regardless of where it now sits in main(), so inserting/reordering turns upstream
// doesn't invalidate the rest. Two identical hashes collapse to one record (same
// inputs → reuse); set a per-turn `storeKey` to force distinct records (e.g.
// best-of-N sampling of one prompt). The store is consulted live within a run too,
// so a crashed run and a clean run compute the same result (transparent resume).
//
// Only STATELESS turns are stored; turns inside a stateful `session()` carry a
// shared transcript that cannot be reconstructed on recall, so they are never
// memoized (see driveTurn). The hash is computed by the runtime; an impl only maps
// hash → record. The port is sync on `get` (loaded into memory at open) and may be
// async on `set` (durable append).

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { appendFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { TurnOutcome } from "./tools.js";
import type { AgentUsage } from "./usage.js";

/** One stored turn: its settled outcome plus the usage it cost, so recall restores
 *  both the result and the run's usage accounting (a recalled run totals the same
 *  usage a clean run would). Fully serializable — `outcome` is a small JSON union
 *  and `usage` a plain projection. */
interface TurnRecord {
  readonly outcome: TurnOutcome;
  readonly usage: AgentUsage;
}

/**
 * A content-addressed store of completed turn results. `get` is a synchronous,
 * in-memory lookup by the runtime-computed hash; `set` records a freshly-run turn
 * and may persist asynchronously. A miss returns `undefined` (the turn runs and is
 * then recorded). Implementations never compute the hash — they only store and
 * serve by it.
 */
interface TurnStore {
  /** The record for this turn hash, or `undefined` if not yet stored. */
  get: (hash: string) => TurnRecord | undefined;
  /** Record a completed turn under its hash (durably, for an on-disk store). */
  set: (hash: string, record: TurnRecord) => void | Promise<void>;
}

/** An in-memory store (tests, ephemeral runs): live dedup within a run, nothing
 *  persisted, so a fresh process starts empty. */
function createMemoryTurnStore(): TurnStore {
  const map = new Map<string, TurnRecord>();
  return {
    get: (hash: string): TurnRecord | undefined => map.get(hash),
    set: (hash: string, record: TurnRecord): void => {
      map.set(hash, record);
    },
  };
}

/** Parse one persisted line into a [hash, record] pair, or undefined if it is blank
 *  or malformed (a truncated final line from a crash mid-write is skipped, so that
 *  turn simply re-runs). */
function parseLine(line: string): readonly [string, TurnRecord] | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) {
    return;
  }
  try {
    const parsed = JSON.parse(trimmed) as { hash?: unknown; record?: unknown };
    if (typeof parsed.hash === "string" && parsed.record !== undefined && parsed.record !== null) {
      return [parsed.hash, parsed.record as TurnRecord];
    }
  } catch {
    // Malformed/partial line — ignore; the affected turn re-runs.
  }
  return;
}

/**
 * A durable store backed by a JSON Lines file at `filePath`. Existing entries are
 * loaded synchronously at construction (one `Map` for fast `get`); each `set`
 * appends one line. Writes are serialized through a promise chain so concurrent
 * turns (a `Promise.all` fan-out) never interleave bytes. The parent directory is
 * created if missing. A bare path is the file; the CLI's `--store <uri>` maps a
 * path (or `file://`) here.
 */
function createFileTurnStore(filePath: string): TurnStore {
  mkdirSync(dirname(filePath), { recursive: true });
  const map = new Map<string, TurnRecord>();
  if (existsSync(filePath)) {
    for (const line of readFileSync(filePath, "utf8").split("\n")) {
      const entry = parseLine(line);
      if (entry !== undefined) {
        map.set(entry[0], entry[1]); // last write wins on a repeated hash
      }
    }
  }
  // Serialize appends: each set chains after the previous write completes.
  let tail: Promise<void> = Promise.resolve();
  return {
    get: (hash: string): TurnRecord | undefined => map.get(hash),
    set: async (hash: string, record: TurnRecord): Promise<void> => {
      map.set(hash, record);
      const line = `${JSON.stringify({ hash, record })}\n`;
      // Chain onto the previous write so concurrent turns never interleave bytes,
      // then await this turn's append so the caller knows it is durable.
      tail = tail.then(async () => {
        await appendFile(filePath, line);
      });
      await tail;
    },
  };
}

export type { TurnRecord, TurnStore };
export { createFileTurnStore, createMemoryTurnStore };
