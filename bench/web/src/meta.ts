/** What each library is and how it is set up: shared by the page and by run.ts, which can't load the libraries. */
export const META: Record<string, { name: string; version: string; setup: string }> = {
  nsh: { name: "nsh-o11y", version: "0.1.0", setup: "TypeScript store (min/max pyramid, M4), Canvas 2D, plot and overlay on two canvases" },
  uplot: { name: "uPlot", version: "1.6.32", setup: "x in seconds, null for gaps, `batch` around each change" },
  echarts: { name: "ECharts", version: "6.1.0", setup: "canvas renderer, `sampling: 'lttb'`, data as flat Float64Array [x, y, x, y…], inside dataZoom" },
  chartjs: { name: "Chart.js", version: "4.6.2", setup: "decimation plugin (`min-max`), `parsing: false`, `normalized`, linear x, `update('none')`" },
  plotly: { name: "Plotly", version: "4.3.0", setup: "`scattergl` (WebGL), typed arrays, `relayout` for the range; hover not timed (asynchronous)" },
  dygraphs: { name: "Dygraphs", version: "2.2.2", setup: "native array rows, `dateWindow` for the range, `setSelection` for hover (no decimation)" },
};
