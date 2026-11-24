/**
 * Logs, traces and a CPU profile for the same checkout service the metrics describe. Seeded, as `data.ts` is.
 */
import type { LogEntry, LogLevel, Span } from "nsh-o11y";
import { rng } from "./data";

const hexId = (r: () => number, n: number) => {
  let s = "";
  for (let i = 0; i < n; i++) s += "0123456789abcdef"[Math.floor(r() * 16)];
  return s;
};

function pick<T>(r: () => number, xs: readonly T[]): T {
  return xs[Math.floor(r() * xs.length)];
}

/**
 * One checkout request as a trace: the gateway, the checkout service fanning out to cart, inventory and
 * pricing in parallel, then payment (a call out to the card processor, retried when `error`), the order
 * written to the database, and events published. About 30 spans.
 */
export function checkoutTrace(seed: number, start: number, options: { error?: boolean; slow?: boolean } = {}): { traceId: string; spans: Span[] } {
  const r = rng(seed);
  const traceId = hexId(r, 32);
  const spans: Span[] = [];
  const slow = options.slow ? 4 : 1;
  const add = (parent: Span | undefined, name: string, service: string, at: number, duration: number, extra: Partial<Span> = {}): Span => {
    const s: Span = { spanId: hexId(r, 16), parentId: parent?.spanId, name, service, start: at, duration, status: "ok", ...extra };
    spans.push(s);
    return s;
  };
  const jitter = (ms: number) => ms * (0.7 + r() * 0.6);
  const root = add(undefined, "POST /api/checkout", "frontend", start, 0, {
    kind: "server",
    attributes: { "http.method": "POST", "http.route": "/api/checkout", "http.status_code": 200 },
  });
  const gw = add(root, "gateway.route", "api-gateway", start + jitter(1.5), 0, { kind: "internal" });
  const auth = add(gw, "auth.verify_token", "auth", gw.start + jitter(0.8), jitter(6), { kind: "client", attributes: { "auth.method": "jwt" } });
  add(auth, "redis GET session", "auth", auth.start + jitter(0.6), jitter(1.8), { kind: "client", attributes: { "db.system": "redis" } });
  const co = add(gw, "CheckoutService.PlaceOrder", "checkout", auth.start + auth.duration + jitter(0.5), 0, { kind: "server" });
  let t = co.start + jitter(0.6);

  // Fan out: cart, inventory and pricing at once.
  const cart = add(co, "CartService.GetCart", "cart", t, 0, { kind: "client" });
  const cartGet = add(cart, "redis HGETALL cart", "cart", t + jitter(0.5), jitter(2.5), { kind: "client", attributes: { "db.system": "redis" } });
  cart.duration = cartGet.start + cartGet.duration - cart.start + jitter(1);
  if (r() < 0.3) cartGet.events = [{ time: cartGet.start + cartGet.duration * 0.6, name: "cache miss", attributes: { key: "cart:" + hexId(r, 6) } }];
  const items = 2 + Math.floor(r() * 4);
  const inv = add(co, "InventoryService.Reserve", "inventory", t + jitter(0.4), 0, { kind: "client", attributes: { "items.count": items } });
  let it = inv.start + jitter(0.5);
  for (let i = 0; i < items; i++) {
    const q = add(inv, "SELECT stock FROM items", "inventory", it, jitter(3) * slow, {
      kind: "client",
      attributes: { "db.system": "postgresql", "db.statement": "SELECT stock FROM items WHERE sku = $1 FOR UPDATE" },
    });
    it = q.start + q.duration + jitter(0.3);
  }
  inv.duration = it - inv.start + jitter(1);
  const price = add(co, "PricingService.Quote", "pricing", t + jitter(0.5), 0, { kind: "client" });
  const tax = add(price, "TaxService.Compute", "tax", price.start + jitter(1), jitter(9), { kind: "client" });
  add(tax, "GET /v2/rates", "tax", tax.start + jitter(0.5), tax.duration * 0.8, { kind: "client", attributes: { "http.url": "https://tax.internal/v2/rates" } });
  price.duration = tax.start + tax.duration - price.start + jitter(2);
  t = Math.max(...[cart, inv, price].map((s) => s.start + s.duration)) + jitter(0.5);

  // Payment, retried after failures.
  const pay = add(co, "PaymentService.Charge", "payment", t, 0, { kind: "client", attributes: { "payment.provider": "cards", "payment.currency": "EUR" } });
  let pt = pay.start + jitter(1);
  const attempts = options.error ? 3 : 1;
  let prevEnd = pt;
  for (let a = 0; a < attempts; a++) {
    const failed = !!options.error && a < attempts - 1;
    const call = add(pay, "POST /v1/charges", "payment", pt, jitter(failed ? 250 : 45) * slow, {
      kind: "client",
      status: failed ? "error" : "ok",
      attributes: { "http.status_code": failed ? 503 : 200, "retry.attempt": a },
    });
    if (failed)
      call.events = [
        {
          time: call.start + call.duration - 0.2,
          name: "exception",
          attributes: { "exception.type": "UpstreamUnavailable", "exception.message": "503 from cards-api" },
        },
      ];
    if (a > 0) (pay.events ??= []).push({ time: call.start, name: `retry ${a}`, attributes: { "retry.backoff_ms": Math.round(call.start - prevEnd) } });
    prevEnd = call.start + call.duration;
    pt = call.start + call.duration + (failed ? jitter(40) : jitter(0.5));
  }
  pay.duration = pt - pay.start + jitter(1);
  t = pay.start + pay.duration + jitter(0.4);

  // Persist, then publish.
  const tx = add(co, "db.transaction", "checkout", t, 0, { kind: "client", attributes: { "db.system": "postgresql" } });
  let dt = tx.start + jitter(0.3);
  for (const stmt of ["INSERT INTO orders", "INSERT INTO order_items", "UPDATE carts", "COMMIT"]) {
    const q = add(tx, stmt, "checkout", dt, jitter(stmt === "COMMIT" ? 2 : 3.5), {
      kind: "client",
      attributes: { "db.system": "postgresql", "db.statement": `${stmt} …` },
    });
    dt = q.start + q.duration + jitter(0.2);
  }
  tx.duration = dt - tx.start;
  const pub = add(co, "kafka publish order.placed", "checkout", dt + jitter(0.3), jitter(2.5), { kind: "producer", attributes: { "messaging.system": "kafka" } });
  co.duration = pub.start + pub.duration - co.start + jitter(0.5);
  add(pub, "EmailService.SendReceipt", "email", pub.start + pub.duration + jitter(4), jitter(30), { kind: "consumer" });
  add(pub, "AnalyticsService.Track", "analytics", pub.start + pub.duration + jitter(2), jitter(8), { kind: "consumer" });
  gw.duration = co.start + co.duration - gw.start + jitter(0.4);
  root.duration = gw.start + gw.duration - root.start + jitter(0.5);
  if (options.error) {
    for (const s of [pay, co, gw, root]) s.status = "error";
    root.attributes = { ...root.attributes, "http.status_code": 502 };
  }
  return { traceId, spans };
}

type Template = { level: LogLevel; service: string; message: (r: () => number) => string; trace?: boolean };

const NORMAL: Template[] = [
  { level: "info", service: "checkout", message: (r) => `order placed order_id=${hexId(r, 8)} items=${1 + Math.floor(r() * 5)} total=${(r() * 300 + 5).toFixed(2)} EUR`, trace: true },
  { level: "info", service: "frontend", message: (r) => `POST /api/checkout 200 ${Math.round(80 + r() * 140)}ms`, trace: true },
  { level: "info", service: "frontend", message: (r) => `GET /api/cart 200 ${Math.round(8 + r() * 30)}ms` },
  { level: "debug", service: "cart", message: (r) => `cache hit cart:${hexId(r, 6)} ttl=${Math.round(r() * 900)}s` },
  { level: "debug", service: "inventory", message: (r) => `reserved sku=SKU-${Math.floor(r() * 9000 + 1000)} qty=${1 + Math.floor(r() * 3)}` },
  { level: "info", service: "payment", message: () => "charge succeeded provider=cards", trace: true },
  { level: "trace", service: "pricing", message: (r) => `quote computed in ${(r() * 4).toFixed(2)}ms rules=${Math.floor(r() * 30)}` },
  { level: "warn", service: "inventory", message: (r) => `slow query ${Math.round(120 + r() * 300)}ms: SELECT stock FROM items WHERE sku = $1 FOR UPDATE`, trace: true },
  { level: "info", service: "email", message: () => "receipt queued template=order_receipt" },
];

const INCIDENT: Template[] = [
  { level: "error", service: "payment", message: (r) => `charge failed: upstream 503 from card processor after ${Math.round(200 + r() * 200)}ms (attempt ${1 + Math.floor(r() * 3)}/3)`, trace: true },
  { level: "warn", service: "payment", message: () => "circuit breaker half-open for cards-api" },
  { level: "error", service: "frontend", message: () => "POST /api/checkout 502 Bad Gateway", trace: true },
  { level: "warn", service: "checkout", message: (r) => `retrying PaymentService.Charge in ${Math.round(r() * 100)}ms`, trace: true },
];

/**
 * A live source of log lines and the traces some of them link to: `next(t0, t1)` gives the lines in
 * [t0, t1) (about 6 a second, 30 and mostly errors during an incident), `trace(id)` a trace one names.
 */
export function serviceLogs(seed = 11, incidents: [number, number][] = []) {
  const r = rng(seed);
  const traces = new Map<string, Span[]>();
  const order: string[] = [];
  let traceSeed = seed * 1000;
  const keepTrace = (error: boolean, at: number) => {
    const { traceId, spans } = checkoutTrace(traceSeed++, at, { error, slow: !error && r() < 0.1 });
    traces.set(traceId, spans);
    order.push(traceId);
    if (order.length > 500) traces.delete(order.shift()!);
    return traceId;
  };
  const on = (t: number) => incidents.some(([a, b]) => t >= a && t < b);
  return {
    next(t0: number, t1: number): LogEntry[] {
      const out: LogEntry[] = [];
      let t = t0;
      for (;;) {
        t += (-Math.log(1 - r()) / (on(t) ? 30 : 6)) * 1000;
        if (t >= t1) break;
        const tpl = on(t) && r() < 0.6 ? pick(r, INCIDENT) : pick(r, NORMAL);
        const e: LogEntry = {
          time: Math.round(t),
          level: tpl.level,
          service: tpl.service,
          message: tpl.message(r),
          attributes: { host: `web-${1 + Math.floor(r() * 4)}`, region: pick(r, ["eu-west-1", "eu-central-1"]), "service.version": "2.14.0" },
        };
        if (tpl.trace) e.traceId = keepTrace(tpl.level === "error", e.time);
        out.push(e);
      }
      return out;
    },
    trace(id: string) {
      return traces.get(id);
    },
    /** The newest traces, newest first. */
    recent(n = 50): { traceId: string; spans: Span[] }[] {
      const out: { traceId: string; spans: Span[] }[] = [];
      for (let i = order.length - 1; i >= 0 && out.length < n; i--) {
        const s = traces.get(order[i]);
        if (s) out.push({ traceId: order[i], spans: s });
      }
      return out;
    },
  };
}

type Frame = { name: string; weight: number; children?: Frame[] };

const leaf = (name: string, weight = 1): Frame => ({ name, weight });

/** Where the checkout service spends its CPU, as a weighted call tree. */
const PROGRAM: Frame[] = [
  { name: "runtime.main", weight: 0.83, children: [
    { name: "main.main", weight: 1, children: [
      { name: "net/http.(*conn).serve", weight: 1, children: [
        leaf("net/http.(*conn).readRequest", 0.06),
        { name: "checkout/api.(*Router).ServeHTTP", weight: 0.94, children: [
          { name: "checkout/api.authMiddleware", weight: 0.12, children: [
            { name: "github.com/golang-jwt/jwt.Parse", weight: 0.6, children: [
              { name: "crypto/rsa.VerifyPKCS1v15", weight: 0.8, children: [leaf("math/big.nat.expNN")] },
              leaf("encoding/base64.(*Encoding).Decode", 0.2),
            ] },
            { name: "checkout/session.(*Store).Get", weight: 0.4, children: [leaf("github.com/redis/go-redis.(*Client).Get")] },
          ] },
          { name: "checkout/api.(*Handler).PlaceOrder", weight: 0.88, children: [
            { name: "encoding/json.(*Decoder).Decode", weight: 0.14, children: [leaf("encoding/json.(*decodeState).object", 0.8), leaf("runtime.mallocgc", 0.2)] },
            { name: "checkout/order.(*Service).Place", weight: 0.62, children: [
              { name: "checkout/pricing.(*Client).Quote", weight: 0.22, children: [
                { name: "google.golang.org/grpc.(*ClientConn).Invoke", weight: 0.7, children: [
                  leaf("google.golang.org/protobuf/proto.Marshal", 0.35),
                  leaf("google.golang.org/grpc/internal/transport.(*http2Client).Write", 0.65),
                ] },
                { name: "checkout/pricing.applyRules", weight: 0.3, children: [leaf("regexp.(*Regexp).MatchString")] },
              ] },
              { name: "checkout/inventory.(*Client).Reserve", weight: 0.2, children: [
                { name: "github.com/jackc/pgx.(*Conn).Query", weight: 0.85, children: [
                  leaf("github.com/jackc/pgx.(*Conn).sendPreparedQuery", 0.4),
                  leaf("github.com/jackc/pgx/pgproto3.(*Frontend).Receive", 0.6),
                ] },
                leaf("runtime.mallocgc", 0.15),
              ] },
              { name: "checkout/payment.(*Client).Charge", weight: 0.33, children: [
                { name: "net/http.(*Client).Do", weight: 0.75, children: [
                  { name: "crypto/tls.(*Conn).Write", weight: 0.55, children: [leaf("crypto/aes.gcmAesEnc")] },
                  { name: "crypto/tls.(*Conn).Read", weight: 0.45, children: [leaf("crypto/aes.gcmAesDec")] },
                ] },
                { name: "encoding/json.Marshal", weight: 0.25, children: [leaf("encoding/json.(*encodeState).reflectValue")] },
              ] },
              { name: "checkout/order.(*Repo).Insert", weight: 0.25, children: [leaf("github.com/jackc/pgx.(*Conn).Exec", 0.8), leaf("github.com/jackc/pgx.(*Tx).Commit", 0.2)] },
            ] },
            { name: "encoding/json.(*Encoder).Encode", weight: 0.12, children: [leaf("encoding/json.(*encodeState).reflectValue", 0.85), leaf("runtime.mallocgc", 0.15)] },
            { name: "github.com/segmentio/kafka-go.(*Writer).WriteMessages", weight: 0.12, children: [
              leaf("github.com/klauspost/compress/zstd.(*Encoder).EncodeAll", 0.7),
              { name: "net.(*conn).Write", weight: 0.3, children: [leaf("syscall.write")] },
            ] },
          ] },
        ] },
      ] },
    ] },
  ] },
  { name: "runtime.gcBgMarkWorker", weight: 0.13, children: [
    { name: "runtime.gcDrain", weight: 1, children: [{ name: "runtime.scanobject", weight: 0.7, children: [leaf("runtime.findObject")] }, leaf("runtime.markroot", 0.3)] },
  ] },
  { name: "runtime.mcall", weight: 0.04, children: [{ name: "runtime.schedule", weight: 1, children: [leaf("runtime.findRunnable")] }] },
];

/** A CPU profile of the checkout service as folded stacks (`a;b;c count` per line), `samples` in all. */
export function checkoutProfile(seed = 3, samples = 20_000): string {
  const r = rng(seed);
  const counts = new Map<string, number>();
  for (let i = 0; i < samples; i++) {
    let level: Frame[] | undefined = PROGRAM;
    const frames: string[] = [];
    while (level && level.length) {
      const total = level.reduce((a, f) => a + f.weight, 0);
      let x = r() * total;
      let node: Frame = level[level.length - 1];
      for (const f of level) {
        x -= f.weight;
        if (x <= 0) {
          node = f;
          break;
        }
      }
      frames.push(node.name);
      // Now and then a sample stops in a function itself: its self time.
      if (r() < 0.04) break;
      level = node.children;
    }
    const key = frames.join(";");
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let out = "";
  for (const [k, v] of counts) out += `${k} ${v}\n`;
  return out;
}
