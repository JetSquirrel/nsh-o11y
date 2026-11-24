/** The engine (viewport, auto-scale, zoom, cursor), the scales and the renderer, headless. */
import { describe, expect, test } from "nsh/test";
import { OffscreenCanvas, Path2D } from "nsh";
import { ChartEngine } from "../src/chart";
import { renderOverlay, renderPlot, type Ctx2D } from "../src/render";
import { formatValue, niceRange, timeTicks, valueTicks } from "../src/scale";
import { TimeSeries } from "../src/store";
import { PALETTE_LIGHT } from "../src/palette";
import type { ChartTheme } from "../src/types";

const THEME: ChartTheme = {
  background: "#ffffff", text: "#111111", muted: "#666666", grid: "#00000022", cursor: "#00000088",
  selection: "#2563eb", surface: "#ffffff", palette: PALETTE_LIGHT, fontFamily: "system-ui", fontSize: 11,
};

function engineWith(n: number, step = 1000) {
  const x = new Float64Array(n).map((_, i) => 1_700_000_000_000 + i * step);
  const y = new Float64Array(n).map((_, i) => 50 + Math.sin(i / 50) * 40);
  const e = new ChartEngine();
  e.setStore(TimeSeries.from(x, [y, y.map((v) => v / 2)]));
  e.setSeries([{ label: "a" }, { label: "b" }], PALETTE_LIGHT);
  e.setSize(800, 300);
  e.update();
  return e;
}

describe("engine", () => {
  test("follows the data, or its last window", () => {
    const e = engineWith(1000);
    expect(e.x0).toBe(1_700_000_000_000);
    expect(e.x1).toBe(1_700_000_000_000 + 999_000);
    e.setOptions({ window: 60_000 });
    e.update();
    expect(e.x1 - e.x0).toBe(60_000);
    expect(e.x1).toBe(1_700_000_000_000 + 999_000);
  });

  test("auto-scales y to what is in view, to round ends, with softMin", () => {
    const e = engineWith(1000);
    expect(e.y0).toBeLessThanOrEqual(5);
    expect(e.y1).toBeGreaterThanOrEqual(90);
    e.setOptions({ softMin: 0 });
    e.update();
    expect(e.y0).toBe(0);
    e.toggle(0);
    e.update();
    expect(e.y1).toBeLessThanOrEqual(50);
  });

  test("the plot leaves room for the y labels", () => {
    const e = engineWith(100);
    expect(e.plot.left).toBeGreaterThan(10);
    expect(e.plot.left + e.plot.width).toBeLessThanOrEqual(800);
  });

  test("zooming in and out around a point, and back", () => {
    const e = engineWith(1000);
    const mid = e.plot.left + e.plot.width / 2;
    const at = e.fromPx(mid);
    e.zoomAt(4, mid);
    e.update();
    expect(e.follow).toBe(false);
    expect(Math.abs((e.x1 - e.x0) - 999_000 / 4)).toBeLessThan(1);
    expect(Math.abs(e.fromPx(mid) - at)).toBeLessThan(1);
    // Zooming out past everything follows the data again.
    e.zoomAt(1 / 10, mid);
    expect(e.follow).toBe(true);
  });

  test("a drag box zooms to its range, and back() returns", () => {
    const e = engineWith(1000);
    const a = e.plot.left + 100;
    const b = e.plot.left + 300;
    const ta = e.fromPx(a);
    const tb = e.fromPx(b);
    e.beginSelection(a);
    e.moveSelection(b);
    expect(e.endSelection()).toBe(true);
    expect(e.x0).toBe(ta);
    expect(e.x1).toBe(tb);
    e.back();
    expect(e.follow).toBe(true);
    // A box too narrow is a click.
    e.update();
    e.beginSelection(a);
    e.moveSelection(a + 2);
    expect(e.endSelection()).toBe(false);
  });

  test("panning keeps some data in view", () => {
    const e = engineWith(1000);
    e.zoomAt(10, e.plot.left);
    for (let i = 0; i < 50; i++) e.panBy(400);
    const [d0] = e.dataRange()!;
    expect(e.x1).toBeGreaterThan(d0);
  });

  test("the cursor snaps to the nearest sample and reads every series", () => {
    const e = engineWith(1000);
    e.setCursor(e.toPx(1_700_000_000_000 + 500_400));
    expect(e.cursorIndex).toBe(500);
    const info = e.cursorInfo()!;
    expect(info.values.length).toBe(2);
    expect(info.values[1].value).toBe(info.values[0].value / 2);
    e.stepCursor(3);
    expect(e.cursorIndex).toBe(503);
    e.setCursor(null);
    expect(e.cursorInfo()).toBe(null);
  });

  test("toggle only shows one series, then all again", () => {
    const e = engineWith(10);
    e.toggle(1, true);
    expect(e.series.map((s) => s.show)).toEqual([false, true]);
    e.toggle(1, true);
    expect(e.series.map((s) => s.show)).toEqual([true, true]);
  });
});

describe("scales", () => {
  test("value ticks fall on 1-2-5 steps", () => {
    expect(valueTicks(0, 100, 300, 60)).toEqual([0, 20, 40, 60, 80, 100]);
    expect(valueTicks(-1, 1, 200, 50)).toEqual([-1, -0.5, 0, 0.5, 1]);
  });

  test("nice ranges round out, open up a flat line, and respect softMin", () => {
    expect(niceRange(3, 97, 300)).toEqual([0, 100]);
    const [a, b] = niceRange(5, 5, 300);
    expect(a).toBeLessThan(5);
    expect(b).toBeGreaterThan(5);
    expect(niceRange(40, 60, 300, 0)[0]).toBe(0);
  });

  test("time ticks on whole steps in UTC", () => {
    const t0 = Date.UTC(2026, 0, 1, 10, 3, 7);
    const { step, ticks } = timeTicks(t0, t0 + 3_600_000, 600, 80, "utc");
    expect(step).toBe(10 * 60_000);
    for (const t of ticks) expect(t.value % step).toBe(0);
    expect(ticks[0].label).toBe("10:10");
    const days = timeTicks(Date.UTC(2026, 0, 1), Date.UTC(2026, 0, 31), 800, 80, "utc");
    expect(days.ticks[0].label).toBe("Jan 1");
    const months = timeTicks(Date.UTC(2025, 0, 15), Date.UTC(2026, 6, 1), 600, 80, "utc");
    expect(months.ticks.map((t) => t.label)).toContain("2026");
  });

  test("units", () => {
    expect(formatValue(1234, "short")).toBe("1.23k");
    expect(formatValue(1_500_000, "short", 500_000)).toBe("1.5M");
    expect(formatValue(1536, "bytes")).toBe("1.5 KiB");
    expect(formatValue(0.25, "percentunit")).toBe("25%");
    expect(formatValue(42.5, "percent")).toBe("42.5%");
    expect(formatValue(1500, "ms")).toBe("1.5 s");
    expect(formatValue(0.25, "ms")).toBe("250 µs");
    expect(formatValue(90, "s")).toBe("1.5 min");
    expect(formatValue(1200, "reqps")).toBe("1.2k req/s");
    expect(formatValue(NaN, "short")).toBe("–");
    expect(formatValue(0.004, "short")).toBe("0.004");
    expect(formatValue(3, (v) => `${v}x`)).toBe("3x");
  });
});

describe("rendering", () => {
  test("draws both layers into a real canvas context without errors", () => {
    const e = engineWith(50_000);
    const cx = new OffscreenCanvas(800, 300).getContext("2d") as unknown as Ctx2D;
    e.measure = (t) => cx.measureText(t).width;
    e.setOptions({
      thresholds: [{ value: 60, label: "SLO" }],
      annotations: [{ time: e.x0 + 100_000, label: "deploy" }, { time: e.x0 + 200_000, end: e.x0 + 300_000 }],
    });
    e.series[0].fill = 0.2;
    e.update();
    renderPlot(cx, e, THEME, (d) => new Path2D(d));
    e.setCursor(400);
    e.beginSelection(200);
    e.moveSelection(300);
    renderOverlay(cx, e, THEME);
  });

  test("an empty chart draws axes and no series", () => {
    const e = new ChartEngine();
    e.setStore(new TimeSeries({ series: 1 }));
    e.setSeries([{ label: "a" }], PALETTE_LIGHT);
    e.setSize(400, 200);
    e.update();
    const paths: string[] = [];
    const cx = new OffscreenCanvas(400, 200).getContext("2d") as unknown as Ctx2D;
    renderPlot(cx, e, THEME, (d) => {
      paths.push(d);
      return new Path2D(d);
    });
    expect(paths.length).toBe(1); // the grid
  });
});
