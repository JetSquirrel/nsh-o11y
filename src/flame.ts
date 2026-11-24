/**
 * The flame graph's engine and renderer: a frame per call-tree node, as wide as its value, stacked by
 * depth (root at the top by default, an icicle; or at the bottom, a classic flame). Zooming to a frame
 * makes it the full width, with its callers above it dimmed. Frames narrower than a third of a point are
 * not laid out (nor anything under them), so a frame costs about the same at a thousand nodes as at a
 * million. Plain TypeScript.
 */
import { drawTooltip, fitText, hashString, r1, RectBatch, type TooltipLine } from "./draw";
import { withAlpha } from "./palette";
import type { ProfileNode } from "./profile";
import { fontOf, type Ctx2D, type PathFactory } from "./render";
import { formatValue, type Unit } from "./scale";
import type { ChartTheme } from "./types";

export interface FlameFrame {
  node: ProfileNode;
  x: number;
  w: number;
  depth: number;
  /** A caller of the focused frame: drawn dimmed. */
  above: boolean;
}

function hex(n: number) {
  return Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, "0");
}

function hsl(h: number, s: number, l: number) {
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return `#${hex(f(0) * 255)}${hex(f(8) * 255)}${hex(f(4) * 255)}`;
}

const SHADES = 18;
const WARM_LIGHT = Array.from({ length: SHADES }, (_, i) => hsl(6 + (i * 44) / SHADES, 0.82, 0.62 + ((i * 7) % 5) * 0.025));
const WARM_DARK = Array.from({ length: SHADES }, (_, i) => hsl(6 + (i * 44) / SHADES, 0.62, 0.5 + ((i * 7) % 5) * 0.02));

/** What a frame's color is picked by: its module (`pkg.Type.method` → `pkg.Type`, `a::b::f` → `a::b`, `dir/file` → `dir`). */
export function colorKey(name: string) {
  const p = name.indexOf("(");
  const n = p > 0 ? name.slice(0, p) : name;
  for (const sep of ["::", "/", "."]) {
    const i = n.lastIndexOf(sep);
    if (i > 0) return n.slice(0, i);
  }
  return n;
}

export class FlameEngine {
  width = 0;
  height = 0;
  rowHeight = 18;
  direction: "down" | "up" = "down";
  root: ProfileNode | null = null;
  focus: ProfileNode | null = null;
  scrollY = 0;
  highlight = "";
  unit: Unit = "short";
  dark = false;
  frames: FlameFrame[] = [];
  maxDepth = 0;
  hover: FlameFrame | null = null;
  pointer = { x: 0, y: 0 };
  colorBy: "module" | "name" = "module";
  private colorCache = new Map<string, string>();

  setRoot(root: ProfileNode | null) {
    this.root = root;
    this.focus = root;
    this.scrollY = 0;
    this.hover = null;
  }

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
    this.clampScroll();
  }

  /** Lays out what is wide enough to see, from the focus down, and its callers above. */
  layout() {
    const out: FlameFrame[] = [];
    this.maxDepth = 0;
    const f = this.focus ?? this.root;
    if (!f || !this.root || this.width <= 0) {
      this.frames = out;
      return;
    }
    for (let p = f.parent; p; p = p.parent) out.push({ node: p, x: 0, w: this.width, depth: p.depth, above: true });
    out.reverse();
    const min = 0.35;
    const scale = f.value > 0 ? this.width / f.value : 0;
    const stack: { n: ProfileNode; x: number }[] = [{ n: f, x: 0 }];
    while (stack.length) {
      const { n, x } = stack.pop()!;
      const w = n.value * scale;
      if (w < min) continue;
      out.push({ node: n, x, w, depth: n.depth, above: false });
      if (n.depth > this.maxDepth) this.maxDepth = n.depth;
      let cx = x;
      for (const c of n.children) {
        stack.push({ n: c, x: cx });
        cx += c.value * scale;
      }
    }
    this.frames = out;
    this.clampScroll();
  }

  get contentHeight() {
    return (this.maxDepth + 1) * this.rowHeight;
  }

  clampScroll() {
    const max = Math.max(0, this.contentHeight - this.height);
    this.scrollY = Math.max(0, Math.min(max, this.scrollY));
  }

  scrollBy(dy: number) {
    this.scrollY += this.direction === "down" ? dy : -dy;
    this.clampScroll();
  }

  /** The top of a frame at depth d. */
  yOf(d: number) {
    return this.direction === "down" ? d * this.rowHeight - this.scrollY : this.height - (d + 1) * this.rowHeight + this.scrollY;
  }

  frameAt(x: number, y: number): FlameFrame | null {
    const d = this.direction === "down" ? Math.floor((y + this.scrollY) / this.rowHeight) : Math.floor((this.height - y + this.scrollY) / this.rowHeight);
    for (const fr of this.frames) if (fr.depth === d && x >= fr.x && x < fr.x + fr.w) return fr;
    return null;
  }

  /** Zooms to a frame (the root: all the way out). */
  zoomTo(n: ProfileNode | null) {
    this.focus = n ?? this.root;
    this.hover = null;
  }

  matches(n: ProfileNode) {
    const h = this.highlight.trim().toLowerCase();
    return !!h && n.name.toLowerCase().indexOf(h) >= 0;
  }

  colorOf(n: ProfileNode) {
    const key = this.colorBy === "module" ? colorKey(n.name) : n.name;
    const ck = (this.dark ? "d" : "l") + key;
    let c = this.colorCache.get(ck);
    if (!c) {
      const ramp = this.dark ? WARM_DARK : WARM_LIGHT;
      c = ramp[hashString(key) % ramp.length];
      if (this.colorCache.size > 5000) this.colorCache.clear();
      this.colorCache.set(ck, c);
    }
    return c;
  }

  frameLines(fr: FlameFrame): TooltipLine[] {
    const total = this.root?.value || 1;
    const n = fr.node;
    const pct = (v: number) => `${((v / total) * 100).toFixed(v / total >= 0.1 ? 1 : 2)}%`;
    const lines: TooltipLine[] = [
      { text: n.name, color: this.colorOf(n) },
      { text: `total ${formatValue(n.value, this.unit)} · ${pct(n.value)}` },
      { text: `self ${formatValue(n.self, this.unit)} · ${pct(n.self)}`, muted: true },
    ];
    if (this.focus && this.focus !== this.root && !fr.above) lines.push({ text: `${((n.value / (this.focus.value || 1)) * 100).toFixed(1)}% of ${this.focus.name}`, muted: true });
    return lines;
  }
}

/** The frames and their names. */
export function renderFlame(cx: Ctx2D, e: FlameEngine, theme: ChartTheme, path: PathFactory) {
  const font = fontOf(theme);
  const rh = e.rowHeight;
  if (theme.background) {
    cx.fillStyle = theme.background;
    cx.fillRect(0, 0, e.width, e.height);
  }
  const searching = e.highlight.trim().length > 0;
  const off = withAlpha(theme.muted, 0.22);
  const solid = new RectBatch();
  const dim = new RectBatch();
  const visible: FlameFrame[] = [];
  for (const fr of e.frames) {
    const y = e.yOf(fr.depth);
    if (y + rh < 0 || y > e.height) continue;
    visible.push(fr);
    const color = searching && !e.matches(fr.node) ? off : e.colorOf(fr.node);
    // A hairline gap between frames, once they are wide enough to show one.
    const gap = fr.w > 3 ? 0.5 : 0;
    (fr.above ? dim : solid).add(color, fr.x, y + 0.5, fr.w - gap, rh - 1);
  }
  dim.fill(cx, path, 0.45);
  solid.fill(cx, path);
  cx.font = font;
  cx.textAlign = "left";
  cx.textBaseline = "middle";
  const ink = "#1c1a17";
  for (const fr of visible) {
    if (fr.w < 26) continue;
    const label = fitText(cx, font, fr.node.name, fr.w - 8);
    if (!label) continue;
    const muted = searching && !e.matches(fr.node);
    cx.fillStyle = muted ? theme.muted : ink;
    cx.globalAlpha = fr.above ? 0.7 : 1;
    cx.fillText(label, r1(fr.x + 4), r1(e.yOf(fr.depth) + rh / 2));
  }
  cx.globalAlpha = 1;
}

/** An outline on the hovered frame, and its tooltip. */
export function renderFlameOverlay(cx: Ctx2D, e: FlameEngine, theme: ChartTheme) {
  const fr = e.hover;
  if (!fr) return;
  const y = e.yOf(fr.depth);
  cx.strokeStyle = theme.text;
  cx.lineWidth = 1.5;
  cx.beginPath();
  cx.rect(r1(fr.x + 0.75), r1(y + 1.25), r1(Math.max(1, fr.w - 1.5)), e.rowHeight - 2.5);
  cx.stroke();
  drawTooltip(cx, theme, e.frameLines(fr), e.pointer.x, e.pointer.y, e.width, e.height);
}
