/**
 * `<ServiceMap>`: the services many traces go through and the calls between them, laid out left to right
 * from the entry services. Each box shows a service's request rate, p95 and share of failures; each edge's
 * width follows its calls, and failing services and calls are drawn in the theme's error color. Drawn on
 * two canvases, as the waterfall is: the map, and the hover and tooltip over it.
 *
 * Hover a service to light it and its callers and callees, an edge for its numbers. Press a service to
 * select it (the app filters by it, say). Keys: arrows move to the busiest callee (→), caller (←) or the
 * next service in the column (↑/↓), Home and End to the first and last service, Escape clears.
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
  type ViewRef,
  type ViewStyle,
} from "nsh";
import { fontOf, measureCached, type Ctx2D } from "./render";
import { formatValue } from "./scale";
import { renderServiceMap, renderServiceMapOverlay, serviceGraph, ServiceMapEngine, type ServiceGraph } from "./servicegraph";
import { resolveTheme } from "./theme";
import type { Span, TraceModel } from "./traces";
import type { ChartColors, ChartTheme } from "./types";

export interface ServiceMapProps {
  /** The traces to map, each its spans or a `TraceModel`; or a graph from `serviceGraph()`, made once. */
  traces: Iterable<readonly Span[] | TraceModel> | ServiceGraph;
  /** The selected service (controlled), by name; null for none. */
  selected?: string | null;
  /** A service or edge whose share of failed calls reaches this is drawn in the error color. Default 0.01. */
  errorThreshold?: number;
  /** Each edge's call rate (or count) written on it. Default true. */
  edgeLabels?: boolean;
  colors?: ChartColors;
  fontFamily?: string;
  fontSize?: number;
  /** A service was selected, or the selection cleared (null). Fires after the map shows it. */
  onSelectedChange?: (change: { selected: string | null }) => void;
  style?: ViewStyle;
  class?: string;
  testID?: string;
  accessibilityLabel?: string;
}

const PATH = (d: string) => new Path2D(d);
const KEYS = ["up", "down", "left", "right", "home", "end", "escape"] as const;

function isGraph(t: ServiceMapProps["traces"]): t is ServiceGraph {
  return Array.isArray((t as ServiceGraph).nodes) && Array.isArray((t as ServiceGraph).edges);
}

export function ServiceMap(props: ServiceMapProps) {
  const e = new ServiceMapEngine();
  const plotFrame = signal(0);
  const overlayFrame = signal(0);
  const selected = signal<string | null>(null);
  let plotRef: ViewRef | undefined;
  /** When the mouse last hovered: a press without one is taken for a finger. */
  let lastHover = 0;
  let origin = { x: 0, y: 0 };

  const theme = computed<ChartTheme>(() => resolveTheme(props.colors, props.fontFamily, props.fontSize));
  const graph = computed<ServiceGraph>(() => {
    const t = props.traces;
    return isGraph(t) ? t : untracked(() => serviceGraph(t));
  });

  const redraw = () => plotFrame.update((n) => n + 1);
  const redrawOverlay = () => overlayFrame.update((n) => n + 1);

  effect(() => {
    const g = graph();
    untracked(() => {
      e.setGraph(g, theme().palette);
      const s = selected();
      e.selected = s ? e.indexOf(s) : -1;
      redraw();
    });
  });
  // A new palette (light and dark, or `colors`): only the colors change.
  effect(() => {
    const palette = theme().palette;
    untracked(() => {
      e.setPalette(palette);
      redraw();
    });
  });
  effect(() => {
    e.options = { errorThreshold: props.errorThreshold ?? 0.01, edgeLabels: props.edgeLabels ?? true };
    untracked(redraw);
  });
  // Controlled selection.
  effect(() => {
    const s = props.selected;
    if (s === undefined) return;
    untracked(() => select(s, false));
  });

  function select(service: string | null, notify = true) {
    const i = service ? e.indexOf(service) : -1;
    const next = i >= 0 ? service : null;
    const changed = next !== untracked(selected);
    selected.set(next);
    e.selected = i;
    redraw();
    if (notify && changed) props.onSelectedChange?.({ selected: next });
  }

  // ---- Input

  const onGrant = (ev: GestureResponderEvent) => {
    plotRef?.focus();
    origin = { x: ev.pageX - ev.locationX, y: ev.pageY - ev.locationY };
    return true;
  };
  const onRelease = (ev: GestureResponderEvent) => {
    const x = ev.pageX - origin.x;
    const y = ev.pageY - origin.y;
    const i = e.nodeAt(x, y);
    // A finger has no hover: its tap shows the service's numbers, pinned to its box.
    e.pinned = Date.now() - lastHover > 1500;
    if (i < 0) {
      e.pinned = false;
      select(null);
    } else {
      const s = e.graph.nodes[i].service;
      select(s === untracked(selected) && !e.pinned ? null : s);
    }
    redrawOverlay();
  };

  const onMouseMove = (ev: MouseEvent) => {
    lastHover = Date.now();
    const { x, y } = ev.position;
    e.pointer = { x, y };
    e.pinned = false;
    const n = e.nodeAt(x, y);
    const edge = n < 0 ? e.edgeAt(x, y) : -1;
    const lit = n !== e.hoverNode || edge !== e.hoverEdge;
    e.hoverNode = n;
    e.hoverEdge = edge;
    // What is lit changes the map; the tooltip only follows the pointer.
    if (lit) redraw();
    else redrawOverlay();
  };
  const onMouseLeave = () => {
    if (e.hoverNode < 0 && e.hoverEdge < 0) return;
    e.hoverNode = -1;
    e.hoverEdge = -1;
    redraw();
  };

  const onKeyDown = (ev: KeyEvent) => {
    const dir =
      ev.key === "ArrowRight" ? "right" : ev.key === "ArrowLeft" ? "left" : ev.key === "ArrowUp" ? "up" : ev.key === "ArrowDown" ? "down" : ev.key === "Home" ? "first" : ev.key === "End" ? "last" : null;
    if (ev.key === "Escape") {
      e.pinned = false;
      select(null);
      redrawOverlay();
      return;
    }
    if (!dir) return;
    const i = e.neighbor(dir);
    if (i >= 0) select(e.graph.nodes[i].service);
  };

  const label = () => {
    const g = graph();
    const base = props.accessibilityLabel ?? "Service map";
    const head = `${base}: ${g.nodes.length} services, ${g.edges.length} calls between them, from ${g.traces} traces`;
    const s = selected();
    const n = s ? g.nodes.find((x) => x.service === s) : undefined;
    if (!n) return head;
    const rate = n.rate === n.rate ? `${formatValue(n.rate, "short")} requests a second` : `${n.requests} requests`;
    const failed = n.errors ? `, ${formatValue(n.errors / n.requests, "percentunit")} failed` : "";
    return `${head}. Selected: ${n.service}, ${rate}, p95 ${formatValue(n.p95, "ms")}${failed}`;
  };

  const prepare = (cx: Ctx2D, width: number, height: number, t: ChartTheme) => {
    const font = fontOf(t);
    cx.font = font;
    e.measure = (s) => measureCached(cx, font, s);
    if (e.width !== width || e.height !== height) e.setSize(width, height);
  };

  cleanup(() => {
    plotRef = undefined;
  });

  return (
    <View style={{ position: "relative", minHeight: 120, ...props.style }} class={props.class} testID={props.testID}>
      <Canvas
        style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, pointerEvents: "none" }}
        draw={(cx, size) => {
          plotFrame();
          const t = theme();
          untracked(() => {
            prepare(cx as unknown as Ctx2D, size.width, size.height, t);
            renderServiceMap(cx as unknown as Ctx2D, e, t, PATH);
            redrawOverlay();
          });
        }}
      />
      <Canvas
        style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
        testID={props.testID ? `${props.testID}-plot` : undefined}
        role="image"
        accessibilityLabel={label()}
        accessibilityHint="Arrow keys move between services, Home and End to the first and last, Escape clears"
        focusable
        ref={(r) => (plotRef = r)}
        captureKeys={KEYS}
        onKeyDown={onKeyDown}
        onStartShouldSetResponder={() => true}
        onResponderGrant={onGrant}
        onResponderRelease={onRelease}
        onMouseMove={onMouseMove}
        onMouseLeave={onMouseLeave}
        draw={(cx, size) => {
          overlayFrame();
          const t = untracked(theme);
          prepare(cx as unknown as Ctx2D, size.width, size.height, t);
          e.fontSize = t.fontSize;
          e.layout();
          renderServiceMapOverlay(cx as unknown as Ctx2D, e, t);
        }}
      />
    </View>
  );
}
