interface ScrollAcceleration {
  readonly tick: (now?: number) => number;
  readonly reset: () => void;
}

interface NaturalScrollOptions {
  readonly base?: number;
  readonly maximum?: number;
  readonly streakWindowMilliseconds?: number;
  readonly rampLength?: number;
}

const DEFAULT_MAXIMUM_LINES = 14;
const DEFAULT_STREAK_WINDOW_MILLISECONDS = 160;
const DEFAULT_RAMP_LENGTH = 12;
const EASE_IN_EXPONENT = 1.5;

class NaturalScrollAcceleration implements ScrollAcceleration {
  private lastTick = 0;
  private streak = 0;
  private readonly base: number;
  private readonly maximum: number;
  private readonly streakWindowMilliseconds: number;
  private readonly rampLength: number;

  public constructor(options: NaturalScrollOptions = {}) {
    this.base = options.base ?? 2;
    this.maximum = options.maximum ?? DEFAULT_MAXIMUM_LINES;
    this.streakWindowMilliseconds =
      options.streakWindowMilliseconds ?? DEFAULT_STREAK_WINDOW_MILLISECONDS;
    this.rampLength = options.rampLength ?? DEFAULT_RAMP_LENGTH;
  }

  public tick(now: number = Date.now()): number {
    const elapsed = now - this.lastTick;
    this.lastTick = now;
    this.streak =
      elapsed > this.streakWindowMilliseconds ? 0 : Math.min(this.streak + 1, this.rampLength);
    const progress = this.streak / this.rampLength;
    return Math.round(this.base + (this.maximum - this.base) * progress ** EASE_IN_EXPONENT);
  }

  public reset(): void {
    this.lastTick = 0;
    this.streak = 0;
  }
}

export { NaturalScrollAcceleration };
