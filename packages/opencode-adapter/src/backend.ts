// The OpenCode seam. A turn is one `session.prompt` against a freshly-spawned
// `opencode serve` child (driven via `@opencode-ai/sdk`); this builds that child's
// config and exposes the session operations the adapter needs. The factory is
// injectable (mirrors pi's `streamFn` and claudecli's process factory): tests pass
// a fake backend that replays a scripted model against the same in-process MCP
// server, so the whole adapter — SDK wiring aside — runs offline and
// deterministically.
//
// Sessions live in OpenCode's global database, so a session id created on one
// child server is resumable on the next: each microfoom turn spawns its own server
// (clean lifecycle, fresh MCP tool listing) yet threads one conversation by id.

import { type AddressInfo, createServer } from "node:net";
import process from "node:process";
import { FoomHarnessRejectedError, type StreamEvent } from "@microfoom/core";
import { createOpencodeClient, createOpencodeServer } from "@opencode-ai/sdk";
import {
  emitMessageParts,
  readPromptResponse,
  type TurnOutcome,
  usageFromInfos,
} from "./result.js";

/** The OpenCode config object injected into the child via `OPENCODE_CONFIG_CONTENT`. */
type OpenCodeConfig = Record<string, unknown>;

/** Everything one prompt needs. Harness-neutral; SDK shapes are built in the backend.
 *  The system prompt is NOT here — it travels via the backend launcher's `system`
 *  arg to the shipped transform plugin, since OpenCode otherwise appends it onto its
 *  ambient base. */
interface PromptSpec {
  /** `provider/model` split into OpenCode's two-part model selector. */
  readonly model: { readonly providerID: string; readonly modelID: string };
  /** The user prompt text. */
  readonly prompt: string;
  /** Per-turn tool gate (OpenCode's own built-ins): `name → enabled`. FOOM tools
   *  are served via MCP and stay enabled regardless. Undefined leaves the default. */
  readonly tools?: Record<string, boolean> | undefined;
  /** The MCP server name → tool prefix `<name>_`. */
  readonly serverName: string;
  readonly onEvent?: ((event: StreamEvent) => void) | undefined;
  readonly signal?: AbortSignal | undefined;
}

/** One recorded session message, as returned by `session.messages`. */
interface RecordedMessage {
  readonly info?: { readonly id?: string; readonly role?: string };
  readonly parts?: readonly unknown[];
}

/** A live OpenCode backend for one turn (one child server + client). */
interface OpenCodeBackend {
  /** Create a fresh session, returning its id. */
  createSession: () => Promise<string>;
  /** Branch an existing session into a new one (transcript copied), returning its id. */
  forkSession: (parentId: string) => Promise<string>;
  /** Run one prompt against `sessionId`. */
  prompt: (sessionId: string, spec: PromptSpec) => Promise<TurnOutcome>;
  /** Tear the child server down. */
  close: () => Promise<void>;
}

/** What the per-turn backend launcher needs: the child's config, plus this turn's
 *  system prompt + base-prompt mode (delivered to the shipped transform plugin). */
interface BackendArgs {
  readonly config: OpenCodeConfig;
  /** The full system prompt for this turn. */
  readonly system: string;
  /** true → replace OpenCode's base prompt (hermetic); false → append onto it. */
  readonly omitBase: boolean;
}

/** Injected per-turn backend launcher. */
type OpenCodeBackendFactory = (args: BackendArgs) => Promise<OpenCodeBackend>;

/** Split a `provider/model` id into OpenCode's `{ providerID, modelID }`. The model
 *  half may itself contain slashes (e.g. `openrouter/deepseek/deepseek-v4-flash`). */
function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) {
    throw new FoomHarnessRejectedError(
      `the opencode harness needs a "provider/model" id; got "${model}"`,
    );
  }
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

/** Grab a free localhost port (the SDK's default 4096 would collide across
 *  concurrent sessions, so each child gets its own). */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

/** How long to wait for the child server to come up before declaring it dead. */
const SERVER_START_TIMEOUT_MS = 30_000;

/** The SDK client bound to one child server. */
type OcClient = ReturnType<typeof createOpencodeClient>;

/** Pull the session id out of a `create`/`fork` response, or fail loudly. */
function idOf(response: unknown): string {
  const { data } = response as { data?: { id?: string } };
  if (data?.id === undefined) {
    throw new FoomHarnessRejectedError("opencode returned no session id");
  }
  return data.id;
}

/** Fire-and-forget a promise we don't await (e.g. an abort), swallowing rejection. */
function ignore(work: Promise<unknown>): void {
  work.catch(() => {
    /* best-effort: nothing to do if it fails */
  });
}

/** Fetch this session's recorded messages (each `{ info, parts }`). */
async function messagesOf(
  client: OcClient,
  sessionId: string,
): Promise<readonly RecordedMessage[]> {
  const response = (await client.session.messages({ path: { id: sessionId } })) as {
    data?: readonly RecordedMessage[];
  };
  return response.data ?? [];
}

/** The assistant messages this turn produced: those recorded now (`after`) that
 *  weren't present before (`before`). OpenCode splits one turn into several. */
function freshAssistantMessages(
  before: ReadonlySet<string>,
  after: readonly RecordedMessage[],
): readonly RecordedMessage[] {
  return after.filter((message) => {
    const id = message.info?.id;
    return id !== undefined && !before.has(id) && message.info?.role === "assistant";
  });
}

/** Replay a turn's assistant messages as a StreamEvent transcript — the only place
 *  tool calls/results surface, since `session.prompt`'s return omits them. */
function emitTranscript(
  messages: readonly RecordedMessage[],
  serverName: string,
  onEvent: (event: StreamEvent) => void,
): void {
  for (const message of messages) {
    emitMessageParts(message.parts ?? [], serverName, onEvent);
  }
}

/** Run one prompt against a session and read its outcome, wiring cancellation and
 *  replaying this turn's transcript when someone is listening. */
async function runPrompt(
  client: OcClient,
  sessionId: string,
  spec: PromptSpec,
): Promise<TurnOutcome> {
  const onAbort = (): void => {
    ignore(client.session.abort({ path: { id: sessionId } }));
  };
  if (spec.signal !== undefined) {
    if (spec.signal.aborted) {
      onAbort();
    } else {
      spec.signal.addEventListener("abort", onAbort, { once: true });
    }
  }
  // Snapshot the prior messages so we can isolate this turn's new ones — needed for
  // accurate usage (OpenCode splits a turn across several messages) and the transcript.
  const priorIds = new Set(
    (await messagesOf(client, sessionId))
      .map((message) => message.info?.id)
      .filter((id): id is string => id !== undefined),
  );
  try {
    const response = await client.session.prompt({
      path: { id: sessionId },
      body: {
        model: spec.model,
        ...(spec.tools === undefined ? {} : { tools: spec.tools }),
        parts: [{ type: "text", text: spec.prompt }],
      },
    });
    // assistantText + error come from the returned (final) message; usage is summed
    // across ALL of this turn's messages so multi-step token/reasoning/cost counts
    // are complete (the final message alone omits the tool-call step's reasoning).
    const base = readPromptResponse(response, spec.serverName, undefined);
    const fresh = freshAssistantMessages(priorIds, await messagesOf(client, sessionId));
    const usage =
      fresh.length > 0
        ? usageFromInfos(fresh.map((message) => (message.info ?? {}) as Record<string, unknown>))
        : base.usage;
    if (spec.onEvent !== undefined) {
      emitTranscript(fresh, spec.serverName, spec.onEvent);
    }
    return {
      assistantText: base.assistantText,
      usage,
      ...(base.error ? { error: base.error } : {}),
    };
  } finally {
    spec.signal?.removeEventListener("abort", onAbort);
  }
}

/**
 * The default backend: spawn the real `opencode serve` child via the SDK and bind
 * a client to it. Models resolve through OpenCode itself; auth comes from the
 * user's logged-in providers.
 */
async function spawnOpenCodeBackend(args: BackendArgs): Promise<OpenCodeBackend> {
  const port = await freePort();
  // Hand this turn's system prompt to the shipped transform plugin via an env var
  // keyed by the child's port (OpenCode rejects unknown config keys; the keyed name
  // avoids races with concurrent servers). Set immediately before the synchronous
  // `launch` inside createOpencodeServer so the child inherits it.
  const envKey = `OPENCODE_FOOM_${port}`;
  // biome-ignore lint/style/noProcessEnv: a per-server channel to the child's plugin — the value must land in the spawned process's environment, which is exactly process.env.
  process.env[envKey] = JSON.stringify({ system: args.system, omitBase: args.omitBase });
  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port,
    timeout: SERVER_START_TIMEOUT_MS,
    config: args.config,
  });
  const client = createOpencodeClient({ baseUrl: server.url });

  return {
    createSession: async (): Promise<string> =>
      idOf(await client.session.create({ body: { title: "microfoom" } })),
    forkSession: async (parentId: string): Promise<string> =>
      idOf(await client.session.fork({ path: { id: parentId } })),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- a thin delegate to the already-async runPrompt; wrapping it in another async layer only double-wraps the promise.
    prompt: (sessionId: string, spec: PromptSpec): Promise<TurnOutcome> =>
      runPrompt(client, sessionId, spec),
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- server.close() is synchronous; we only adapt it to the async close() contract.
    close: (): Promise<void> => {
      // biome-ignore lint/style/noProcessEnv: clears the per-server channel set above; same rationale.
      delete process.env[envKey];
      server.close();
      return Promise.resolve();
    },
  };
}

export type { OpenCodeBackend, OpenCodeBackendFactory, OpenCodeConfig, PromptSpec };
export { spawnOpenCodeBackend, splitModel };
