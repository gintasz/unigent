import { describe, expect, it } from "vitest";
import { NaturalScrollAcceleration } from "../src/tui/scroll.ts";

describe("natural scroll acceleration", () => {
  it("keeps isolated gestures precise and accelerates sustained trackpad input", () => {
    const acceleration = new NaturalScrollAcceleration({ base: 1, maximum: 8 });

    expect(acceleration.tick(1000)).toBe(1);
    expect(acceleration.tick(2000)).toBe(1);
    const burst = Array.from({ length: 12 }, (_, index) => acceleration.tick(2010 + index * 10));
    expect(burst.at(-1)).toBe(8);
  });

  it("resets a completed gesture", () => {
    const acceleration = new NaturalScrollAcceleration({ base: 1, maximum: 8 });
    acceleration.tick(1000);
    acceleration.tick(1010);
    acceleration.reset();

    expect(acceleration.tick(1020)).toBe(1);
  });
});
