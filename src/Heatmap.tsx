/**
 * `<Heatmap>`: a distribution over time (request latencies, say), one column per `step` of a `HeatmapStore`,
 * each cell colored by how many observations fell in it, with percentile lines over it. Where percentiles
 * say "p99 rose", the heatmap shows why: a second band of slow requests, or everything shifting up. Hover
 * a cell for its count and the column's percentiles. With `sync`, it shares the crosshair with the time
 * series charts and follows their zoom.
 */
import { Canvas, Path2D, Text, View, cleanup, computed, effect, signal, untracked, type GestureResponderEvent, type MouseEvent, type ViewStyle } from "nsh";
import { HeatmapEngine, HeatmapStore, PERCENTILE_COLORS, type Exemplar, heatRamp, renderHeatmap, renderHeatmapOverlay } from "./distribution";
import { fontOf, measureCached, type Ctx2D } from "./render";
import { formatValue, type TimeZone, type Unit } from "./scale";
import type { ChartSync } from "./sync";
import { isDark, resolveTheme } from "./theme";
import type { ChartColors, ChartTheme } from "./types";

export interface HeatmapProps {
  data: HeatmapStore;
  title?: string;
  /** The unit values are in. Default "ms". */
  unit?: Unit;
  /** Live: the last `window` ms. Default: all the columns. */
  window?: number;
  /** Lines over the cells at these quantiles. Default [0.5, 0.99]; [] for none. */
  percentiles?: number[];
  /** The color ramp's three stops, faint to strong. */
  ramp?: [string, string, string];
  /** The ramp and percentile key under the plot. Default true. */
  legend?: boolean;
  timeZone?: TimeZone;
  /** Shares the crosshair with linked charts and follows their zoom. */
  sync?: ChartSync;
  /** Draw the store's exemplars. Default true. */
  exemplars?: boolean;
  /** An exemplar was pressed: open its trace. */
  onExemplarClick?: (exemplar: Exemplar) => void;
  colors?: ChartColors;
  fontFamily?: string;
  fontSize?: number;
  style?: ViewStyle;
  class?: string;
  testID?: string;
  accessibilityLabel?: string;
}

const PATH = (d: string) => new Path2D(d);

export function Heatmap(props: HeatmapProps) {
  const e = new HeatmapEngine();
  const plotFrame = signal(0);
  const overlayFrame = signal(0);
  const range = signal<[number, number] | null>(null);
  const theme = computed<ChartTheme>(() => resolveTheme(props.colors, props.fontFamily, props.fontSize));
  let raf: number | undefined;
  let syncId = 0;

  effect(() => {
    const st = props.data;
    untracked(() => {
      e.store = st;
      e.hover = null;
      plotFrame.update((n) => n + 1);
    });
    const off = st.subscribe(() => {
      if (raf === undefined)
        raf = requestAnimationFrame(() => {
          raf = undefined;
          plotFrame.update((n) => n + 1);
        });
    });
    cleanup(off);
  });
  cleanup(() => {
    if (raf !== undefined) cancelAnimationFrame(raf);
  });

  effect(() => {
    const sync = props.sync;
    if (!sync) return;
    syncId = sync._join();
    effect(() => {
      const c = sync._cursor();
      if (c.from === syncId) return;
      untracked(() => {
        e.syncTime = c.time;
        overlayFrame.update((n) => n + 1);
      });
    });
    effect(() => {
      const r = sync._range();
      untracked(() => range.set(r.range));
    });
  });

  const viewRange = (): [number, number] => {
    const r = range();
    if (r) return r;
    const ext = props.data.extent();
    if (!ext) {
      const now = Date.now();
      return [now - (props.window ?? 300_000), now];
    }
    return props.window ? [ext[1] - props.window, ext[1]] : ext;
  };

  const onMouseMove = (ev: MouseEvent) => {
    e.pointer = { x: ev.position.x, y: ev.position.y };
    e.hoverExemplar = e.exemplarAt(ev.position.x, ev.position.y);
    e.hover = e.hoverExemplar ? null : e.cellAt(ev.position.x, ev.position.y);
    const vc = e.hover ? e.cols[e.hover.col] : undefined;
    props.sync?._setCursor(vc ? vc.time + vc.span / 2 : null, syncId);
    overlayFrame.update((n) => n + 1);
  };
  // A tap (a click, or a finger) on an exemplar opens it.
  let tap: { origin: number; originY: number; x: number; y: number } | null = null;
  const onGrant = (ev: GestureResponderEvent) => {
    tap = { origin: ev.pageX - ev.locationX, originY: ev.pageY - ev.locationY, x: ev.locationX, y: ev.locationY };
    return true;
  };
  const onRelease = (ev: GestureResponderEvent) => {
    const t = tap;
    tap = null;
    if (!t) return;
    const x = ev.pageX - t.origin;
    const y = ev.pageY - t.originY;
    if (Math.abs(x - t.x) + Math.abs(y - t.y) > 8) return;
    const ex = e.exemplarAt(x, y, 10);
    if (ex) props.onExemplarClick?.(ex);
  };
  const onMouseLeave = () => {
    e.hoverExemplar = null;
    e.hover = null;
    props.sync?._setCursor(null, syncId);
    overlayFrame.update((n) => n + 1);
  };

  const qs = () => props.percentiles ?? [0.5, 0.99];
  const label = () => {
    plotFrame();
    const s = props.data;
    const base = props.accessibilityLabel ?? props.title ?? "Heatmap";
    const last = s.length() - 1;
    if (last < 0) return `${base}: no data`;
    const unit = props.unit ?? "ms";
    return `${base}: ${qs().map((q) => `p${+(q * 100).toFixed(1)} ${formatValue(s.quantile(last, q), unit)}`).join(", ")} in the newest column`;
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
            const t = theme();
            const c = cx as unknown as Ctx2D;
            const font = fontOf(t);
            c.font = font;
            e.measure = (s) => measureCached(c, font, s);
            e.unit = props.unit ?? "ms";
            e.timeZone = props.timeZone ?? "local";
            e.fontSize = t.fontSize;
            e.percentiles = qs();
            e.ramp = heatRamp(isDark(t), props.ramp);
            e.showExemplars = props.exemplars ?? true;
            const [x0, x1] = viewRange();
            untracked(() => {
              e.setSize(size.width, size.height);
              e.update(x0, x1);
              renderHeatmap(c, e, t, PATH);
              overlayFrame.update((n) => n + 1);
            });
          }}
        />
        <Canvas
          style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
          testID={props.testID ? `${props.testID}-plot` : undefined}
          role="image"
          accessibilityLabel={label()}
          onStartShouldSetResponder={() => !!props.onExemplarClick}
          onResponderGrant={onGrant}
          onResponderRelease={onRelease}
          onResponderTerminate={() => (tap = null)}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
          draw={(cx) => {
            overlayFrame();
            renderHeatmapOverlay(cx as unknown as Ctx2D, e, untracked(theme));
          }}
        />
      </View>
      {(props.legend ?? true) ? (
        <View class="flex-row flex-wrap items-center" style={{ columnGap: 12, rowGap: 4, marginTop: 6 }} testID={props.testID ? `${props.testID}-legend` : undefined}>
          <View class="flex-row items-center" style={{ gap: 4 }}>
            <Text class="text-xs text-muted-foreground">fewer</Text>
            <View class="flex-row" style={{ borderRadius: 2, overflow: "hidden" }}>
              <Each of={heatRamp(isDark(theme()), props.ramp).filter((_, i) => i % 3 === 0)}>
                {(c) => <View style={{ width: 8, height: 8, backgroundColor: c() }} />}
              </Each>
            </View>
            <Text class="text-xs text-muted-foreground">more</Text>
          </View>
          <Each of={qs()}>
            {(q, i) => (
              <View class="flex-row items-center" style={{ gap: 6 }}>
                <View style={{ width: 10, height: 3, borderRadius: 1.5, backgroundColor: PERCENTILE_COLORS[i() % PERCENTILE_COLORS.length] }} />
                <Text class="text-xs text-muted-foreground">{`p${+(q() * 100).toFixed(1)}`}</Text>
              </View>
            )}
          </Each>
        </View>
      ) : null}
    </View>
  );
}
