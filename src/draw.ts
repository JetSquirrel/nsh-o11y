/**
 * Canvas helpers the log, trace and profile views share: text cut to a width, a tooltip, and rectangles
 * batched into one path per color (on QuickJS each canvas call costs more than the drawing it does).
 */
import { fontOf, measureCached, type Ctx2D, type PathFactory } from "./render";
import type { ChartTheme } from "./types";

export function r1(v: number) {
  return Math.round(v * 10) / 10;
}

/** `text` cut with an ellipsis to fit `max` points, or "" when not even one letter and the ellipsis fit. */
export function fitText(cx: Pick<Ctx2D, "measureText">, font: string, text: string, max: number): string {
  if (max <= 0 || !text) return "";
  const w = measureCached(cx, font, text);
  if (w <= max) return text;
  const ell = measureCached(cx, font, "…");
  if (max < ell * 2.5) return "";
  // Guess from the average letter width, then step down until it fits: two or three measures.
  let n = Math.floor((text.length * (max - ell)) / w);
  while (n > 0) {
    const t = text.slice(0, n) + "…";
    if (measureCached(cx, font, t) <= max) return t;
    n -= Math.max(1, Math.floor(n * 0.1));
  }
  return "";
}

/** Rectangles gathered by color, then filled with one path each. */
export class RectBatch {
  private paths = new Map<string, string>();

  add(color: string, x: number, y: number, w: number, h: number) {
    if (w <= 0 || h <= 0) return;
    const d = `M${r1(x)} ${r1(y)}h${r1(w)}v${r1(h)}h${r1(-w)}z`;
    this.paths.set(color, (this.paths.get(color) ?? "") + d);
  }

  fill(cx: Ctx2D, path: PathFactory, alpha = 1) {
    if (alpha !== 1) cx.globalAlpha = alpha;
    for (const [color, d] of this.paths) {
      cx.fillStyle = color;
      cx.fill(path(d));
    }
    if (alpha !== 1) cx.globalAlpha = 1;
    this.paths.clear();
  }
}

export interface TooltipLine {
  text: string;
  /** A swatch before the text. */
  color?: string;
  /** Drawn in the muted color. */
  muted?: boolean;
}

/**
 * A tooltip near (x, y), kept inside width × height: the theme's text color as its fill, the surface as its
 * text, as the time chip on a chart's axis is.
 */
export function drawTooltip(cx: Ctx2D, theme: ChartTheme, lines: TooltipLine[], x: number, y: number, width: number, height: number) {
  if (!lines.length) return;
  const font = fontOf(theme);
  cx.font = font;
  const fs = theme.fontSize;
  const lh = Math.round(fs * 1.45);
  const pad = 8;
  const sw = 10;
  let w = 0;
  for (const l of lines) w = Math.max(w, measureCached(cx, font, l.text) + (l.color ? sw + 6 : 0));
  w = Math.min(w + pad * 2, Math.max(120, width - 8));
  const h = lines.length * lh + pad * 2 - (lh - fs) + 2;
  let left = x + 14;
  if (left + w > width - 4) left = x - 14 - w;
  left = Math.max(4, left);
  let top = y + 14;
  if (top + h > height - 4) top = y - 14 - h;
  top = Math.max(4, Math.min(top, height - h - 4));
  cx.globalAlpha = 0.94;
  cx.fillStyle = theme.text;
  if (cx.roundRect) {
    cx.beginPath();
    cx.roundRect(r1(left), r1(top), r1(w), r1(h), 6);
    cx.fill();
  } else cx.fillRect(r1(left), r1(top), r1(w), r1(h));
  cx.globalAlpha = 1;
  cx.textAlign = "left";
  cx.textBaseline = "top";
  let ty = top + pad;
  for (const l of lines) {
    let tx = left + pad;
    if (l.color) {
      cx.fillStyle = l.color;
      cx.fillRect(r1(tx), r1(ty + fs / 2 - 2), sw, 4);
      tx += sw + 6;
    }
    cx.globalAlpha = l.muted ? 0.7 : 1;
    cx.fillStyle = theme.surface;
    cx.fillText(fitText(cx, font, l.text, left + w - pad - tx), r1(tx), r1(ty));
    cx.globalAlpha = 1;
    ty += lh;
  }
}

/** A stable small hash of a string (FNV-1a), for colors picked by name. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
