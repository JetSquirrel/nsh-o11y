/**
 * The theme every component draws with: NSH's tokens (foreground, muted, primary, background) for the
 * current color scheme, overridden by a component's `colors`.
 */
import { colorScheme, token } from "nsh";
import { PALETTE_DARK, PALETTE_LIGHT, withAlpha } from "./palette";
import type { ChartColors, ChartTheme } from "./types";

/** Call inside a `computed`: it reads the color scheme and the theme tokens. */
export function resolveTheme(colors: ChartColors | undefined, fontFamily?: string, fontSize?: number): ChartTheme {
  const c = colors ?? {};
  const dark = colorScheme() === "dark";
  const fg = token("foreground");
  const muted = token("muted-foreground");
  return {
    background: c.background ?? null,
    text: c.text ?? fg,
    muted: c.muted ?? muted,
    grid: c.grid ?? withAlpha(muted, dark ? 0.16 : 0.14),
    cursor: c.cursor ?? withAlpha(fg, 0.55),
    selection: c.selection ?? token("primary"),
    error: c.error ?? token("destructive"),
    surface: c.background ?? token("background"),
    palette: c.palette ?? (dark ? PALETTE_DARK : PALETTE_LIGHT),
    fontFamily: fontFamily ?? "system-ui",
    fontSize: fontSize ?? 11,
  };
}

/** Whether the theme's surface is dark: text on colored bars picks black or white by it. */
export function isDark(theme: ChartTheme) {
  return luminance(theme.surface) < 0.4;
}

/** Relative luminance of a #rgb / #rrggbb color, 0 to 1 (0.5 for anything else). */
export function luminance(color: string) {
  let h = color.trim();
  if (!h.startsWith("#")) return 0.5;
  h = h.slice(1);
  if (h.length === 3 || h.length === 4) h = h.slice(0, 3).split("").map((c) => c + c).join("");
  h = h.slice(0, 6);
  if (h.length !== 6) return 0.5;
  const ch = (i: number) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * ch(0) + 0.7152 * ch(2) + 0.0722 * ch(4);
}
