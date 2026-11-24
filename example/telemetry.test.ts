/** Logs, traces and profiles headless: the stores and models against brute force, the engines, the renderers. */
import { describe, expect, test } from "nsh/test";
import { OffscreenCanvas, Path2D } from "nsh";
import { LogStore, LOG_LEVELS, type LogEntry, type LogLevel } from "../src/logs";
import { LogVolumeEngine, renderLogVolume, renderLogVolumeOverlay } from "../src/logvolume";
import { TraceModel, type Span } from "../src/traces";
import { WaterfallEngine, renderWaterfall, renderWaterfallOverlay } from "../src/waterfall";
import { ancestry, matchedValue, profileFromFolded, profileFromTree, topFunctions } from "../src/profile";
import { FlameEngine, colorKey, renderFlame, renderFlameOverlay } from "../src/flame";
import { fitText } from "../src/draw";
import { timeStep } from "../src/scale";
import { PALETTE_LIGHT } from "../src/palette";
import type { Ctx2D } from "../src/render";
import type { ChartTheme } from "../src/types";
import { rng } from "./data";
import { checkoutProfile, checkoutTrace, serviceLogs } from "./telemetry";

const THEME: ChartTheme = {
  background: "#ffffff", text: "#111111", muted: "#666666", grid: "#00000022", cursor: "#00000088",
  selection: "#2563eb", surface: "#ffffff", palette: PALETTE_LIGHT, fontFamily: "system-ui", fontSize: 11,
};
const PATH = (d: string) => new Path2D(d);
const ctx = (w: number, h: number) => new OffscreenCanvas(w, h).getContext("2d") as unknown as Ctx2D;

function randomLogs(n: number, seed = 1): LogEntry[] {
  const r = rng(seed);
  const words = ["timeout", "connected", "payment failed", "cache hit", "retrying", "OK"];
  const out: LogEntry[] = [];
  let t = 1_700_000_000_000;
  for (let i = 0; i < n; i++) {
    t += Math.floor(r() * 500);
    out.push({ time: t, level: LOG_LEVELS[Math.floor(r() * 6)], message: `${words[Math.floor(r() * words.length)]} #${i}`, service: r() < 0.5 ? "api" : "db" });
  }
  return out;
}

describe("logs", () => {
  test("query matches a brute-force filter", () => {
    const entries = randomLogs(5000);
    const s = LogStore.from(entries);
    const levels: LogLevel[] = ["warn", "error"];
    const from = entries[1000].time;
    const to = entries[4000].time;
    const got = s.query({ levels, text: "PAYMENT", from, to }).map((i) => s.get(i));
    const want = entries.filter((e) => levels.includes(e.level) && e.message.toLowerCase().includes("payment") && e.time >= from && e.time <= to);
    expect(got.length).toBe(want.length);
    expect(got.every((e, i) => e === want[i])).toBe(true);
    // Service names are searched too.
    expect(s.query({ text: "db" }).length).toBe(entries.filter((e) => e.service === "db").length);
  });

  test("level counts and the histogram add up", () => {
    const entries = randomLogs(3000, 2);
    const s = LogStore.from(entries);
    const c = s.levelCounts();
    expect(LOG_LEVELS.reduce((a, l) => a + c[l], 0)).toBe(3000);
    for (const l of LOG_LEVELS) expect(c[l]).toBe(entries.filter((e) => e.level === l).length);
    const [t0, t1] = s.extent()!;
    const h = s.histogram(t0, t1, timeStep((t1 - t0) / 50));
    let sum = 0;
    for (const l of LOG_LEVELS) for (const v of h.counts[l]) sum += v;
    expect(sum).toBe(3000);
    expect(h.max).toBeGreaterThan(0);
  });

  test("out-of-order appends land in order, and the oldest are dropped", () => {
    const s = new LogStore({ maxEntries: 50 });
    for (let i = 0; i < 100; i++) s.append({ time: (i * 37) % 100, level: "info", message: String(i) });
    expect(s.length()).toBe(50);
    for (let i = 1; i < s.length(); i++) expect(s.get(i).time).toBeGreaterThanOrEqual(s.get(i - 1).time);
    expect(s.get(s.length() - 1).time).toBe(99);
  });

  test("the generated logs link to traces", () => {
    const src = serviceLogs(3, [[60_000, 90_000]]);
    const lines = src.next(0, 120_000);
    expect(lines.length).toBeGreaterThan(500);
    const linked = lines.filter((l) => l.traceId);
    expect(linked.length).toBeGreaterThan(50);
    expect(src.trace(linked[linked.length - 1].traceId!)).toBeDefined();
    // More errors during the incident.
    const errs = (a: number, b: number) => lines.filter((l) => l.level === "error" && l.time >= a && l.time < b).length;
    expect(errs(60_000, 90_000)).toBeGreaterThan(errs(0, 30_000));
  });

  test("the volume histogram lays out, finds buckets and draws", () => {
    const s = LogStore.from(randomLogs(2000, 4));
    const e = new LogVolumeEngine();
    e.setSize(600, 100);
    const [t0, t1] = s.extent()!;
    e.update(s, {}, t0, t1);
    expect(e.plot.width).toBeGreaterThan(500);
    const k = e.bucketAt(e.plot.left + e.plot.width / 2);
    expect(k).toBeGreaterThanOrEqual(0);
    expect(e.bucketLines(k)[0].text).toContain("line");
    e.selection = { from: e.plot.left + 100, to: e.plot.left + 200 };
    const r = e.endSelection()!;
    expect(r[1]).toBeGreaterThan(r[0]);
    const cx = ctx(600, 100);
    e.measure = (t) => cx.measureText(t).width;
    e.range = r;
    e.hover = k;
    renderLogVolume(cx, e, THEME, PATH);
    renderLogVolumeOverlay(cx, e, THEME);
  });
});

function tree(): Span[] {
  return [
    { spanId: "a", name: "root", service: "web", start: 0, duration: 100 },
    { spanId: "b", parentId: "a", name: "db", service: "db", start: 10, duration: 30 },
    { spanId: "c", parentId: "a", name: "cache", service: "cache", start: 20, duration: 30 },
    { spanId: "d", parentId: "b", name: "query", service: "db", start: 12, duration: 20, status: "error" },
    { spanId: "e", parentId: "a", name: "render", service: "web", start: 60, duration: 35 },
    { spanId: "x", parentId: "missing", name: "orphan", service: "web", start: 5, duration: 5 },
  ];
}

describe("traces", () => {
  test("rows are depth-first in start order; collapsing hides the subtree", () => {
    const m = new TraceModel(tree());
    expect(m.rows().map((r) => r.span.spanId)).toEqual(["a", "b", "d", "c", "e", "x"]);
    expect(m.rows().map((r) => r.depth)).toEqual([0, 1, 2, 1, 1, 0]);
    expect(m.rows(new Set(["b"])).map((r) => r.span.spanId)).toEqual(["a", "b", "c", "e", "x"]);
    expect(m.services).toEqual(["web", "db", "cache"]);
    expect(m.duration).toBe(100);
  });

  test("self time leaves out what children cover, overlaps counted once", () => {
    const m = new TraceModel(tree());
    // root 100, children cover [10,50] ∪ [60,95] = 75.
    expect(m.self(m.span("a")!)).toBe(25);
    expect(m.self(m.span("b")!)).toBe(10);
  });

  test("the critical path goes through what the trace waits on", () => {
    const m = new TraceModel(tree());
    const p = m.criticalPath();
    expect(p.has("a")).toBe(true);
    expect(p.has("e")).toBe(true);
    expect(p.has("c")).toBe(true);
  });

  test("the generated checkout trace is one tree", () => {
    const { spans } = checkoutTrace(5, 1000, { error: true });
    const m = new TraceModel(spans);
    expect(m.roots.length).toBe(1);
    expect(spans.length).toBeGreaterThan(20);
    expect(spans.some((s) => s.status === "error")).toBe(true);
    for (const s of spans) {
      const p = m.parent(s);
      if (p) expect(s.start).toBeGreaterThanOrEqual(p.start);
    }
  });

  test("the waterfall zooms, scrolls, hit-tests and draws", () => {
    const { spans } = checkoutTrace(6, 0);
    const m = new TraceModel(spans);
    const e = new WaterfallEngine();
    e.setSize(900, 200);
    e.setModel(m, PALETTE_LIGHT);
    e.setRows(m.rows());
    expect(Math.abs(e.v1 - (m.duration))).toBeLessThan(1e-6);
    expect(e.rowAt(e.header + 1)).toBe(0);
    expect(e.rowAt(5)).toBe(-1);
    e.scrollBy(1e6);
    expect(e.scrollY).toBe(e.contentHeight - (200 - e.header));
    e.reveal(0);
    expect(e.scrollY).toBe(0);
    const mid = e.timeline.left + e.timeline.width / 2;
    const at = e.fromPx(mid);
    e.zoomAt(4, mid);
    expect(e.zoomed).toBe(true);
    expect(Math.abs(e.fromPx(mid) - (at))).toBeLessThan(1e-6);
    e.panBy(-1e6);
    expect(Math.abs(e.v1 - (m.duration))).toBeLessThan(1e-6);
    e.reset();
    expect(e.zoomed).toBe(false);
    expect(e.toggleAt(0)).not.toBeNull();
    const cx = ctx(900, 200);
    e.measure = (t) => cx.measureText(t).width;
    e.selected = 1;
    e.hover = 2;
    e.pointer = { x: 600, y: 60 };
    renderWaterfall(cx, e, THEME, PATH);
    renderWaterfallOverlay(cx, e, THEME);
    expect(e.rowLines(2).length).toBeGreaterThan(2);
  });

  test("ten thousand spans draw only the rows in view", () => {
    const spans: Span[] = [{ spanId: "r", name: "root", service: "s0", start: 0, duration: 10_000 }];
    for (let i = 0; i < 10_000; i++) spans.push({ spanId: `s${i}`, parentId: "r", name: `op ${i}`, service: `s${i % 6}`, start: i, duration: 5 });
    const m = new TraceModel(spans);
    const e = new WaterfallEngine();
    e.setSize(900, 400);
    e.setModel(m, PALETTE_LIGHT);
    e.setRows(m.rows());
    const cx = ctx(900, 400);
    let texts = 0;
    const counting = new Proxy(cx, {
      get(target, key) {
        const v = (target as any)[key];
        if (key === "fillText") return (...a: unknown[]) => (texts++, v.apply(target, a));
        return typeof v === "function" ? v.bind(target) : v;
      },
      set(target, key, value) {
        (target as any)[key] = value;
        return true;
      },
    });
    const t0 = Date.now();
    renderWaterfall(counting as Ctx2D, e, THEME, PATH);
    expect(texts).toBeLessThan(100);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});

describe("profiles", () => {
  test("folded stacks become a tree with totals and self values", () => {
    const p = profileFromFolded("main;a;b 3\nmain;a 2\nmain;c 5\n# comment\nbad line\n");
    expect(p.value).toBe(10);
    const main = p.children[0];
    expect(main.name).toBe("main");
    expect(main.value).toBe(10);
    const a = main.children.find((c) => c.name === "a")!;
    expect(a.value).toBe(5);
    expect(a.self).toBe(2);
    expect(ancestry(a.children[0]).map((n) => n.name)).toEqual(["all", "main", "a", "b"]);
  });

  test("a tree without values sums its children", () => {
    const p = profileFromTree({ name: "root", children: [{ name: "x", value: 4 }, { name: "y", value: 6, children: [{ name: "z", value: 2 }] }] });
    expect(p.value).toBe(10);
    expect(p.self).toBe(0);
    expect(p.children[0].name).toBe("y");
    expect(p.children[0].self).toBe(4);
  });

  test("top functions count recursion once; search sums outermost matches", () => {
    const p = profileFromFolded("f;g;f 4\nf 1\nh;g 5\n");
    const top = topFunctions(p);
    const f = top.find((t) => t.name === "f")!;
    expect(f.total).toBe(5);
    expect(f.self).toBe(5);
    expect(top.find((t) => t.name === "g")!.total).toBe(9);
    expect(matchedValue(p, "G")).toBe(9);
    expect(matchedValue(p, "")).toBe(0);
  });

  test("the generated profile has every sample", () => {
    const p = profileFromFolded(checkoutProfile(3, 5000));
    expect(p.value).toBe(5000);
    expect(topFunctions(p, 5).length).toBe(5);
  });

  test("color keys are modules", () => {
    expect(colorKey("checkout/api.(*Router).ServeHTTP")).toBe("checkout");
    expect(colorKey("std::vec::Vec::push")).toBe("std::vec::Vec");
    expect(colorKey("com.example.Foo.bar")).toBe("com.example.Foo");
    expect(colorKey("main")).toBe("main");
  });

  test("the flame engine lays out by value, zooms, hit-tests and draws", () => {
    const p = profileFromFolded(checkoutProfile(3, 5000));
    const e = new FlameEngine();
    e.setRoot(p);
    e.setSize(1000, 300);
    e.layout();
    const root = e.frames.find((f) => f.node === p)!;
    expect(root.w).toBe(1000);
    // Children sit inside their parent, left to right, no wider than it.
    for (const fr of e.frames) {
      const parent = fr.node.parent && e.frames.find((f) => f.node === fr.node.parent);
      if (!parent) continue;
      expect(fr.x).toBeGreaterThanOrEqual(parent.x - 1e-6);
      expect(fr.x + fr.w).toBeLessThanOrEqual(parent.x + parent.w + 1e-6);
    }
    const hit = e.frameAt(500, e.rowHeight * 1.5)!;
    expect(hit.depth).toBe(1);
    e.zoomTo(hit.node);
    e.layout();
    expect(e.frames.find((f) => f.node === hit.node)!.w).toBe(1000);
    expect(e.frames.find((f) => f.node === p)!.above).toBe(true);
    e.direction = "up";
    expect(e.frameAt(10, 300 - 1)!.node).toBe(p);
    const cx = ctx(1000, 300);
    e.highlight = "json";
    e.hover = hit;
    e.pointer = { x: 500, y: 30 };
    renderFlame(cx, e, THEME, PATH);
    renderFlameOverlay(cx, e, THEME);
    expect(e.frameLines(hit)[1].text).toContain("%");
  });

  test("the keyboard cursor walks parents, children and rows", () => {
    const p = profileFromFolded("main;a;x 6\nmain;a;y 2\nmain;b;z 4\nidle 1\n");
    const e = new FlameEngine();
    e.setRoot(p);
    e.setSize(800, 200);
    e.layout();
    expect(e.moveCursor("child")).toBe(true); // the first press lands on the focus
    expect(e.cursor).toBe(p);
    e.moveCursor("child");
    expect(e.cursor!.name).toBe("main");
    e.moveCursor("child");
    expect(e.cursor!.name).toBe("a");
    e.moveCursor("child");
    expect(e.cursor!.name).toBe("x");
    // Along the row, across parents: x, y (under a), z (under b).
    e.moveCursor("next");
    expect(e.cursor!.name).toBe("y");
    e.moveCursor("next");
    expect(e.cursor!.name).toBe("z");
    expect(e.moveCursor("next")).toBe(false);
    expect(e.moveCursor("child")).toBe(false);
    // Zoomed to b, the row holds only b's callees; going up past the focus zooms out.
    e.zoomTo(e.cursor!.parent);
    expect(e.cursor!.name).toBe("z");
    expect(e.moveCursor("prev")).toBe(false);
    e.moveCursor("parent");
    e.moveCursor("parent");
    expect(e.cursor!.name).toBe("main");
    // Callers of the focus are drawn (dimmed), so walking onto them keeps the zoom.
    expect(e.focus!.name).toBe("b");
    e.moveCursor("parent");
    expect(e.cursor).toBe(p);
    expect(e.focus!.name).toBe("b");
    // Down from a caller to a callee outside the zoomed part (a, not b): zoom out to keep it in view.
    e.moveCursor("child");
    expect(e.cursor!.name).toBe("main");
    e.moveCursor("child");
    expect(e.cursor!.name).toBe("a");
    expect(e.focus).toBe(p);
    // Zooming to somewhere the cursor isn't brings the cursor along.
    e.zoomTo(p.children[0].children[0]);
    expect(e.cursor!.name).toBe("a"); // the focus itself: still in view
    e.cursor = p.children.find((c) => c.name === "idle")!;
    e.zoomTo(p.children[0]);
    expect(e.cursor).toBe(p.children[0]);
    // The cursor draws, and a deep row scrolls into view.
    e.layout();
    e.setSize(800, 40);
    e.revealDepth(3);
    expect(e.yOf(3)).toBeGreaterThanOrEqual(0);
    expect(e.yOf(3) + e.rowHeight).toBeLessThanOrEqual(40);
    renderFlameOverlay(ctx(800, 40), e, THEME);
  });

  test("text is cut to fit", () => {
    const cx = ctx(100, 100);
    cx.font = "11px system-ui";
    const t = fitText(cx, "11px system-ui", "a fairly long function name indeed", 60);
    expect(t.endsWith("…")).toBe(true);
    expect(cx.measureText(t).width).toBeLessThanOrEqual(60);
    expect(fitText(cx, "11px system-ui", "short", 200)).toBe("short");
    expect(fitText(cx, "11px system-ui", "anything", 3)).toBe("");
  });
});
