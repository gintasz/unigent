// The structural JSON coercion helpers: prove each narrows correctly and defaults
// safely on a mismatch (so a malformed stream line can never throw mid-parse).

import { describe, expect, it } from "vitest";
import { asArray, asNumber, asObject, asString } from "../src/json.ts";

describe("json coercion", () => {
  it("asObject returns objects, undefined otherwise", () => {
    expect(asObject({ a: 1 })).toEqual({ a: 1 });
    expect(asObject(null)).toBeUndefined();
    expect(asObject([1])).toEqual([1]); // arrays are objects
    expect(asObject("x")).toBeUndefined();
  });

  it("asArray returns arrays, [] otherwise", () => {
    expect(asArray([1, 2])).toEqual([1, 2]);
    expect(asArray("x")).toEqual([]);
    expect(asArray(undefined)).toEqual([]);
  });

  it("asNumber returns numbers, 0 otherwise", () => {
    expect(asNumber(5)).toBe(5);
    expect(asNumber("5")).toBe(0);
    expect(asNumber(undefined)).toBe(0);
  });

  it("asString returns strings, undefined otherwise", () => {
    expect(asString("hi")).toBe("hi");
    expect(asString(5)).toBeUndefined();
    expect(asString(null)).toBeUndefined();
  });
});
