/**
 * `<TraceComparison>`: two traces of one operation, call by call. Each row is a span matched in both (by
 * its place in the tree), the baseline's bar above in grey and the other's below, red where it got slower
 * or is new, blue where it got faster or is gone, with the change at the end of the row. A slow or failed
 * request next to a healthy one: the rows in red are where the time went.
 */
import { Canvas, Path2D, Text, View, computed, effect, signal, untracked, type GestureResponderEvent, type MouseEvent, type ViewStyle, type WheelEvent } from "nsh";
import { fontOf, measureCached, type Ctx2D } from "./render";

import { resolveTheme } from "./theme";
import { ComparisonEngine, FASTER, renderComparison, renderComparisonOverlay, SLOWER, type ComparisonRow } from "./tracediff";
import { TraceModel, type Span } from "./traces";
import type { ChartColors, ChartTheme } from "./types";

export interface TraceComparisonProps {
  /** The baseline: a healthy trace of the same operation. */
  a: readonly Span[] | TraceModel;
  /** The trace to explain. */
  b: readonly Span[] | TraceModel;
  /** What the legend calls them. Default "baseline" and "this trace". */
  aLabel?: string;
  bLabel?: string;
  rowHeight?: number;
  /** The name column's width in points. Default 300 (at most 40% of the view). */
  labelWidth?: number;
  colors?: ChartColors;
  fontFamily?: string;
  fontSize?: number;
  /** Start with only the calls that changed (and the calls above them) shown. A button in the legend switches it. Default false. */
  changedOnly?: boolean;
  /** A row was pressed. */
  onSelect?: (row: ComparisonRow) => void;
  style?: ViewStyle;
  class?: string;
  testID?: string;
}

const PATH = (d: string) => new Path2D(d);

export function TraceComparison(props: TraceComparisonProps) {
  const e = new ComparisonEngine();
  const plotFrame = signal(0);
  const overlayFrame = signal(0);
  const theme = computed<ChartTheme>(() => resolveTheme(props.colors, props.fontFamily, props.fontSize));
  const model = (s: readonly Span[] | TraceModel) => (s instanceof TraceModel ? s : new TraceModel(s as Span[]));
  const summary = signal<{ slower: number; faster: number; added: number; gone: number; top: ComparisonRow | undefined }>({ slower: 0, faster: 0, added: 0, gone: 0, top: undefined });
  let drag: { originY: number; lastY: number; startY: number; moved: boolean } | null = null;
  const changedOnly = signal(untracked(() => props.changedOnly ?? false));
  const hidden = signal(0);

  effect(() => {
    const a = props.a;
    const b = props.b;
    untracked(() => {
      e.set(model(a), model(b));
      const n = { slower: 0, faster: 0, added: 0, gone: 0, top: e.biggest(1)[0] };
      for (const r of e.all) {
        const k = e.kind(r);
        if (k === "slower") n.slower++;
        else if (k === "faster") n.faster++;
        else if (k === "new") n.added++;
        else if (k === "gone") n.gone++;
      }
      summary.set(n);
      hidden.set(e.hidden);
      plotFrame.update((v) => v + 1);
    });
  });
  effect(() => {
    const on = changedOnly();
    untracked(() => {
      e.changedOnly = on;
      hidden.set(e.hidden);
      plotFrame.update((v) => v + 1);
      overlayFrame.update((v) => v + 1);
    });
  });
  effect(() => {
    e.rowHeight = props.rowHeight ?? 30;
    e.labelWidth = props.labelWidth ?? 300;
    untracked(() => plotFrame.update((v) => v + 1));
  });

  const onWheel = (ev: WheelEvent) => {
    e.scrollBy(ev.deltaMode === "lines" ? ev.delta.y * 40 : ev.delta.y);
    e.hover = e.rowAt(ev.position.y);
    plotFrame.update((v) => v + 1);
  };
  const onMouseMove = (ev: MouseEvent) => {
    e.pointer = { x: ev.position.x, y: ev.position.y };
    e.hover = e.rowAt(ev.position.y);
    overlayFrame.update((v) => v + 1);
  };
  const onMouseLeave = () => {
    e.hover = -1;
    overlayFrame.update((v) => v + 1);
  };
  const onGrant = (ev: GestureResponderEvent) => {
    drag = { originY: ev.pageY - ev.locationY, lastY: ev.locationY, startY: ev.locationY, moved: false };
    return true;
  };
  const onMove = (ev: GestureResponderEvent) => {
    const d = drag;
    if (!d) return;
    const y = ev.pageY - d.originY;
    if (Math.abs(y - d.startY) > 5) d.moved = true;
    if (d.moved) {
      e.scrollBy(d.lastY - y);
      plotFrame.update((v) => v + 1);
    }
    d.lastY = y;
  };
  const onRelease = () => {
    const d = drag;
    drag = null;
    if (!d || d.moved) return;
    const i = e.rowAt(d.startY);
    if (i >= 0) props.onSelect?.(e.rows[i]);
  };

  const label = () => {
    const s = summary();
    const top = s.top;
    const head = `Trace comparison: ${s.slower} calls slower, ${s.faster} faster, ${s.added} new, ${s.gone} gone`;
    return top ? `${head}. Most time added: ${top.name}, ${e.changeText(top)}` : head;
  };

  return (
    <View style={{ flexDirection: "column", gap: 6, ...props.style }} class={props.class} testID={props.testID}>
      <View class="flex-row flex-wrap items-center" style={{ columnGap: 14, rowGap: 4 }} testID={props.testID ? `${props.testID}-legend` : undefined}>
        <View class="flex-row items-center" style={{ gap: 6 }}>
          <View style={{ width: 14, height: 4, borderRadius: 2, backgroundColor: theme().muted }} />
          <Text class="text-xs text-muted-foreground">{props.aLabel ?? "baseline"}</Text>
        </View>
        <View class="flex-row items-center" style={{ gap: 6 }}>
          <View style={{ width: 7, height: 4, borderTopLeftRadius: 2, borderBottomLeftRadius: 2, backgroundColor: SLOWER }} />
          <View style={{ width: 7, height: 4, borderTopRightRadius: 2, borderBottomRightRadius: 2, backgroundColor: FASTER, marginLeft: -6 }} />
          <Text class="text-xs text-muted-foreground">{`${props.bLabel ?? "this trace"}: slower or new / faster or gone`}</Text>
        </View>
        <View style={{ flex: 1 }} />
        <View
          role="button"
          accessibilityState={{ checked: changedOnly() }}
          testID={props.testID ? `${props.testID}-changed-only` : undefined}
          onPress={() => changedOnly.update((v) => !v)}
          class={`rounded px-2 py-0.5 ${changedOnly() ? "bg-accent" : "hover:bg-accent"}`}
        >
          <Text class={`text-xs ${changedOnly() ? "text-foreground font-medium" : "text-muted-foreground"}`}>
            {changedOnly() && hidden() > 0 ? `Changed calls only · ${hidden()} hidden` : "Changed calls only"}
          </Text>
        </View>
        <Text class="text-xs text-muted-foreground" testID={props.testID ? `${props.testID}-summary` : undefined}>
          {`${summary().slower} slower · ${summary().faster} faster · ${summary().added} new · ${summary().gone} gone`}
        </Text>
      </View>
      <View style={{ flex: 1, position: "relative", minHeight: 80 }}>
        <Canvas
          style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0, pointerEvents: "none" }}
          draw={(cx, size) => {
            plotFrame();
            const t = theme();
            untracked(() => {
              const c = cx as unknown as Ctx2D;
              const font = fontOf(t);
              c.font = font;
              e.measure = (s) => measureCached(c, font, s);
              e.setSize(size.width, size.height);
              renderComparison(c, e, t, PATH);
              overlayFrame.update((v) => v + 1);
            });
          }}
        />
        <Canvas
          style={{ position: "absolute", left: 0, top: 0, right: 0, bottom: 0 }}
          testID={props.testID ? `${props.testID}-plot` : undefined}
          role="image"
          accessibilityLabel={label()}
          onStartShouldSetResponder={() => true}
          onMoveShouldSetResponder={() => true}
          onResponderGrant={onGrant}
          onResponderMove={onMove}
          onResponderRelease={onRelease}
          onResponderTerminate={() => (drag = null)}
          onWheel={onWheel}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
          draw={(cx) => {
            overlayFrame();
            renderComparisonOverlay(cx as unknown as Ctx2D, e, untracked(theme));
          }}
        />
      </View>
    </View>
  );
}

