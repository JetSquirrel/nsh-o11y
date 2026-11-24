/**
 * Runs src/bench.ts for every library and scenario, each in a fresh headless Chrome or Edge, and writes
 * the results to bench/results/web.md (and web.json).
 *
 *   bun install && bun run.ts [--browser path] [--libs nsh,uplot,…] [--scenarios 100000,live,…]
 *   bun run.ts --shots      a screenshot of each library at 100k samples, in bench/results/shots/
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";
import { META as adapters } from "./src/meta";

const root = import.meta.dir;
const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const LIBS = (arg("libs") ?? "nsh,uplot,echarts,chartjs,plotly,dygraphs").split(",");
const SCENARIOS = (arg("scenarios") ?? "100000,1000000,10000000,live,dashboard").split(",");
/** A cell that hasn't answered by then crashed or hung: the browser is killed and the cell marked. */
const CELL_TIMEOUT = 6 * 60_000;

const built = await Bun.build({
  entrypoints: [join(root, "src/bench.ts")],
  outdir: join(root, "page"),
  naming: "bench.js",
  format: "esm",
  target: "browser",
  minify: true,
});
if (!built.success) throw new Error(built.logs.join("\n"));

const candidates = [
  arg("browser"),
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean) as string[];
let browser: string | undefined;
for (const p of candidates) if (await Bun.file(p).exists()) { browser = p; break; }
if (!browser) throw new Error("no Chrome or Edge found: pass --browser");

let waiting: ((v: any) => void) | null = null;
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/result") {
      waiting?.(await req.json());
      return new Response("ok");
    }
    const path = normalize(join(root, url.pathname));
    if (!path.startsWith(normalize(root))) return new Response("no", { status: 403 });
    const file = Bun.file(path);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});
const page = (lib: string, scenario: string) =>
  `http://localhost:${server.port}/page/index.html?lib=${lib}&scenario=${scenario}`;

function launch(url: string, extra: string[] = []) {
  const profile = mkdtempSync(join(tmpdir(), "chart-bench-"));
  const proc = spawn(
    browser!,
    ["--headless=new", `--user-data-dir=${profile}`, "--no-first-run", "--window-size=1280,900", "--force-device-scale-factor=1", ...extra, url],
    { stdio: "ignore" },
  );
  const done = new Promise<void>((r) => proc.on("exit", () => r()));
  return {
    done,
    async kill() {
      proc.kill();
      await Promise.race([done, new Promise((r) => setTimeout(r, 3000))]);
      try {
        rmSync(profile, { recursive: true, force: true });
      } catch {}
    },
  };
}

if (process.argv.includes("--shots")) {
  const dir = join(root, "../results/shots");
  mkdirSync(dir, { recursive: true });
  for (const lib of LIBS) {
    const b = launch(page(lib, "shot"), ["--virtual-time-budget=20000", `--screenshot=${join(dir, `${lib}.png`)}`]);
    await Promise.race([b.done, new Promise((r) => setTimeout(r, 120_000))]);
    await b.kill();
    console.log(`shot ${lib}`);
  }
  server.stop(true);
  process.exit(0);
}

const results: any[] = [];
let userAgent = "";
for (const lib of LIBS) {
  const failed = new Set<string>();
  for (const scenario of SCENARIOS) {
    // Past a size it couldn't finish, a bigger one won't either.
    const n = Number(scenario);
    if (n && [...failed].some((f) => Number(f) && Number(f) < n)) {
      results.push({ lib, scenario, ok: false, error: "skipped: a smaller size didn't finish" });
      continue;
    }
    const t0 = Date.now();
    const answer = new Promise<any>((r) => (waiting = r));
    const b = launch(page(lib, scenario));
    const r = await Promise.race([
      answer,
      b.done.then(() => ({ ok: false, error: "the browser exited" })),
      new Promise((res) => setTimeout(() => res({ ok: false, error: "no answer in 6 minutes: crashed (out of memory) or hung" }), CELL_TIMEOUT)),
    ]);
    waiting = null;
    await b.kill();
    if (!r.ok) failed.add(scenario);
    if (r.userAgent) userAgent = r.userAgent;
    results.push({ lib, scenario, ...r });
    console.log(`${lib} ${scenario}: ${r.ok ? "ok" : r.error?.split("\n")[0]} (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
    mkdirSync(join(root, "../results"), { recursive: true });
    writeFileSync(join(root, "../results/web.json"), JSON.stringify({ browser: userAgent, results }, null, 1));
  }
}
server.stop(true);

// ---- Report
const f = (v?: number) => (v === undefined ? "" : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const s = (st?: { mean: number; p95: number; frames: number }) =>
  st ? `${f(st.mean)} / ${f(st.p95)}${st.frames < 10 ? ` (${st.frames} frames)` : ""}` : "";
const name = (lib: string) => `${adapters[lib].name} ${adapters[lib].version}`;
const cell = (lib: string, scenario: string) => results.find((r) => r.lib === lib && r.scenario === scenario);
const why = (r: any) => (r?.skipped ? r.skipped : r?.error?.startsWith("skipped") ? "skipped" : r?.error ? "did not finish" : "");

const lines = [`Each library in a fresh ${userAgent || browser}. Milliseconds of JavaScript per frame, mean / p95.`, ""];
for (const sc of SCENARIOS) {
  const n = Number(sc);
  if (n) {
    lines.push(`### ${n.toLocaleString("en-US")} samples`, "", "| Library | Create + first draw | Full-view frame | Zooming frame | Hover |", "|---|---|---|---|---|");
    for (const lib of LIBS) {
      const r = cell(lib, sc);
      lines.push(r?.ok ? `| ${name(lib)} | ${f(r.create)} | ${s(r.full)} | ${s(r.zoom)} | ${r.hover ? f(r.hover.mean) : "n/a"} |` : `| ${name(lib)} | ${why(r)} | | | |`);
    }
  } else {
    lines.push(`### ${sc === "live" ? "Live: 1M kept, 3000 in view, one sample appended per frame" : "Dashboard: 24 panels × 3 series × 20k, all redrawn"}`, "", "| Library | Frame |", "|---|---|");
    for (const lib of LIBS) {
      const r = cell(lib, sc);
      lines.push(`| ${name(lib)} | ${r?.ok && r.full ? s(r.full) : why(r) || r?.skipped || ""} |`);
    }
  }
  lines.push("");
}
lines.push("Setups:", "", ...LIBS.map((l) => `- ${name(l)}: ${adapters[l].setup}`), "");
const failures = results.filter((r) => !r.ok && r.error && !r.error.startsWith("skipped"));
if (failures.length) lines.push("Did not finish:", "", ...failures.map((r) => `- ${r.lib} ${r.scenario}: ${r.error.split("\n")[0]}`), "");
console.log(lines.join("\n"));
writeFileSync(join(root, "../results/web.md"), lines.join("\n"));
process.exit(0);
