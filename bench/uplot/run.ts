/**
 * Runs page/bench.js (uPlot) in a headless Chrome or Edge and prints the results as a table, also
 * written to bench/results/uplot.md.
 *
 *   bun install && bun run.ts [path to chrome or msedge]
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, normalize } from "node:path";

const root = import.meta.dir;
// The page imports the same data generator as the NSH side.
const built = await Bun.build({
  entrypoints: [join(root, "../../example/data.ts")],
  outdir: join(root, "page"),
  naming: "data.js",
  format: "esm",
  target: "browser",
});
if (!built.success) throw new Error(built.logs.join("\n"));

const candidates = [
  process.argv[2],
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
].filter(Boolean) as string[];
let browser: string | undefined;
for (const p of candidates) if (await Bun.file(p).exists()) { browser = p; break; }
if (!browser) throw new Error("no Chrome or Edge found: pass its path");

let resolve!: (v: any) => void;
const done = new Promise<any>((r) => (resolve = r));
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/result") {
      resolve(await req.json());
      return new Response("ok");
    }
    const path = normalize(join(root, url.pathname));
    if (!path.startsWith(normalize(root))) return new Response("no", { status: 403 });
    const file = Bun.file(path);
    return (await file.exists()) ? new Response(file) : new Response("not found", { status: 404 });
  },
});

const profile = mkdtempSync(join(tmpdir(), "uplot-bench-"));
const proc = spawn(
  browser,
  [
    "--headless=new",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--window-size=1280,900",
    "--force-device-scale-factor=1",
    `http://localhost:${server.port}/page/index.html`,
  ],
  { stdio: "ignore" },
);

const timeout = setTimeout(() => resolve({ ok: false, error: "timed out", results: [] }), 15 * 60_000);
const result = await done;
clearTimeout(timeout);
proc.kill();
server.stop(true);
try {
  rmSync(profile, { recursive: true, force: true });
} catch {}

const f = (v?: number) => (v === undefined ? "" : v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));
const lines = [
  `uPlot 1.6.31 in ${result.userAgent ?? browser}`,
  "",
  "| Scenario | Create + first draw (ms) | Full-view frame, mean / p95 (ms) | Zooming frame, mean / p95 (ms) | Hover (ms) |",
  "|---|---|---|---|---|",
  ...result.results.map(
    (r: any) =>
      `| ${r.scenario} | ${f(r.create)} | ${f(r.full?.mean)} / ${f(r.full?.p95)} | ${r.zoom ? `${f(r.zoom.mean)} / ${f(r.zoom.p95)}` : ""} | ${f(r.hover?.mean)} |`,
  ),
];
console.log(lines.join("\n"));
if (!result.ok) console.error(result.error);
mkdirSync(join(root, "../results"), { recursive: true });
writeFileSync(join(root, "../results/uplot.md"), lines.join("\n") + "\n");
process.exit(result.ok ? 0 : 1);
