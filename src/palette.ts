/**
 * Series colors.
 *
 * Eight hues in a fixed order, stepped separately for light and dark surfaces (the same palette as
 * nsh-graph). The order was validated for color-vision-deficiency separation between neighbors, so
 * series 1 and 2 always tell apart; past the eighth, set `color` on the series.
 */

export const PALETTE_LIGHT = [
  "#2a78d6", // blue
  "#eb6834", // orange
  "#1baf7a", // aqua
  "#eda100", // yellow
  "#e87ba4", // magenta
  "#008300", // green
  "#6250d6", // violet
  "#e34948", // red
] as const;

export const PALETTE_DARK = [
  "#3987e5",
  "#d95926",
  "#199e70",
  "#c98500",
  "#d55181",
  "#0ca30c",
  "#9085e9",
  "#e66767",
] as const;

/** `color` (#rgb, #rrggbb or #rrggbbaa) at `alpha` (times its own), as #rrggbbaa; other colors as they are. */
export function withAlpha(color: string, alpha: number): string {
  let hex = color.trim();
  if (!hex.startsWith("#")) return color;
  hex = hex.slice(1);
  if (hex.length === 3) hex = hex.split("").map((c) => c + c).join("");
  let base = 1;
  if (hex.length === 8) {
    base = parseInt(hex.slice(6), 16) / 255;
    hex = hex.slice(0, 6);
  }
  if (hex.length !== 6) return color;
  const a = Math.round(Math.max(0, Math.min(1, alpha * base)) * 255).toString(16).padStart(2, "0");
  return `#${hex}${a}`;
}
