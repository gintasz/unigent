import { expect, it } from "vitest";
import { CORE_VERSION } from "../src/index.ts";

it("exposes a version from the core barrel", () => {
  expect(CORE_VERSION).toBe("0.1.0");
});
