/**
 * `<TimeSeriesChart>`: an interactive time series chart on native canvases.
 *
 * Two canvases sit on top of each other. The lower one draws the grid, the axes and the series and only
 * runs again when the data, the viewport, the size or the theme change; the upper one draws the crosshair
 * and the zoom box and runs on every pointer move at the cost of a few calls. Series are decimated per
 * pixel column (M4) from a min/max pyramid, so a frame costs about the same at ten thousand points as at
 * ten million.
 *
 * Drag across the plot to zoom to a range, scroll or pinch to zoom, Shift + scroll (or a sideways swipe)
 * to pan, double-click to go back to following the data. With the keyboard: arrows move the cursor, plus
 * and minus zoom, Backspace goes back a zoom, 0 resets.
 */
import {
  Canvas,
  Path2D,
  Text,
  View,
  cleanup,
  colorScheme,
  computed,
  effect,
  signal,
  token,
  untracked,
  type GestureResponderEvent,
  type KeyEvent,
  type MouseEvent,
  type PinchEvent,
  type ViewStyle,
  type WheelEvent,
} from "nsh";
import { ChartEngine } from "./chart";
import type { ChartController } from "./controller";
import { PALETTE_DARK, PALETTE_LIGHT, withAlpha } from "./palette";
import { fontOf, measureCached, renderOverlay, renderPlot, type Ctx2D } from "./render";
import { formatTimeFull, type TimeZone, type Unit } from "./scale";
import { TimeSeries, type SeriesStore } from "./store";
import type { ChartSync } from "./sync";
import type { Annotation, ChartColors, ChartTheme, CursorInfo, SeriesOptions, Threshold } from "./types";

/** Data as plain arrays: times (ms) and one array of values per series. */
export interface ArrayData {
  x: ArrayLike<number>;
  ys: ArrayLike<number>[];
}

export interface TimeSeriesChartProps {
  /** The samples: a store from `createTimeSeries` (appended to live) or plain arrays. */
  data: SeriesStore | ArrayData;
  /** How each series (each y column) is drawn and named. */
  series: SeriesOptions[];
  /** A title over the chart. */
  title?: string;
  /** The unit values are in: axis labels and the legend's readout. Default "short" (1.2k, 3.4M). */
  unit?: Unit;
  /** Fixed ends of the y range (null: auto). */
  yMin?: number | null;
  yMax?: number | null;
  /** Ends the auto-scaled y range always includes: 0 for rates and counts. */
  softMin?: number;
  softMax?: number;
  /** Live: show the last `window` ms of data, following it as samples come in. Default: all of it. */
  window?: number;
  /** Horizontal lines: SLOs, alert thresholds. */
  thresholds?: Threshold[];
  /** Moments and spans marked on the time axis: deploys, incidents. */
  annotations?: Annotation[];
  /** Times on the axis in local time or UTC. Default "local". */
  timeZone?: TimeZone;
  /** The legend under the plot, with each series' value at the cursor (or its last). Default true. */
  legend?: boolean;
  /** What dragging across the plot does with a mouse: draw a box to zoom to (the default) or pan. Shift
   * pans either way; fingers always pan. */
  dragMode?: "zoom" | "pan";
  /** Links charts: a shared crosshair and zoom (`createChartSync()`). */
  sync?: ChartSync;
  /** An imperative handle: zoom, reset, export (`createChartController()`). */
  controller?: ChartController;
  colors?: ChartColors;
  /** Default "system-ui". */
  fontFamily?: string;
  /** Axis text size in points. Default 11. */
  fontSize?: number;
  /** The cursor moved to a sample, or off the chart (null). */
  onCursor?: (info: CursorInfo | null) => void;
  /** The user zoomed or panned (a range), or went back to following the data (null). */
  onRangeChange?: (range: [number, number] | null) => void;
  style?: ViewStyle;
  class?: string;
  testID?: string;
  /** What screen readers call the chart. Default: the title, or "Time series chart". */
  accessibilityLabel?: string;
}

const KEYS = ["left", "right", "shift+left", "shift+right", "plus", "shift+plus", "minus", "0", "escape", "backspace"] as const;
const DOUBLE_CLICK_MS = 350;
const PATH = (d: string) => new Path2D(d);

function isStore(d: SeriesStore | ArrayData): d is SeriesStore {
  return typeof (d as SeriesStore).trace === "function";
}

export function TimeSeriesChart(props: TimeSeriesChartProps) {
  const engine = new ChartEngine();
  let raf: number | undefined;
  let syncId = 0;
  let lastRange = "";
  let lastFollow = true;
  let lastTap = 0;
  /** When the mouse last hovered: a drag without one is taken for a finger. */
  let lastHover = 0;
  let gesture: { mode: "pending" | "select" | "pan" | "pinch"; origin: number; start: number; last: number; distance: number } | null = null;

  // Bumped to draw each layer again.
  const plotFrame = signal(0);
  const overlayFrame = signal(0);
  // What the legend shows: the cursor's sample, or the last one.
  const readout = signal<CursorInfo | null>(null, { equals: () => false });
  const hidden = signal(0);
  let plotDirty = true;
  let overlayDirty = true;

  const theme = computed<ChartTheme>(() => {
    const c = props.colors ?? {};
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
      surface: c.background ?? token("background"),
      palette: c.palette ?? (dark ? PALETTE_DARK : PALETTE_LIGHT),
      fontFamily: props.fontFamily ?? "system-ui",
      fontSize: props.fontSize ?? 11,
    };
  });

  const loop = () => {
    raf = undefined;
    if (plotDirty) {
      plotDirty = false;
      overlayDirty = false;
      plotFrame.update((n) => n + 1);
    } else if (overlayDirty) {
      overlayDirty = false;
      overlayFrame.update((n) => n + 1);
    }
  };
  const wake = () => {
    if (raf === undefined) raf = requestAnimationFrame(loop);
  };
  /** The data or the viewport changed: draw both layers on the next frame. */
  const invalidate = () => {
    plotDirty = true;
    wake();
  };
  /** Only the cursor or the zoom box moved. */
  const invalidateOverlay = () => {
    overlayDirty = true;
    wake();
  };

  /** After a zoom or pan: tell the sync, the controller and the app. */
  const viewChanged = () => {
    const range: [number, number] | null = engine.follow ? null : [engine.x0, engine.x1];
    const key = range ? `${range[0]}|${range[1]}` : "follow";
    if (key === lastRange) return;
    lastRange = key;
    if (props.sync) props.sync._setRange(range, syncId);
    props.onRangeChange?.(range);
  };

  const report = () => {
    const c = props.controller;
    if (c) {
      c._report({ range: [engine.x0, engine.x1] });
      if (engine.follow !== lastFollow) c._report({ follow: engine.follow });
    }
    lastFollow = engine.follow;
  };

  const cursorChanged = () => {
    const info = engine.cursorInfo();
    readout.set(info ?? engine.infoAt(-1));
    props.controller?._report({ cursor: info });
    props.onCursor?.(info);
  };

  // ---- Props into the engine

  const store = computed<SeriesStore>(() => {
    const d = props.data;
    if (isStore(d)) return d;
    return untracked(() => TimeSeries.from(d.x, d.ys));
  });

  effect(() => {
    const st = store();
    untracked(() => {
      engine.setStore(st);
      invalidate();
    });
    const off = st.subscribe(() => {
      invalidate();
      // The readout follows the newest sample while the cursor is off the chart.
      if (engine.cursorIndex < 0) readout.set(engine.infoAt(-1));
    });
    cleanup(off);
  });

  effect(() => {
    const series = props.series;
    const palette = theme().palette;
    untracked(() => {
      engine.setSeries(series, palette);
      readout.set(engine.cursorInfo() ?? engine.infoAt(-1));
      invalidate();
    });
  });

  effect(() => {
    engine.setOptions({
      unit: props.unit ?? "short",
      yMin: props.yMin ?? null,
      yMax: props.yMax ?? null,
      softMin: props.softMin,
      softMax: props.softMax,
      window: props.window ?? 0,
      timeZone: props.timeZone ?? "local",
      thresholds: props.thresholds ?? [],
      annotations: props.annotations ?? [],
      fontSize: props.fontSize ?? 11,
    });
    untracked(invalidate);
  });

  effect(() => {
    const c = props.controller;
    if (!c) return;
    c._attach(engine, () => {
      invalidate();
      untracked(viewChanged);
      untracked(() => hidden.update((n) => n + 1));
    }, () => untracked(theme));
    cleanup(() => c._detach(engine));
  });

  // Linked charts: follow the others' cursor and zoom.
  effect(() => {
    const sync = props.sync;
    if (!sync) return;
    syncId = sync._join();
    effect(() => {
      const c = sync._cursor();
      if (c.from === syncId) return;
      untracked(() => {
        if (engine.setCursorTime(c.time)) cursorChanged();
        invalidateOverlay();
      });
    });
    effect(() => {
      const r = sync._range();
      if (r.from === syncId) return;
      untracked(() => {
        if (r.range) engine.setXRange(r.range[0], r.range[1], false);
        else engine.reset();
        lastRange = r.range ? `${r.range[0]}|${r.range[1]}` : "follow";
        invalidate();
      });
    });
  });

  cleanup(() => {
    if (raf !== undefined) cancelAnimationFrame(raf);
    raf = undefined;
  });

  // ---- Input

  const setCursor = (px: number | null) => {
    const changed = engine.setCursor(px);
    if (changed) {
      cursorChanged();
      const st = engine.store;
      props.sync?._setCursor(engine.cursorIndex >= 0 && st ? st.x(engine.cursorIndex) : null, syncId);
    }
    if (changed || engine.selection) invalidateOverlay();
  };

  const onGrant = (e: GestureResponderEvent) => {
    const origin = e.pageX - e.locationX;
    gesture = { mode: "pending", origin, start: e.locationX, last: e.locationX, distance: 0 };
    if (e.touches.length >= 2) startPinch(e);
    return true;
  };

  const startPinch = (e: GestureResponderEvent) => {
    if (!gesture) return;
    gesture.mode = "pinch";
    engine.selection = null;
    gesture.distance = Math.max(1, Math.abs(e.touches[1].pageX - e.touches[0].pageX));
    gesture.last = (e.touches[0].pageX + e.touches[1].pageX) / 2 - gesture.origin;
  };

  const onMove = (e: GestureResponderEvent) => {
    const g = gesture;
    if (!g) return;
    if (e.touches.length >= 2) {
      if (g.mode !== "pinch") startPinch(e);
      const d = Math.max(1, Math.abs(e.touches[1].pageX - e.touches[0].pageX));
      const center = (e.touches[0].pageX + e.touches[1].pageX) / 2 - g.origin;
      engine.panBy(center - g.last);
      engine.zoomAt(d / g.distance, center);
      g.distance = d;
      g.last = center;
      invalidate();
      viewChanged();
      return;
    }
    const x = e.pageX - g.origin;
    if (g.mode === "pending" && Math.abs(x - g.start) > 4) {
      // A mouse drags a zoom box (or pans with dragMode "pan", or Shift held); a finger pans: it has
      // no hover, so a pointer that has not hovered lately is taken for one.
      const touch = Date.now() - lastHover > 1500;
      const pan = touch || (props.dragMode ?? "zoom") === "pan" || !!e.modifiers?.shift;
      g.mode = pan ? "pan" : "select";
      if (g.mode === "select") engine.beginSelection(g.start);
    }
    if (g.mode === "select") {
      engine.moveSelection(x);
      setCursor(x);
      invalidateOverlay();
    } else if (g.mode === "pan") {
      engine.panBy(x - g.last);
      invalidate();
      viewChanged();
    }
    g.last = x;
  };

  const onRelease = (e: GestureResponderEvent) => {
    const g = gesture;
    gesture = null;
    if (!g) return;
    if (g.mode === "select") {
      if (engine.endSelection()) {
        invalidate();
        viewChanged();
      } else invalidateOverlay();
      return;
    }
    if (g.mode !== "pending") return;
    // A tap: put the cursor there (touch has no hover); two quick ones go back to following.
    const now = Date.now();
    if (now - lastTap < DOUBLE_CLICK_MS) {
      lastTap = 0;
      engine.reset();
      invalidate();
      viewChanged();
      return;
    }
    lastTap = now;
    setCursor(e.pageX - g.origin);
  };

  const onTerminate = () => {
    gesture = null;
    engine.selection = null;
    invalidateOverlay();
  };

  const onWheel = (e: WheelEvent) => {
    const m = e.modifiers;
    const x = e.position.x;
    if (e.deltaMode === "lines") {
      if (m.shift) engine.panBy(-e.delta.y * 40);
      else engine.zoomAt(Math.exp(-Math.max(-3, Math.min(3, e.delta.y)) * 0.15), x);
    } else if (m.control || m.platform) {
      engine.zoomAt(Math.exp(-e.delta.y * 0.01), x);
    } else if (m.shift || Math.abs(e.delta.x) > Math.abs(e.delta.y)) {
      engine.panBy(-(Math.abs(e.delta.x) > Math.abs(e.delta.y) ? e.delta.x : e.delta.y));
    } else {
      engine.zoomAt(Math.exp(-e.delta.y * 0.004), x);
    }
    engine.setCursor(x);
    invalidate();
    viewChanged();
  };

  const onPinch = (e: PinchEvent) => {
    engine.zoomAt(1 + e.delta, e.position.x);
    invalidate();
    viewChanged();
  };

  const onMouseMove = (e: MouseEvent) => {
    lastHover = Date.now();
    if (gesture) return;
    setCursor(engine.inPlot(e.position.x, e.position.y) || engine.cursorPx !== null ? e.position.x : null);
  };

  const onMouseLeave = () => {
    if (gesture) return;
    setCursor(null);
  };

  const onKeyDown = (e: KeyEvent) => {
    const fast = !!e.modifiers?.shift;
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowRight": {
        engine.stepCursor((e.key === "ArrowLeft" ? -1 : 1) * (fast ? 10 : 1));
        cursorChanged();
        const st = engine.store;
        props.sync?._setCursor(engine.cursorIndex >= 0 && st ? st.x(engine.cursorIndex) : null, syncId);
        invalidate();
        viewChanged();
        return;
      }
      case "+":
      case "=":
        engine.zoomAt(1.5, engine.cursorPx ?? engine.plot.left + engine.plot.width / 2);
        break;
      case "-":
        engine.zoomAt(1 / 1.5, engine.cursorPx ?? engine.plot.left + engine.plot.width / 2);
        break;
      case "Backspace":
        engine.back();
        break;
      case "0":
        engine.reset();
        break;
      case "Escape":
        setCursor(null);
        return;
      default:
        return;
    }
    invalidate();
    viewChanged();
  };

  // ---- Drawing

  /** Brings the engine up to date for the canvas `cx` draws on. */
  const prepare = (cx: Ctx2D, width: number, height: number) => {
    const t = untracked(theme);
    const font = fontOf(t);
    cx.font = font;
    engine.measure = (text) => measureCached(cx, font, text);
    engine.setSize(width, height);
    engine.update();
    return t;
  };

  const label = () => {
    const base = props.accessibilityLabel ?? props.title ?? "Time series chart";
    const r = readout();
    if (!r) return `${base}: no data`;
    const vals = r.values.filter((v) => v.show).map((v) => `${v.label} ${v.text}`).join(", ");
    return `${base}: ${formatTimeFull(r.time, engine.x1 - engine.x0, engine.options.timeZone)}, ${vals}`;
  };

  return (
    <View style={{ flexDirection: "column", ...props.style }} class={props.class} testID={props.testID}>
      {props.title ? (
        <Text class="text-sm font-medium text-foreground" style={{ marginBottom: 4 }}>
          {props.title}
        </Text>
      ) : null}
      <View style={{ flex: 1, position: "relative", minHeight: 60 }}>
        <Canvas
          style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, pointerEvents: "none" }}
          draw={(cx, size) => {
            plotFrame();
            theme();
            const t = prepare(cx as unknown as Ctx2D, size.width, size.height);
            renderPlot(cx as unknown as Ctx2D, engine, t, PATH);
            untracked(() => {
              report();
              // The overlay draws after the plot: it reads the layout the plot just made.
              overlayFrame.update((n) => n + 1);
            });
          }}
        />
        <Canvas
          style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
          testID={props.testID ? `${props.testID}-plot` : undefined}
          role="image"
          accessibilityLabel={label()}
          accessibilityHint="Arrow keys move the cursor, plus and minus zoom, Backspace goes back, 0 resets"
          focusable
          captureKeys={KEYS}
          onKeyDown={onKeyDown}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderTerminationRequest={() => false}
          onResponderGrant={onGrant}
          onResponderMove={onMove}
          onResponderRelease={onRelease}
          onResponderTerminate={onTerminate}
          onWheel={onWheel}
          onPinch={onPinch}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
          draw={(cx, size) => {
            overlayFrame();
            const t = untracked(theme);
            if (engine.width !== size.width || engine.height !== size.height) prepare(cx as unknown as Ctx2D, size.width, size.height);
            renderOverlay(cx as unknown as Ctx2D, engine, t);
          }}
        />
      </View>
      {(props.legend ?? true) ? (
        <View role="list" accessibilityLabel="Legend" style={{ flexDirection: "row", flexWrap: "wrap", columnGap: 14, rowGap: 4, marginTop: 6 }}>
          <Each of={props.series.map((_, i) => i)}>
            {(i) => {
              const entry = () => {
                hidden();
                return readout()?.values[i()];
              };
              const shown = () => {
                hidden();
                return engine.series[i()]?.show ?? true;
              };
              const color = () => props.series[i()]?.color ?? theme().palette[i() % theme().palette.length];
              return (
                <View
                  role="button"
                  testID={props.testID ? `${props.testID}-legend-${i()}` : undefined}
                  accessibilityState={{ selected: shown() }}
                  accessibilityLabel={`${props.series[i()]?.label}: ${entry()?.text ?? "no value"}`}
                  onPress={() => {
                    engine.toggle(i());
                    hidden.update((n) => n + 1);
                    invalidate();
                  }}
                  style={{ flexDirection: "row", alignItems: "center", gap: 6, opacity: shown() ? 1 : 0.45 }}
                >
                  <View style={{ width: 10, height: 3, borderRadius: 1.5, backgroundColor: color() }} />
                  <Text class="text-xs text-muted-foreground">{props.series[i()]?.label}</Text>
                  <Text class="text-xs text-foreground" style={{ fontVariant: ["tabular-nums"] }}>
                    {entry()?.text ?? "–"}
                  </Text>
                </View>
              );
            }}
          </Each>
        </View>
      ) : null}
    </View>
  );
}
