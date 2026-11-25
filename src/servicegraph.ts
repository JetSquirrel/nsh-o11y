/**
 * A service map: the services many traces go through, and the calls between them. A call from A to B is a
 * span in service B whose parent is in service A; each service counts the spans that enter it (roots, and
 * spans called from another service). Laid out left to right in layers: entry services first, each callee a
 * column right of its deepest caller, and the services in a column ordered to cross as few edges as they
 * can. Plain TypeScript, as `ChartEngine` is.
 */
import { drawTooltip, fitText, r1, type TooltipLine } from "./draw";
import { fontOf, measureCached, type Ctx2D, type PathFactory } from "./render";
import { formatValue } from "./scale";
import { TraceModel, type Span } from "./traces";
import type { ChartTheme } from "./types";
import { ERROR_COLOR } from "./waterfall";
import { withAlpha } from "./palette";

/** One service: the spans that entered it. */
export interface ServiceNode {
  service: string;
  /** Spans that entered it: roots, and spans whose parent is in another service. */
  requests: number;
  /** How many of those failed. */
  errors: number;
  /** Their durations' median and 95th percentile, in ms. */
  p50: number;
  p95: number;
  /** Requests a second over the time the traces span (NaN when that is under a second). */
  rate: number;
  /** Some trace starts here. */
  entry: boolean;
}

/** Calls from one service to another. */
export interface ServiceEdge {
  from: string;
  to: string;
  calls: number;
  /** Calls whose span failed. */
  errors: number;
  /** The called spans' durations' median and 95th percentile, in ms. */
  p50: number;
  p95: number;
  /** Calls a second (NaN as for a node). */
  rate: number;
}

export interface ServiceGraph {
  /** In the order each service was first seen (by start time): the order colors are given in. */
  nodes: ServiceNode[];
  edges: ServiceEdge[];
  /** How many traces went in. */
  traces: number;
  /** The time between the first trace's start and the last one's, in seconds. */
  seconds: number;
}

function quantile(sorted: number[], q: number) {
  if (!sorted.length) return NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
}

/** Builds the graph from traces: each one its spans, or a `TraceModel`. */
export function serviceGraph(traces: Iterable<readonly Span[] | TraceModel>): ServiceGraph {
  type Acc = { first: number; n: number; errors: number; durations: number[]; entry: boolean };
  const nodes = new Map<string, Acc>();
  const edges = new Map<string, Acc & { from: string; to: string }>();
  let count = 0;
  let t0 = Infinity;
  let t1 = -Infinity;
  for (const tr of traces) {
    const spans = tr instanceof TraceModel ? tr.spans : tr;
    if (!spans.length) continue;
    count++;
    const byId = new Map<string, Span>();
    let start = Infinity;
    for (const s of spans) {
      byId.set(s.spanId, s);
      if (s.start < start) start = s.start;
    }
    if (start < t0) t0 = start;
    if (start > t1) t1 = start;
    for (const s of spans) {
      const p = s.parentId !== undefined && s.parentId !== s.spanId ? byId.get(s.parentId) : undefined;
      if (p && p.service === s.service) continue;
      let node = nodes.get(s.service);
      if (!node) nodes.set(s.service, (node = { first: s.start, n: 0, errors: 0, durations: [], entry: false }));
      node.first = Math.min(node.first, s.start);
      node.n++;
      if (s.status === "error") node.errors++;
      node.durations.push(s.duration);
      if (!p) {
        node.entry = true;
        continue;
      }
      const key = `${p.service}\u0000${s.service}`;
      let edge = edges.get(key);
      if (!edge) edges.set(key, (edge = { from: p.service, to: s.service, first: s.start, n: 0, errors: 0, durations: [], entry: false }));
      edge.n++;
      if (s.status === "error") edge.errors++;
      edge.durations.push(s.duration);
    }
  }
  const seconds = count > 1 ? (t1 - t0) / 1000 : 0;
  const rate = (n: number) => (seconds >= 1 ? n / seconds : NaN);
  const stats = (a: Acc) => {
    const d = a.durations.sort((x, y) => x - y);
    return { p50: quantile(d, 0.5), p95: quantile(d, 0.95), rate: rate(a.n) };
  };
  return {
    nodes: [...nodes]
      .sort((a, b) => a[1].first - b[1].first)
      .map(([service, a]) => ({ service, requests: a.n, errors: a.errors, entry: a.entry, ...stats(a) })),
    edges: [...edges.values()].map((a) => ({ from: a.from, to: a.to, calls: a.n, errors: a.errors, ...stats(a) })),
    traces: count,
    seconds,
  };
}

export interface ServiceMapOptions {
  /** A node or edge whose share of failures reaches this is drawn red. Default 0.01. */
  errorThreshold: number;
  /** Each edge's call rate (or count) written on it. Default true. */
  edgeLabels: boolean;
}

/** A node placed: its box, in points. */
export interface PlacedNode {
  node: ServiceNode;
  index: number;
  layer: number;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** An edge placed: a cubic curve from its caller to its callee. */
export interface PlacedEdge {
  edge: ServiceEdge;
  index: number;
  from: PlacedNode;
  to: PlacedNode;
  /** Start, two control points, end. */
  pts: [number, number, number, number, number, number, number, number];
  /** Goes back (a cycle) or within a column: routed under the boxes. */
  back: boolean;
}

export class ServiceMapEngine {
  width = 0;
  height = 0;
  options: ServiceMapOptions = { errorThreshold: 0.01, edgeLabels: true };
  graph: ServiceGraph = { nodes: [], edges: [], traces: 0, seconds: 0 };
  /** Layers and the order within them, made when the graph changes. */
  private layers: number[][] = [];
  private layerOf: number[] = [];
  nodes: PlacedNode[] = [];
  edges: PlacedEdge[] = [];
  private palette: readonly string[] = [];
  private laidKey = "";
  /** The selected service's index, -1 for none. */
  selected = -1;
  /** What the pointer is over. */
  hoverNode = -1;
  hoverEdge = -1;
  pointer = { x: 0, y: 0 };
  /** The boxes are one line (the name) because the fullest column has no room for two. */
  compact = false;
  /** Show the selected service's tooltip, at its box: a tap on a touch screen, which has no hover. */
  pinned = false;
  fontSize = 11;
  /** Failures' color, from the theme the last frame drew with. */
  errorColor = ERROR_COLOR;
  measure: (t: string) => number = (t) => t.length * 6;

  setGraph(graph: ServiceGraph, palette: readonly string[]) {
    const prev = this.selected >= 0 ? this.graph.nodes[this.selected]?.service : undefined;
    this.graph = graph;
    this.palette = palette;
    this.rank();
    this.selected = prev === undefined ? -1 : this.indexOf(prev);
    this.hoverNode = -1;
    this.hoverEdge = -1;
    this.laidKey = "";
  }

  setPalette(palette: readonly string[]) {
    this.palette = palette;
    for (const n of this.nodes) n.color = palette[n.index % palette.length];
  }

  setSize(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  indexOf(service: string) {
    return this.graph.nodes.findIndex((n) => n.service === service);
  }

  /** Layers by longest path from the entry services, cycles broken where a walk meets them; then ordered. */
  private rank() {
    const g = this.graph;
    const n = g.nodes.length;
    const idx = new Map(g.nodes.map((s, i) => [s.service, i]));
    const out: number[][] = g.nodes.map(() => []);
    const into: number[][] = g.nodes.map(() => []);
    g.edges.forEach((e, i) => {
      out[idx.get(e.from)!].push(i);
      into[idx.get(e.to)!].push(i);
    });
    // Back edges: those reaching a service still on the walk's stack.
    const back = new Set<number>();
    const state = new Uint8Array(n); // 0 unseen, 1 on the stack, 2 done
    const visit = (start: number) => {
      const stack: { v: number; k: number }[] = [{ v: start, k: 0 }];
      state[start] = 1;
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top.k < out[top.v].length) {
          const ei = out[top.v][top.k++];
          const w = idx.get(g.edges[ei].to)!;
          if (state[w] === 1) back.add(ei);
          else if (state[w] === 0) {
            state[w] = 1;
            stack.push({ v: w, k: 0 });
          }
        } else {
          state[top.v] = 2;
          stack.pop();
        }
      }
    };
    const starts = g.nodes.map((s, i) => i).filter((i) => g.nodes[i].entry || !into[i].length);
    for (const s of starts) if (!state[s]) visit(s);
    for (let i = 0; i < n; i++) if (!state[i]) visit(i);
    this.backEdges = back;
    // Longest path over the forward edges, in topological order (Kahn).
    const layer = new Array<number>(n).fill(0);
    const indeg = new Array<number>(n).fill(0);
    g.edges.forEach((e, i) => {
      if (!back.has(i)) indeg[idx.get(e.to)!]++;
    });
    const queue: number[] = [];
    for (let i = 0; i < n; i++) if (!indeg[i]) queue.push(i);
    while (queue.length) {
      const v = queue.shift()!;
      for (const ei of out[v]) {
        if (back.has(ei)) continue;
        const w = idx.get(g.edges[ei].to)!;
        layer[w] = Math.max(layer[w], layer[v] + 1);
        if (--indeg[w] === 0) queue.push(w);
      }
    }
    this.layerOf = layer;
    const layers: number[][] = [];
    for (let i = 0; i < n; i++) (layers[layer[i]] ??= []).push(i);
    for (let l = 0; l < layers.length; l++) layers[l] ??= [];
    // Order within layers: a few sweeps of the barycenter heuristic, down then up.
    const pos = new Array<number>(n).fill(0);
    const place = () => layers.forEach((ls) => ls.forEach((v, k) => (pos[v] = k)));
    place();
    const neighbors = (v: number, up: boolean) =>
      (up ? into[v] : out[v]).filter((ei) => !back.has(ei)).map((ei) => idx.get(up ? g.edges[ei].from : g.edges[ei].to)!);
    for (let sweep = 0; sweep < 4; sweep++) {
      const down = sweep % 2 === 0;
      const order = down ? layers.map((_, i) => i).slice(1) : layers.map((_, i) => i).reverse().slice(1);
      for (const l of order) {
        const bary = new Map<number, number>();
        for (const v of layers[l]) {
          const ns = neighbors(v, down);
          bary.set(v, ns.length ? ns.reduce((a, w) => a + pos[w], 0) / ns.length : pos[v]);
        }
        layers[l].sort((a, b) => bary.get(a)! - bary.get(b)! || a - b);
        layers[l].forEach((v, k) => (pos[v] = k));
      }
    }
    this.layers = layers;
  }

  private backEdges = new Set<number>();

  /** Places the boxes and the curves for the current size; cheap to call every frame. */
  layout() {
    const key = `${this.width}|${this.height}|${this.fontSize}`;
    if (key === this.laidKey) return;
    this.laidKey = key;
    const g = this.graph;
    const fs = this.fontSize;
    const pad = 12;
    const cols = Math.max(1, this.layers.length);
    // Boxes as wide as 180 points, narrower to fit every column; gaps narrow from 28 to 14 before boxes go under
    // 64. Columns never overlap: under 36 points a box only shows its color and the start of its name.
    const across = this.width - pad * 2;
    let minGap = 28;
    let w = (across - (cols - 1) * minGap) / cols;
    if (w < 64) {
      minGap = 14;
      w = (across - (cols - 1) * minGap) / cols;
    }
    w = Math.floor(Math.max(36, Math.min(180, w)));
    const span = Math.max(0, this.width - pad * 2 - w);
    // Room under the boxes for curves that go back.
    const below = g.edges.some((_, i) => this.isBack(i)) ? 28 : 0;
    const room = this.height - pad * 2 - below;
    // Two lines a box (name; rate and p95) while the fullest column fits; one (the name) when it does not.
    const tallest = this.layers.reduce((m, ls) => Math.max(m, ls.length), 0);
    const two = Math.round(fs * 1.45 * 2 + 14);
    this.compact = tallest * two + Math.max(0, tallest - 1) * 6 > room;
    const h = this.compact ? Math.round(fs * 1.45 + 12) : two;
    const avail = Math.max(h, room);
    this.nodes = g.nodes.map((node, index) => ({ node, index, layer: this.layerOf[index] ?? 0, color: this.palette[index % this.palette.length] ?? "#888888", x: 0, y: 0, w, h }));
    this.layers.forEach((ls, l) => {
      const x = pad + (cols > 1 ? (span * l) / (cols - 1) : span / 2);
      const m = ls.length;
      const gap = m > 1 ? Math.max(4, Math.min(40, (avail - m * h) / (m - 1))) : 0;
      const total = m * h + (m - 1) * gap;
      let y = pad + Math.max(0, (avail - total) / 2);
      for (const v of ls) {
        const p = this.nodes[v];
        p.x = Math.round(x);
        p.y = Math.round(y);
        y += h + gap;
      }
    });
    const bottom = this.nodes.reduce((b, p) => Math.max(b, p.y + p.h), 0);
    this.edges = g.edges.map((edge, index) => {
      const from = this.nodes[this.indexOf(edge.from)];
      const to = this.nodes[this.indexOf(edge.to)];
      const back = this.isBack(index) || from.layer >= to.layer;
      let pts: PlacedEdge["pts"];
      if (!back) {
        const x1 = from.x + from.w;
        const y1 = from.y + from.h / 2;
        const x2 = to.x - 6;
        const y2 = to.y + to.h / 2;
        const dx = Math.max(20, (x2 - x1) / 2);
        pts = [x1, y1, x1 + dx, y1, x2 - dx, y2, x2, y2];
      } else {
        // Out of the caller's bottom, down under the boxes, up into the callee's bottom.
        const x1 = from.x + from.w * 0.6;
        const y1 = from.y + from.h;
        const x2 = to.x + to.w * 0.4;
        const y2 = to.y + to.h + 6;
        const low = bottom + below - 4;
        pts = [x1, y1, x1, low, x2, low, x2, y2];
      }
      return { edge, index, from, to, pts, back };
    });
  }

  private isBack(i: number) {
    return this.backEdges.has(i);
  }

  nodeAt(x: number, y: number) {
    for (let i = this.nodes.length - 1; i >= 0; i--) {
      const p = this.nodes[i];
      if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return i;
    }
    return -1;
  }

  /** The edge whose curve passes within 5 points, the nearest. */
  edgeAt(x: number, y: number) {
    let best = -1;
    let bestD = 5;
    for (const e of this.edges) {
      const p = e.pts;
      let px = p[0];
      let py = p[1];
      for (let k = 1; k <= 20; k++) {
        const [qx, qy] = bezier(p, k / 20);
        const d = segmentDistance(x, y, px, py, qx, qy);
        if (d < bestD) {
          bestD = d;
          best = e.index;
        }
        px = qx;
        py = qy;
      }
    }
    return best;
  }

  failing(errors: number, total: number) {
    return total > 0 && errors / total >= this.options.errorThreshold && errors > 0;
  }

  /** The service highlighted: the hovered one, else the selected one. */
  get focus() {
    return this.hoverNode >= 0 ? this.hoverNode : this.selected;
  }

  /** Whether edge i touches the focused service (all do when none is). */
  edgeLit(i: number) {
    const f = this.focus;
    if (this.hoverEdge >= 0) return i === this.hoverEdge;
    if (f < 0) return true;
    const e = this.edges[i];
    return e.from.index === f || e.to.index === f;
  }

  /** Whether node i is the focused service or calls or is called by it (all are when none is focused). */
  nodeLit(i: number) {
    const f = this.focus;
    if (this.hoverEdge >= 0) {
      const e = this.edges[this.hoverEdge];
      return e.from.index === i || e.to.index === i;
    }
    if (f < 0 || f === i) return true;
    return this.edges.some((e) => (e.from.index === f && e.to.index === i) || (e.to.index === f && e.from.index === i));
  }

  /** "12 req/s" or "34 calls": a rate when the traces span a second or more, else a count. */
  rateText(rate: number, n: number, noun: string) {
    return rate === rate ? `${formatValue(rate, "short")} ${noun}/s` : `${n.toLocaleString()} ${noun === "req" ? "requests" : "calls"}`;
  }

  /** The services a press on the keyboard goes to from the selected one. */
  neighbor(dir: "left" | "right" | "up" | "down" | "first" | "last"): number {
    const s = this.selected;
    // Home and End: the first service of the first column, the last of the last.
    if (dir === "first") return this.layers[0]?.[0] ?? -1;
    if (dir === "last") {
      const ls = this.layers[this.layers.length - 1];
      return ls?.[ls.length - 1] ?? -1;
    }
    if (s < 0) return this.layers[0]?.[0] ?? -1;
    if (dir === "up" || dir === "down") {
      const ls = this.layers[this.layerOf[s]];
      const k = ls.indexOf(s) + (dir === "down" ? 1 : -1);
      return ls[Math.max(0, Math.min(ls.length - 1, k))];
    }
    // The busiest callee (right) or caller (left).
    let best = -1;
    let calls = -1;
    for (const e of this.edges) {
      const [a, b] = dir === "right" ? [e.from.index, e.to.index] : [e.to.index, e.from.index];
      if (a === s && e.edge.calls > calls) {
        best = b;
        calls = e.edge.calls;
      }
    }
    return best >= 0 ? best : s;
  }

  nodeLines(i: number): TooltipLine[] {
    const p = this.nodes[i];
    if (!p) return [];
    const n = p.node;
    const lines: TooltipLine[] = [{ text: n.service, color: p.color }];
    if (n.entry) lines.push({ text: "entry point", muted: true });
    lines.push({ text: `${this.rateText(n.rate, n.requests, "req")} · ${n.requests.toLocaleString()} in ${this.graph.traces.toLocaleString()} traces` });
    lines.push({ text: `p50 ${formatValue(n.p50, "ms")} · p95 ${formatValue(n.p95, "ms")}` });
    if (n.errors) lines.push({ text: `${n.errors.toLocaleString()} failed (${formatValue(n.errors / n.requests, "percentunit")})`, color: this.errorColor });
    const callers = this.edges.filter((e) => e.to.index === i).map((e) => e.from.node.service);
    const callees = this.edges.filter((e) => e.from.index === i).map((e) => e.to.node.service);
    if (callers.length) lines.push({ text: `called by ${callers.join(", ")}`, muted: true });
    if (callees.length) lines.push({ text: `calls ${callees.join(", ")}`, muted: true });
    return lines;
  }

  edgeLines(i: number): TooltipLine[] {
    const e = this.edges[i];
    if (!e) return [];
    const d = e.edge;
    const lines: TooltipLine[] = [
      { text: `${d.from} → ${d.to}`, color: e.to.color },
      { text: `${this.rateText(d.rate, d.calls, "call")} · ${d.calls.toLocaleString()} calls` },
      { text: `p50 ${formatValue(d.p50, "ms")} · p95 ${formatValue(d.p95, "ms")}` },
    ];
    if (d.errors) lines.push({ text: `${d.errors.toLocaleString()} failed (${formatValue(d.errors / d.calls, "percentunit")})`, color: this.errorColor });
    return lines;
  }
}

function bezier(p: PlacedEdge["pts"], t: number): [number, number] {
  const u = 1 - t;
  const a = u * u * u;
  const b = 3 * u * u * t;
  const c = 3 * u * t * t;
  const d = t * t * t;
  return [a * p[0] + b * p[2] + c * p[4] + d * p[6], a * p[1] + b * p[3] + c * p[5] + d * p[7]];
}

function segmentDistance(x: number, y: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l)) : 0;
  return Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
}

/** An arrowhead at the curve's end, pointing along it. */
function arrow(p: PlacedEdge["pts"], size: number) {
  const x = p[6];
  const y = p[7];
  let dx = x - p[4];
  let dy = y - p[5];
  const l = Math.hypot(dx, dy) || 1;
  dx /= l;
  dy /= l;
  // The tip sits a little past the curve's end, on the box's edge.
  const tx = x + dx * 6;
  const ty = y + dy * 6;
  const bx = tx - dx * size;
  const by = ty - dy * size;
  const nx = -dy * size * 0.55;
  const ny = dx * size * 0.55;
  return `M${r1(tx)} ${r1(ty)}L${r1(bx + nx)} ${r1(by + ny)}L${r1(bx - nx)} ${r1(by - ny)}Z`;
}

/** Edges, then the service boxes over them. */
export function renderServiceMap(cx: Ctx2D, e: ServiceMapEngine, theme: ChartTheme, path: PathFactory) {
  e.fontSize = theme.fontSize;
  e.layout();
  const red = theme.error ?? ERROR_COLOR;
  e.errorColor = red;
  const font = fontOf(theme);
  const fs = theme.fontSize;
  if (theme.background) {
    cx.fillStyle = theme.background;
    cx.fillRect(0, 0, e.width, e.height);
  }
  cx.font = font;
  if (!e.nodes.length) {
    cx.fillStyle = theme.muted;
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    cx.fillText("No services", r1(e.width / 2), r1(e.height / 2));
    return;
  }
  const maxCalls = e.edges.reduce((m, x) => Math.max(m, x.edge.calls), 1);
  cx.lineCap = "round";
  // Edges: dimmed ones first, so lit ones draw over them; each style one path.
  for (const lit of [false, true]) {
    for (const x of e.edges) {
      if (e.edgeLit(x.index) !== lit) continue;
      const bad = e.failing(x.edge.errors, x.edge.calls);
      const color = bad ? red : theme.muted;
      const p = x.pts;
      cx.globalAlpha = lit ? (e.focus >= 0 || e.hoverEdge >= 0 ? 0.95 : 0.7) : 0.18;
      cx.strokeStyle = color;
      cx.lineWidth = 1 + 3 * Math.sqrt(x.edge.calls / maxCalls);
      if (x.back) cx.setLineDash([4, 3]);
      cx.stroke(path(`M${r1(p[0])} ${r1(p[1])}C${r1(p[2])} ${r1(p[3])} ${r1(p[4])} ${r1(p[5])} ${r1(p[6])} ${r1(p[7])}`));
      if (x.back) cx.setLineDash([]);
      cx.fillStyle = color;
      cx.fill(path(arrow(p, 7)));
    }
  }
  cx.globalAlpha = 1;

  // Edge labels: the rate (or count) at each curve's middle, on a backing of the surface.
  if (e.options.edgeLabels) {
    cx.font = `${Math.max(9, fs - 1)}px ${theme.fontFamily}`;
    cx.textAlign = "center";
    cx.textBaseline = "middle";
    // Busiest calls first: where labels would overlap (a fan-out), theirs are the ones kept. Each tries the
    // curve's middle, then nearer its callee, where fanned-out curves have spread apart, then nearer its caller.
    const placed: [number, number, number, number][] = [];
    const lh = fs * 1.2;
    const order = e.edges.filter((x) => e.edgeLit(x.index)).sort((a, b) => b.edge.calls - a.edge.calls);
    for (const x of order) {
      const d = x.edge;
      const text = d.rate === d.rate ? `${formatValue(d.rate, "short")}/s` : d.calls.toLocaleString();
      const w = measureCached(cx, cx.font, text) + 6;
      let at: [number, number] | null = null;
      for (const t of [0.5, 0.72, 0.28]) {
        const [px, py] = bezier(x.pts, t);
        const box: [number, number, number, number] = [px - w / 2, py - lh / 2, px + w / 2, py + lh / 2];
        const hits = placed.some((b) => box[0] < b[2] && box[2] > b[0] && box[1] < b[3] && box[3] > b[1]);
        const onNode = e.nodes.some((p) => box[0] < p.x + p.w && box[2] > p.x && box[1] < p.y + p.h && box[3] > p.y);
        if (!hits && !onNode) {
          placed.push(box);
          at = [px, py];
          break;
        }
      }
      if (!at) continue;
      const [mx, my] = at;
      cx.globalAlpha = 0.9;
      cx.fillStyle = theme.surface;
      cx.fillRect(r1(mx - w / 2), r1(my - fs * 0.6), r1(w), r1(fs * 1.2));
      cx.globalAlpha = 1;
      cx.fillStyle = e.failing(d.errors, d.calls) ? red : theme.muted;
      cx.fillText(text, r1(mx), r1(my));
    }
    cx.font = font;
  }

  // Service boxes.
  const lh = Math.round(fs * 1.45);
  for (const p of e.nodes) {
    const n = p.node;
    const lit = e.nodeLit(p.index);
    const bad = e.failing(n.errors, n.requests);
    cx.globalAlpha = lit ? 1 : 0.35;
    cx.fillStyle = theme.surface;
    cx.beginPath();
    if (cx.roundRect) cx.roundRect(p.x, p.y, p.w, p.h, 6);
    else cx.rect(p.x, p.y, p.w, p.h);
    cx.fill();
    const sel = p.index === e.selected;
    cx.strokeStyle = sel ? theme.selection : bad ? red : withAlpha(theme.muted, 0.5);
    cx.lineWidth = sel || bad ? 1.5 : 1;
    cx.beginPath();
    if (cx.roundRect) cx.roundRect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1, 6);
    else cx.rect(p.x + 0.5, p.y + 0.5, p.w - 1, p.h - 1);
    cx.stroke();
    // The service's color, a strip on the left inside the box.
    cx.fillStyle = p.color;
    // Narrow boxes (a narrow view) give the name what padding they can spare.
    const narrow = p.w < 90;
    cx.fillRect(p.x + (narrow ? 3 : 4), p.y + 6, 3, p.h - 12);
    const tx = p.x + (narrow ? 9 : 13);
    const room = p.x + p.w - (narrow ? 4 : 8) - tx;
    const lines = e.compact ? 1 : 2;
    const ty = p.y + (p.h - lh * lines + (lh - fs)) / 2;
    const share = n.errors ? formatValue(n.errors / n.requests, "percentunit") : "";
    cx.textAlign = "left";
    cx.textBaseline = "top";
    if (e.compact) {
      // One line: the name, and its share of failures at the right in red when the whole name still fits
      // beside it (the red border says it fails either way); the rest is in the tooltip.
      const shareW = share ? measureCached(cx, font, share) + 6 : 0;
      const withShare = !!share && measureCached(cx, font, n.service) + shareW <= room;
      cx.fillStyle = theme.text;
      cx.fillText(fitText(cx, font, n.service, withShare ? room - shareW : room), r1(tx), r1(ty));
      if (withShare) {
        cx.fillStyle = red;
        cx.textAlign = "right";
        cx.fillText(share, r1(tx + room), r1(ty));
      }
      continue;
    }
    cx.fillStyle = theme.text;
    cx.fillText(fitText(cx, font, n.service, room), r1(tx), r1(ty));
    // Second line: the rate and p95, then the share of failures in red. A narrow box drops p95 before it
    // would cut a number in half.
    const err = share ? ` · ${share}` : "";
    const errW = err ? measureCached(cx, font, err) : 0;
    const rate = n.rate === n.rate ? `${formatValue(n.rate, "short")}/s` : n.requests.toLocaleString();
    const full = `${rate} · ${formatValue(n.p95, "ms")}`;
    const main = measureCached(cx, font, full) + errW <= room ? full : measureCached(cx, font, rate) + errW <= room ? rate : fitText(cx, font, rate, room);
    cx.fillStyle = theme.muted;
    cx.fillText(main, r1(tx), r1(ty + lh));
    if (err && main && measureCached(cx, font, main) + errW <= room) {
      cx.fillStyle = red;
      cx.fillText(err, r1(tx + measureCached(cx, font, main)), r1(ty + lh));
    }
  }
  cx.globalAlpha = 1;
}

/** The tooltip for what the pointer is over. */
export function renderServiceMapOverlay(cx: Ctx2D, e: ServiceMapEngine, theme: ChartTheme) {
  if (e.hoverNode >= 0) drawTooltip(cx, theme, e.nodeLines(e.hoverNode), e.pointer.x, e.pointer.y, e.width, e.height);
  else if (e.hoverEdge >= 0) drawTooltip(cx, theme, e.edgeLines(e.hoverEdge), e.pointer.x, e.pointer.y, e.width, e.height);
  else if (e.pinned && e.selected >= 0) {
    const p = e.nodes[e.selected];
    if (p) drawTooltip(cx, theme, e.nodeLines(e.selected), p.x + p.w / 2, p.y + p.h, e.width, e.height);
  }
}
