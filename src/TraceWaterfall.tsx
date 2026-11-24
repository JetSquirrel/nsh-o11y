/**
 * `<TraceWaterfall>`: one trace as a waterfall. Each span is a row: its name indented under its parent,
 * and a bar from its start for its duration, colored by service; errors are outlined in red and the
 * critical path underlined. Drawn on two canvases (rows, and the hover and tooltip over them), only the
 * rows in view, so traces of tens of thousands of spans scroll smoothly.
 *
 * Press a row to select it, its triangle to fold its children. Drag across the timeline to zoom to a
 * range, Ctrl/⌘ + scroll to zoom, scroll to move through the rows, Shift + scroll to pan, double-click to
 * zoom back out. Keys: ↑/↓ select, ←/→ fold and unfold, 0 zooms out, Escape clears the selection.
 */
import {
  Canvas,
  Path2D,
  View,
  cleanup,
  computed,
  effect,
  signal,
  untracked,
  type GestureResponderEvent,
  type KeyEvent,
  type MouseEvent,
  type ViewStyle,
  type WheelEvent,
} from "nsh";
import { fontOf, measureCached, type Ctx2D } from "./render";
import { formatValue } from "./scale";
import { resolveTheme } from "./theme";
import { TraceModel, type Span } from "./traces";
import type { ChartColors, ChartTheme } from "./types";
import { renderWaterfall, renderWaterfallOverlay, WaterfallEngine } from "./waterfall";

export interface TraceWaterfallProps {
  /** The trace's spans, or a `TraceModel` made from them. */
  spans: readonly Span[] | TraceModel;
  /** Row height in points. Default 22. */
  rowHeight?: number;
  /** The name column's width in points. Default 280 (at most 45% of the view). */
  labelWidth?: number;
  /** Underline the critical path. Default true. */
  criticalPath?: boolean;
  /** Span ids folded at first. */
  collapsed?: string[];
  /** The selected span (controlled), by id. */
  selected?: string | null;
  colors?: ChartColors;
  fontFamily?: string;
  fontSize?: number;
  /** A span was selected, or the selection cleared (null). */
  onSelect?: (span: Span | null) => void;
  style?: ViewStyle;
  class?: string;
  testID?: string;
  accessibilityLabel?: string;
}

const PATH = (d: string) => new Path2D(d);
const KEYS = ["up", "down", "left", "right", "0", "escape", "enter", "space"] as const;
const DOUBLE_CLICK_MS = 350;

export function TraceWaterfall(props: TraceWaterfallProps) {
  const e = new WaterfallEngine();
  const plotFrame = signal(0);
  const overlayFrame = signal(0);
  const collapsed = signal<ReadonlySet<string>>(new Set(props.collapsed ?? []));
  const selectedId = signal<string | null>(null);
  let gesture: { origin: number; originY: number; startX: number; startY: number; mode: "pending" | "select" | "pan" | "scroll"; last: number; lastY: number } | null = null;
  let lastTap = 0;
  let lastHover = 0;

  const theme = computed<ChartTheme>(() => resolveTheme(props.colors, props.fontFamily, props.fontSize));
  const model = computed<TraceModel>(() => {
    const s = props.spans;
    return s instanceof TraceModel ? s : untracked(() => new TraceModel(s as Span[]));
  });
  const rows = computed(() => model().rows(collapsed()));

  const redraw = () => plotFrame.update((n) => n + 1);
  const redrawOverlay = () => overlayFrame.update((n) => n + 1);

  effect(() => {
    const m = model();
    const palette = theme().palette;
    untracked(() => {
      e.zoomed = false;
      e.setModel(m, palette);
      redraw();
    });
  });
  effect(() => {
    const r = rows();
    untracked(() => {
      e.setRows(r);
      const id = selectedId();
      e.selected = id ? r.findIndex((row) => row.span.spanId === id) : -1;
      redraw();
    });
  });
  effect(() => {
    e.options = { rowHeight: props.rowHeight ?? 22, labelWidth: props.labelWidth ?? 280, criticalPath: props.criticalPath ?? true };
    untracked(redraw);
  });
  // Controlled selection.
  effect(() => {
    const id = props.selected;
    if (id === undefined) return;
    untracked(() => setSelected(id, false));
  });

  function setSelected(id: string | null, notify = true) {
    if (id) {
      // Unfold the ancestors so the row shows.
      const m = untracked(model);
      const open = new Set(untracked(collapsed));
      let changed = false;
      for (let p = m.span(id) && m.parent(m.span(id)!); p; p = m.parent(p)) if (open.delete(p.spanId)) changed = true;
      if (changed) collapsed.set(open);
    }
    selectedId.set(id);
    const r = untracked(rows);
    e.selected = id ? r.findIndex((row) => row.span.spanId === id) : -1;
    if (e.selected >= 0) e.reveal(e.selected);
    redraw();
    if (notify) props.onSelect?.(id ? untracked(model).span(id) ?? null : null);
  }

  const toggle = (i: number) => {
    const row = e.rows[i];
    if (!row || !row.children) return;
    const next = new Set(collapsed());
    if (next.has(row.span.spanId)) next.delete(row.span.spanId);
    else next.add(row.span.spanId);
    collapsed.set(next);
  };

  // ---- Input

  const onGrant = (ev: GestureResponderEvent) => {
    gesture = {
      origin: ev.pageX - ev.locationX,
      originY: ev.pageY - ev.locationY,
      startX: ev.locationX,
      startY: ev.locationY,
      mode: "pending",
      last: ev.locationX,
      lastY: ev.locationY,
    };
    return true;
  };
  const onMove = (ev: GestureResponderEvent) => {
    const g = gesture;
    if (!g) return;
    const x = ev.pageX - g.origin;
    const y = ev.pageY - g.originY;
    if (g.mode === "pending" && (Math.abs(x - g.startX) > 4 || Math.abs(y - g.startY) > 4)) {
      const touch = Date.now() - lastHover > 1500;
      if (touch) g.mode = Math.abs(y - g.startY) > Math.abs(x - g.startX) ? "scroll" : "pan";
      else if (!e.inTimeline(g.startX, g.startY)) g.mode = "scroll";
      else g.mode = ev.modifiers?.shift ? "pan" : "select";
    }
    if (g.mode === "select") {
      e.selection = { from: g.startX, to: x };
      redrawOverlay();
    } else if (g.mode === "pan") {
      e.panBy(x - g.last);
      redraw();
    } else if (g.mode === "scroll") {
      e.scrollBy(g.lastY - y);
      redraw();
    }
    g.last = x;
    g.lastY = y;
  };
  const onRelease = (ev: GestureResponderEvent) => {
    const g = gesture;
    gesture = null;
    if (!g) return;
    if (g.mode === "select") {
      const r = e.endSelection();
      if (r) e.setView(r[0], r[1]);
      redraw();
      return;
    }
    if (g.mode !== "pending") return;
    const x = ev.pageX - g.origin;
    const y = ev.pageY - g.originY;
    const now = Date.now();
    if (now - lastTap < DOUBLE_CLICK_MS && e.inTimeline(x, y)) {
      lastTap = 0;
      e.reset();
      redraw();
      return;
    }
    lastTap = now;
    const i = e.rowAt(y);
    if (i < 0) return;
    const t = e.toggleAt(i);
    if (t && x >= t[0] && x <= t[1]) toggle(i);
    else setSelected(e.rows[i].span.spanId === selectedId() ? null : e.rows[i].span.spanId);
  };
  const onTerminate = () => {
    gesture = null;
    e.selection = null;
    redrawOverlay();
  };

  const onWheel = (ev: WheelEvent) => {
    const m = ev.modifiers;
    const lines = ev.deltaMode === "lines";
    const dy = lines ? ev.delta.y * 40 : ev.delta.y;
    const dx = lines ? ev.delta.x * 40 : ev.delta.x;
    if (m.control || m.platform) e.zoomAt(Math.exp(-(lines ? ev.delta.y * 0.15 : ev.delta.y * 0.01)), ev.position.x);
    else if (m.shift) e.panBy(-(dx || dy));
    else if (Math.abs(dx) > Math.abs(dy)) e.panBy(-dx);
    else e.scrollBy(dy);
    e.hover = e.rowAt(ev.position.y);
    redraw();
  };

  const onMouseMove = (ev: MouseEvent) => {
    lastHover = Date.now();
    if (gesture) return;
    e.pointer = { x: ev.position.x, y: ev.position.y };
    e.hover = e.rowAt(ev.position.y);
    redrawOverlay();
  };
  const onMouseLeave = () => {
    if (gesture) return;
    e.hover = -1;
    redrawOverlay();
  };

  const onKeyDown = (ev: KeyEvent) => {
    const i = e.selected;
    const r = e.rows;
    switch (ev.key) {
      case "ArrowDown":
      case "ArrowUp": {
        const n = Math.max(0, Math.min(r.length - 1, i < 0 ? 0 : i + (ev.key === "ArrowDown" ? 1 : -1)));
        if (r[n]) setSelected(r[n].span.spanId);
        return;
      }
      case "ArrowRight":
        if (i >= 0 && r[i].collapsed) toggle(i);
        else if (i >= 0 && r[i].children && r[i + 1]) setSelected(r[i + 1].span.spanId);
        return;
      case "ArrowLeft":
        if (i >= 0 && r[i].children && !r[i].collapsed) toggle(i);
        else if (i >= 0) {
          const p = untracked(model).parent(r[i].span);
          if (p) setSelected(p.spanId);
        }
        return;
      case "Enter":
      case " ":
        if (i >= 0) toggle(i);
        return;
      case "0":
        e.reset();
        redraw();
        return;
      case "Escape":
        setSelected(null);
        return;
    }
  };

  const label = () => {
    const m = model();
    const base = props.accessibilityLabel ?? "Trace waterfall";
    const sel = selectedId() ? m.span(selectedId()!) : undefined;
    const head = `${base}: ${m.spans.length} spans across ${m.services.length} services, ${formatValue(m.duration, "ms")}`;
    return sel ? `${head}. Selected: ${sel.name}, ${sel.service}, ${formatValue(sel.duration, "ms")}${sel.status === "error" ? ", error" : ""}` : head;
  };

  const prepare = (cx: Ctx2D, width: number, height: number, t: ChartTheme) => {
    const font = fontOf(t);
    cx.font = font;
    e.measure = (s) => measureCached(cx, font, s);
    if (e.width !== width || e.height !== height) e.setSize(width, height);
  };

  cleanup(() => {
    gesture = null;
  });

  return (
    <View style={{ position: "relative", minHeight: 80, ...props.style }} class={props.class} testID={props.testID}>
      <Canvas
        style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, pointerEvents: "none" }}
        draw={(cx, size) => {
          plotFrame();
          const t = theme();
          untracked(() => {
            prepare(cx as unknown as Ctx2D, size.width, size.height, t);
            renderWaterfall(cx as unknown as Ctx2D, e, t, PATH);
            redrawOverlay();
          });
        }}
      />
      <Canvas
        style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
        testID={props.testID ? `${props.testID}-plot` : undefined}
        role="tree"
        accessibilityLabel={label()}
        accessibilityHint="Up and down select a span, left and right fold, 0 zooms out"
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
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        draw={(cx, size) => {
          overlayFrame();
          const t = untracked(theme);
          prepare(cx as unknown as Ctx2D, size.width, size.height, t);
          renderWaterfallOverlay(cx as unknown as Ctx2D, e, t);
        }}
      />
    </View>
  );
}
