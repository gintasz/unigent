import { describe, expect, it } from "vitest";
import { assertSupportedNodeVersion } from "../src/node_version.ts";

describe("Node.js version requirement", () => {
  it.each(["20.19.0", "22.17.1"])("rejects unsupported Node.js %s", (version) => {
    expect(() => assertSupportedNodeVersion(version)).toThrow(
      `Node.js 24 or newer is required; current version is ${version}.`,
    );
  });

  it.each(["24.0.0", "25.1.0"])("accepts supported Node.js %s", (version) => {
    expect(() => assertSupportedNodeVersion(version)).not.toThrow();
  });
});
