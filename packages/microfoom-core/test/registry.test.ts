import { describe, expect, it } from "vitest";
import { foom } from "../src/decorators.ts";
import { FoomConfigError } from "../src/index.ts";
import { exposedMethods, readClassMeta } from "../src/registry.ts";

@foom.config({ model: "m", thinking: "low", maxBudgetUsd: 5 })
class Program {
  @foom.expose async silent(): Promise<number> {
    return 1;
  }

  @foom.expose({ announcement: "does a thing" }) async announced(): Promise<number> {
    return 2;
  }

  @foom.expose({ tool: { description: "tool c" } }) async asTool(): Promise<number> {
    return 3;
  }

  async hidden(): Promise<number> {
    return 4;
  }
}

describe("decorator registry (F3)", () => {
  it("records class config and exposed tiers after construction", () => {
    const program = new Program();
    const meta = readClassMeta(program);
    expect(meta?.config?.model).toBe("m");
    expect(meta?.config?.maxBudgetUsd).toBe(5);

    const exposed = exposedMethods(program);
    expect(exposed.get("silent")?.tier).toBe("silent");
    expect(exposed.get("announced")?.tier).toBe("announcement");
    expect(exposed.get("announced")?.announcement).toBe("does a thing");
    expect(exposed.get("asTool")?.tier).toBe("tool");
    expect(exposed.get("asTool")?.tool?.description).toBe("tool c");
    expect(exposed.has("hidden")).toBe(false);
  });

  it("refuses to expose a private (#) member (F3)", () => {
    // Drives the decorator with a synthetic private-method context — equivalent to
    // `@foom.expose #secret()` — without the `#`-decorator syntax the test
    // transformer rejects.
    const privateContext = {
      kind: "method",
      name: "#secret",
      private: true,
      static: false,
      access: { has: () => false, get: () => undefined },
      addInitializer: () => undefined,
      metadata: {},
    };
    const decorate = foom.expose() as (value: unknown, context: unknown) => unknown;
    expect(() => decorate(() => 1, privateContext)).toThrow(FoomConfigError);
  });
});
