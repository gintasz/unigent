type ThemeMode = "dark" | "light";

interface Palette {
  readonly background: string;
  readonly surface: string;
  readonly selected: string;
  readonly userSurface: string;
  readonly foreground: string;
  readonly muted: string;
  readonly border: string;
  readonly accent: string;
  readonly success: string;
  readonly warning: string;
  readonly error: string;
  readonly reasoning: string;
  readonly tool: string;
}

const DARK: Palette = {
  background: "#090c12",
  surface: "#0d1119",
  selected: "#17233b",
  userSurface: "#131923",
  foreground: "#d6dde8",
  muted: "#748094",
  border: "#273244",
  accent: "#82aaff",
  success: "#7bd88f",
  warning: "#f2cc60",
  error: "#ff6b81",
  reasoning: "#c099ff",
  tool: "#ffc777",
};

const LIGHT: Palette = {
  background: "#ffffff",
  surface: "#f7f9fc",
  selected: "#dce9ff",
  userSurface: "#f1f4f8",
  foreground: "#20242c",
  muted: "#657084",
  border: "#d4dbe5",
  accent: "#175cd3",
  success: "#16794a",
  warning: "#956000",
  error: "#c62840",
  reasoning: "#7147b8",
  tool: "#965b00",
};

function paletteFor(mode: ThemeMode): Palette {
  return mode === "light" ? LIGHT : DARK;
}

export type { Palette, ThemeMode };
export { paletteFor };
