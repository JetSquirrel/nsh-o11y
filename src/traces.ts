/**
 * A trace: its spans as a tree, flattened into waterfall rows (children under their parent, in start
 * order), with each span's self time and the services in it. Plain TypeScript, no NSH imports.
 */

export interface SpanEvent {
  /** Milliseconds, on the spans' clock. */
  time: number;
  /** "exception" (OpenTelemetry's name for one) and names with "error" or "fail" in them are drawn red. */
  name: string;
  attributes?: Record<string, string | number | boolean>;
}

export interface Span {
  spanId: string;
  /** Missing, or not in the trace: a root. */
  parentId?: string;
  name: string;
  service: string;
  /** Start, in milliseconds (epoch or relative: only differences are shown). */
  start: number;
  /** Milliseconds. */
  duration: number;
  status?: "ok" | "error" | "unset";
  kind?: "server" | "client" | "internal" | "producer" | "consumer";
  attributes?: Record<string, string | number | boolean>;
  events?: SpanEvent[];
}

export interface WaterfallRow {
  span: Span;
  depth: number;
  /** How many children it has. */
  children: number;
  collapsed: boolean;
  /** Its duration less the time its children cover. */
  self: number;
}

export class TraceModel {
  readonly spans: readonly Span[];
  readonly start: number;
  readonly end: number;
  /** Services in the order their first span starts: the order colors are given in. */
  readonly services: string[];
  readonly roots: Span[];
  private readonly kids = new Map<string, Span[]>();
  private readonly byId = new Map<string, Span>();
  private readonly selfTimes = new Map<string, number>();

  constructor(spans: readonly Span[]) {
    this.spans = spans;
    for (const s of spans) this.byId.set(s.spanId, s);
    const roots: Span[] = [];
    for (const s of spans) {
      const p = s.parentId !== undefined && s.parentId !== s.spanId ? this.byId.get(s.parentId) : undefined;
      if (!p) roots.push(s);
      else {
        let list = this.kids.get(p.spanId);
        if (!list) this.kids.set(p.spanId, (list = []));
        list.push(s);
      }
    }
    const byStart = (a: Span, b: Span) => a.start - b.start || b.duration - a.duration;
    roots.sort(byStart);
    for (const list of this.kids.values()) list.sort(byStart);
    this.roots = roots;
    let start = Infinity;
    let end = -Infinity;
    for (const s of spans) {
      if (s.start < start) start = s.start;
      if (s.start + s.duration > end) end = s.start + s.duration;
    }
    this.start = spans.length ? start : 0;
    this.end = spans.length ? end : 0;
    const order = spans.slice().sort(byStart);
    const seen = new Set<string>();
    this.services = [];
    for (const s of order) if (!seen.has(s.service)) {
      seen.add(s.service);
      this.services.push(s.service);
    }
  }

  get duration() {
    return this.end - this.start;
  }

  span(id: string) {
    return this.byId.get(id);
  }

  children(s: Span): readonly Span[] {
    return this.kids.get(s.spanId) ?? [];
  }

  parent(s: Span) {
    return s.parentId !== undefined ? this.byId.get(s.parentId) : undefined;
  }

  /** How deep the span is: 0 for a root. */
  depth(s: Span) {
    let d = 0;
    for (let p = this.parent(s); p && d < 10_000; p = this.parent(p)) d++;
    return d;
  }

  /** Duration less the union of its children's intervals (clipped to it). */
  self(s: Span): number {
    let v = this.selfTimes.get(s.spanId);
    if (v !== undefined) return v;
    const end = s.start + s.duration;
    let covered = 0;
    let at = s.start;
    for (const c of this.children(s)) {
      const a = Math.max(at, c.start);
      const b = Math.min(end, c.start + c.duration);
      if (b > a) {
        covered += b - a;
        at = b;
      }
    }
    v = Math.max(0, s.duration - covered);
    this.selfTimes.set(s.spanId, v);
    return v;
  }

  /** The rows of the waterfall, depth-first, skipping what is under a collapsed span. */
  rows(collapsed: ReadonlySet<string> = new Set()): WaterfallRow[] {
    const out: WaterfallRow[] = [];
    const stack: { s: Span; d: number }[] = [];
    for (let i = this.roots.length - 1; i >= 0; i--) stack.push({ s: this.roots[i], d: 0 });
    while (stack.length) {
      const { s, d } = stack.pop()!;
      const kids = this.children(s);
      const c = collapsed.has(s.spanId);
      out.push({ span: s, depth: d, children: kids.length, collapsed: c, self: this.self(s) });
      if (!c) for (let i = kids.length - 1; i >= 0; i--) stack.push({ s: kids[i], d: d + 1 });
    }
    return out;
  }

  /**
   * The critical path: from the root, the child that ends last, and from it the same, back to front — the
   * spans the trace's duration waits on.
   */
  criticalPath(): Set<string> {
    const out = new Set<string>();
    const walk = (s: Span, until: number) => {
      out.add(s.spanId);
      let limit = Math.min(until, s.start + s.duration);
      const kids = this.children(s).slice().sort((a, b) => b.start + b.duration - (a.start + a.duration));
      for (const c of kids) {
        const end = c.start + c.duration;
        if (end <= limit + 1e-9 && end > s.start) {
          walk(c, limit);
          limit = c.start;
        }
      }
    };
    const root = this.roots.slice().sort((a, b) => b.duration - a.duration)[0];
    if (root) walk(root, root.start + root.duration);
    return out;
  }
}
