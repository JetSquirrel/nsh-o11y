/** The service map: the graph traces make, its layout, hit testing, keys and drawing, headless. */
import { describe, expect, test } from "nsh/test";
import { OffscreenCanvas, Path2D } from "nsh";
import { renderServiceMap, renderServiceMapOverlay, serviceGraph, ServiceMapEngine } from "../src/servicegraph";
import { PALETTE_LIGHT } from "../src/palette";
import type { Ctx2D } from "../src/render";
import type { Span } from "../src/traces";
import type { ChartTheme } from "../src/types";
import { checkoutTrace } from "./telemetry";

const THEME: ChartTheme = {
  background: "#ffffff", text: "#111111", muted: "#666666", grid: "#00000022", cursor: "#00000088",
  selection: "#2563eb", surface: "#ffffff", palette: PALETTE_LIGHT, fontFamily: "system-ui", fontSize: 11,
  error: "#cc0000",
};
const PATH = (d: string) => new Path2D(d);

function span(spanId: string, service: string, start: number, duration: number, parentId?: string, status: Span["status"] = "ok"): Span {
  return { spanId, parentId, service, name: `${service} op`, start, duration, status };
}

/** 20 checkout traces 3 s apart, every fifth failing. */
function checkouts() {
  return Array.from({ length: 20 }, (_, i) => checkoutTrace(100 + i, 1_700_000_000_000 + i * 3000, { error: i % 5 === 0 }).spans);
}

function engineFor(traces: Span[][], width = 900, height = 420) {
  const e = new ServiceMapEngine();
  e.setGraph(serviceGraph(traces), PALETTE_LIGHT);
  e.setSize(width, height);
  e.layout();
  return e;
}

describe("graph", () => {
  test("calls cross services; spans within a service are not calls; entries, failures and percentiles", () => {
    const a: Span[] = [
      span("r", "web", 0, 100),
      span("w2", "web", 1, 10, "r"), // inside web: not a call
      span("c1", "api", 2, 40, "r"),
      span("d1", "db", 3, 5, "c1"),
      span("d2", "db", 10, 15, "c1", "error"),
    ];
    const g = serviceGraph([a]);
    expect(g.nodes.map((n) => n.service)).toEqual(["web", "api", "db"]);
    const web = g.nodes[0];
    expect(web.entry).toBe(true);
    expect(web.requests).toBe(1);
    const db = g.nodes[2];
    expect(db.requests).toBe(2);
    expect(db.errors).toBe(1);
    expect(db.p50).toBe(5);
    expect(db.p95).toBe(15);
    expect(g.edges.map((x) => `${x.from}>${x.to}:${x.calls}`).sort()).toEqual(["api>db:2", "web>api:1"]);
    expect(g.edges.find((x) => x.to === "db")!.errors).toBe(1);
    // One trace spans no time: counts, no rates.
    expect(db.rate !== db.rate).toBe(true);
  });

  test("rates over the time the traces span", () => {
    const g = serviceGraph(checkouts());
    expect(g.traces).toBe(20);
    expect(g.seconds).toBe(57);
    const front = g.nodes.find((n) => n.service === "frontend")!;
    expect(Math.abs(front.rate - 20 / 57)).toBeLessThan(1e-9);
    // Every fifth trace fails at the gateway and in payment.
    expect(front.errors).toBe(4);
    const pay = g.edges.find((x) => x.from === "checkout" && x.to === "payment")!;
    expect(pay.calls).toBe(20);
    expect(pay.errors).toBe(4);
  });
});

describe("layout", () => {
  test("columns follow the calls, from the entry service", () => {
    const e = engineFor(checkouts());
    const col = (s: string) => e.nodes[e.indexOf(s)].layer;
    expect(col("frontend")).toBe(0);
    expect(col("api-gateway")).toBe(1);
    expect(col("auth")).toBe(2);
    expect(col("checkout")).toBe(2);
    for (const s of ["cart", "inventory", "pricing", "payment", "email", "analytics"]) expect(col(s)).toBe(3);
    expect(col("tax")).toBe(4);
    // Every call goes right, nothing goes back.
    for (const x of e.edges) {
      expect(x.back).toBe(false);
      expect(x.pts[6]).toBeGreaterThan(x.pts[0]);
    }
  });

  test("boxes stay inside the view and apart in a column", () => {
    const e = engineFor(checkouts(), 900, 420);
    for (const p of e.nodes) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.x + p.w).toBeLessThanOrEqual(900);
      expect(p.y + p.h).toBeLessThanOrEqual(420);
    }
    const byLayer = new Map<number, typeof e.nodes>();
    for (const p of e.nodes) byLayer.set(p.layer, [...(byLayer.get(p.layer) ?? []), p]);
    for (const ps of byLayer.values()) {
      const ys = ps.map((p) => p.y).sort((a, b) => a - b);
      for (let i = 1; i < ys.length; i++) expect(ys[i] - ys[i - 1]).toBeGreaterThanOrEqual(ps[0].h);
    }
  });

  test("a narrow view narrows the boxes: columns never overlap", () => {
    for (const width of [900, 480, 320, 240]) {
      const e = engineFor(checkouts(), width, 420);
      const byLayer = [...new Set(e.nodes.map((p) => p.layer))].sort((a, b) => a - b);
      const xs = byLayer.map((l) => e.nodes.find((p) => p.layer === l)!);
      for (let i = 1; i < xs.length; i++) expect(xs[i].x).toBeGreaterThanOrEqual(xs[i - 1].x + xs[i - 1].w + 8);
      for (const p of e.nodes) expect(p.x + p.w).toBeLessThanOrEqual(width);
    }
  });

  test("a short view gets one-line boxes, so the fullest column still fits", () => {
    const tall = engineFor(checkouts(), 900, 420);
    expect(tall.compact).toBe(false);
    const short = engineFor(checkouts(), 900, 260);
    expect(short.compact).toBe(true);
    for (const p of short.nodes) expect(p.y + p.h).toBeLessThanOrEqual(260);
    expect(short.nodes[0].h).toBeLessThan(tall.nodes[0].h);
  });

  test("a cycle is drawn, as an edge going back under the boxes", () => {
    const t: Span[] = [span("a", "a", 0, 50), span("b", "b", 1, 40, "a"), span("a2", "a", 2, 10, "b")];
    const e = engineFor([t]);
    expect(e.graph.edges.length).toBe(2);
    const back = e.edges.filter((x) => x.back);
    expect(back.length).toBe(1);
    expect(back[0].edge.from).toBe("b");
    // It dips below both boxes.
    expect(back[0].pts[3]).toBeGreaterThan(Math.max(...e.nodes.map((p) => p.y + p.h)));
  });

  test("no traces: no services, and the map says so", () => {
    const e = engineFor([]);
    expect(e.nodes.length).toBe(0);
    const cx = new OffscreenCanvas(400, 200).getContext("2d") as unknown as Ctx2D;
    const texts: string[] = [];
    const fill = cx.fillText.bind(cx);
    cx.fillText = (t: string, x: number, y: number) => {
      texts.push(t);
      fill(t, x, y);
    };
    renderServiceMap(cx, e, THEME, PATH);
    expect(texts).toEqual(["No services"]);
  });
});

describe("input", () => {
  test("hit testing finds boxes and curves", () => {
    const e = engineFor(checkouts());
    const p = e.nodes[e.indexOf("payment")];
    expect(e.nodeAt(p.x + p.w / 2, p.y + p.h / 2)).toBe(p.index);
    expect(e.nodeAt(1, 1)).toBe(-1);
    const x = e.edges.find((x) => x.edge.from === "frontend")!;
    // The curve's middle: it starts and ends at the same height's midpoint between them.
    const [x1, y1, , , , , x2, y2] = x.pts;
    const mid = e.edgeAt((x1 + x2) / 2, (y1 + y2) / 2);
    expect(mid).toBe(x.index);
  });

  test("hovering a service lights it, its callers and its callees", () => {
    const e = engineFor(checkouts());
    e.hoverNode = e.indexOf("checkout");
    expect(e.nodeLit(e.indexOf("payment"))).toBe(true);
    expect(e.nodeLit(e.indexOf("api-gateway"))).toBe(true);
    expect(e.nodeLit(e.indexOf("tax"))).toBe(false);
    const toTax = e.edges.find((x) => x.edge.to === "tax")!;
    expect(e.edgeLit(toTax.index)).toBe(false);
  });

  test("keys: right to the busiest callee, left to a caller, up and down in a column, Home and End", () => {
    const e = engineFor(checkouts());
    const name = (i: number) => e.graph.nodes[i].service;
    expect(name(e.neighbor("right"))).toBe("frontend"); // nothing selected: the first
    e.selected = e.indexOf("frontend");
    expect(name(e.neighbor("right"))).toBe("api-gateway");
    e.selected = e.indexOf("tax");
    expect(name(e.neighbor("left"))).toBe("pricing");
    expect(name(e.neighbor("right"))).toBe("tax"); // no callee: stays
    e.selected = e.indexOf("auth");
    const down = name(e.neighbor("down"));
    const up = name(e.neighbor("up"));
    expect([down, up]).toContain("checkout");
    expect(name(e.neighbor("first"))).toBe("frontend");
    expect(name(e.neighbor("last"))).toBe("tax");
  });

  test("tooltips: a service's numbers and neighbors, a call's", () => {
    const e = engineFor(checkouts());
    const lines = e.nodeLines(e.indexOf("payment")).map((l) => l.text);
    expect(lines[0]).toBe("payment");
    expect(lines.some((t) => t.startsWith("4 failed"))).toBe(true);
    expect(lines).toContain("called by checkout");
    const edge = e.edges.find((x) => x.edge.from === "checkout" && x.edge.to === "payment")!;
    expect(e.edgeLines(edge.index)[0].text).toBe("checkout → payment");
  });
});

describe("drawing", () => {
  test("every service is named, failures in the theme's error color, the tooltip on hover and when pinned", () => {
    const e = engineFor(checkouts());
    const cx = new OffscreenCanvas(900, 420).getContext("2d") as unknown as Ctx2D;
    e.measure = (t) => cx.measureText(t).width;
    const drawn: { text: string; color: unknown }[] = [];
    const fill = cx.fillText.bind(cx);
    cx.fillText = (t: string, x: number, y: number) => {
      drawn.push({ text: t, color: cx.fillStyle });
      fill(t, x, y);
    };
    e.selected = e.indexOf("payment");
    renderServiceMap(cx, e, THEME, PATH);
    for (const s of e.graph.nodes) expect(drawn.some((d) => d.text === s.service || d.text.startsWith(s.service.slice(0, 3)))).toBe(true);
    // payment fails 4 in 20+: its share is written in the error color.
    expect(drawn.some((d) => d.text.endsWith("%") && d.color === "#cc0000")).toBe(true);
    expect(e.errorColor).toBe("#cc0000");
    const before = drawn.length;
    e.pinned = true;
    renderServiceMapOverlay(cx, e, THEME);
    expect(drawn.length).toBeGreaterThan(before);
    e.pinned = false;
    e.hoverEdge = 0;
    e.pointer = { x: 100, y: 100 };
    renderServiceMapOverlay(cx, e, THEME);
  });
});
