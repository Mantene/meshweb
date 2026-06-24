/**
 * Meshtastic serial → HTTP bridge.
 *
 * Opens a USB-connected Meshtastic device on the machine running this process
 * (e.g. /dev/ttyACM0 inside a Docker container) and re-exposes it as the device
 * HTTP API the official web client already knows how to talk to:
 *
 *   GET  /api/v1/fromradio   → next queued FromRadio protobuf (empty body = drained)
 *   PUT  /api/v1/toradio     → forward a ToRadio protobuf to the device
 *   OPTIONS /api/v1/toradio  → CORS / reachability probe
 *
 * It also serves the static web client build on the same origin, so the browser
 * connects to this server's own address using the client's "HTTP" connection
 * type — no changes to the web client are required.
 *
 * Byte contract (verified against the SDK):
 *   - transport-http exchanges RAW, UNFRAMED protobufs (it does not de/frame).
 *   - transport-node-serial's `toDevice` adds 0x94 0xc3 framing; its `fromDevice`
 *     strips it and emits {type:"packet", data:<raw FromRadio protobuf>}.
 *   So this bridge is a byte-transparent FIFO between the two.
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import {
  extname,
  join,
  normalize,
  resolve as resolvePath,
  sep,
} from "node:path";
import { fromBinary } from "@bufbuild/protobuf";
import { Protobuf } from "@meshtastic/sdk/protobuf";
import { DeviceStatusEnum } from "@meshtastic/sdk/transport";
import { TransportNodeSerial } from "@meshtastic/transport-node-serial";
import { SerialPort } from "serialport";

// ---------------------------------------------------------------------------
// Config (all overridable via environment)
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const SERIAL_PATH = process.env.MESHTASTIC_SERIAL_PORT ?? "/dev/ttyACM0";
const BAUD_RATE = Number(process.env.MESHTASTIC_BAUD_RATE ?? 115200);
const STATIC_DIR = resolvePath(
  process.env.STATIC_DIR ?? join(import.meta.dirname, "dist"),
);
const RECONNECT_MS = Number(process.env.MESHTASTIC_RECONNECT_MS ?? 3000);
// Cap reconnect backoff so a permanently-absent device doesn't hot-spin/log-spam.
const MAX_BACKOFF_MS = Number(process.env.MESHTASTIC_MAX_BACKOFF_MS ?? 30000);
// Guardrail: drop the queue if it grows unbounded (client absent/very slow).
const MAX_QUEUE = Number(process.env.MESHTASTIC_MAX_QUEUE ?? 2048);
// Max accepted PUT /api/v1/toradio body. A ToRadio protobuf is tiny (<512B); the
// cap prevents an unbounded in-memory read (OOM DoS) on the 0.0.0.0 endpoint.
const MAX_BODY_BYTES = Number(process.env.MESHTASTIC_MAX_BODY ?? 64 * 1024);

function log(message: string): void {
  console.log(`[bridge] ${message}`);
}

// ---------------------------------------------------------------------------
// Serial link state
// ---------------------------------------------------------------------------
let transport: TransportNodeSerial | undefined;
let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
let linkDown = true;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
/** FIFO of raw (unframed) FromRadio protobufs awaiting GET /api/v1/fromradio. */
const fromRadioQueue: Uint8Array[] = [];
/** Serializes writes so concurrent PUTs preserve order on the single writer. */
let writeChain: Promise<unknown> = Promise.resolve();
/** Guards against overlapping connect attempts (reconnect timer + uncaught handler). */
let connecting = false;
/** Current reconnect delay; grows exponentially to MAX_BACKOFF_MS, resets on connect. */
let backoffMs = RECONNECT_MS;

async function teardownTransport(): Promise<void> {
  const t = transport;
  const w = writer;
  transport = undefined;
  writer = undefined;
  try {
    await w?.close();
  } catch {
    // writer may already be errored/closed
  }
  try {
    await t?.disconnect();
  } catch {
    // best-effort
  }
}

function scheduleReconnect(): void {
  // Don't schedule if one is pending, a connect is in flight, or we're connected.
  if (reconnectTimer || connecting || transport) {
    return;
  }
  const delay = backoffMs;
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = undefined;
    void connectSerial();
  }, delay);
}

/**
 * Open the serial port ourselves rather than via `TransportNodeSerial.create`.
 * The factory calls `port.close()` when an open fails, which a never-opened port
 * surfaces as an unhandled 'error' event that crashes the process. Using
 * `autoOpen:false` + the open callback routes open failures cleanly, so the HTTP
 * server keeps running and the reconnect loop can recover (device not yet ready,
 * unplug/replug, etc.).
 */
function openSerialPort(path: string, baudRate: number): Promise<SerialPort> {
  return new Promise((resolve, reject) => {
    const port = new SerialPort({ path, baudRate, autoOpen: false });
    // Listener attached BEFORE open so stray 'error' events never go unhandled.
    port.on("error", (err) => log(`serial port error: ${stringifyError(err)}`));
    port.open((err) => {
      if (err) {
        try {
          if (port.isOpen) {
            port.close();
          }
        } catch {
          // ignore — port never opened
        }
        reject(err);
        return;
      }
      resolve(port);
    });
  });
}

async function connectSerial(): Promise<void> {
  // In-flight guard: prevents two concurrent opens of the same device (which would
  // leak a transport/reader) when the reconnect timer and the uncaughtException
  // safety net both fire.
  if (connecting || transport) {
    return;
  }
  connecting = true;
  try {
    log(`opening serial ${SERIAL_PATH} @ ${BAUD_RATE}`);
    const port = await openSerialPort(SERIAL_PATH, BAUD_RATE);
    const t = new TransportNodeSerial(port);
    transport = t;
    writer = t.toDevice.getWriter();
    linkDown = false;
    backoffMs = RECONNECT_MS; // reset backoff on a successful connect
    fromRadioQueue.length = 0; // fresh link: discard anything stale
    log("serial connected");
    void pumpFromDevice(t);
  } catch (err) {
    linkDown = true;
    log(
      `serial open failed: ${stringifyError(err)} — retrying in ${backoffMs}ms`,
    );
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

/** Drain the serial transport's fromDevice stream into the FIFO queue. */
async function pumpFromDevice(t: TransportNodeSerial): Promise<void> {
  const reader = t.fromDevice.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      if (value.type === "packet") {
        // RULE 1: only non-empty packets go on the protobuf queue.
        if (value.data.byteLength > 0) {
          fromRadioQueue.push(value.data);
          if (fromRadioQueue.length > MAX_QUEUE) {
            fromRadioQueue.shift();
            log("queue overflow — dropped oldest packet (no client draining?)");
          }
        }
      } else if (value.type === "status") {
        // RULE 1: status events are not protobufs — never queue them.
        if (value.data.status === DeviceStatusEnum.DeviceDisconnected) {
          log(`serial disconnected (${value.data.reason ?? "unknown"})`);
          linkDown = true;
          break; // stop reading → fall through to teardown + reconnect below
        }
      }
      // value.type === "debug": device boot/log text — ignored (never queued).
    }
  } catch (err) {
    log(`serial read error: ${stringifyError(err)}`);
  } finally {
    reader.releaseLock();
  }
  // Stream ended or errored → link is down; clean up and reconnect.
  linkDown = true;
  await teardownTransport();
  log("serial stream ended — will reconnect");
  scheduleReconnect();
}

/** Write raw bytes to the device, preserving order across concurrent callers. */
function writeToRadio(bytes: Uint8Array): Promise<void> {
  if (!writer || linkDown) {
    return Promise.reject(new Error("serial link down"));
  }
  // Re-read `writer`/`linkDown` at execution time (not call time) so a write that
  // was queued before a teardown can't target the stale, closed writer.
  const op = writeChain.then(() => {
    const cur = writer;
    if (!cur || linkDown) {
      throw new Error("serial link down");
    }
    return cur.write(bytes);
  });
  writeChain = op.catch(() => undefined);
  return op;
}

/**
 * RULE 3: detect a fresh handshake. The web client sends a `wantConfigId`
 * ToRadio at the start of every connection; flushing the queue at that point
 * drops any stale/old-session config bundle so the new session isn't polluted.
 */
function isWantConfig(body: Uint8Array): boolean {
  try {
    const toRadio = fromBinary(Protobuf.Mesh.ToRadioSchema, body);
    return toRadio.payloadVariant.case === "wantConfigId";
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
function setCors(res: ServerResponse): void {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept");
}

class PayloadTooLargeError extends Error {}

function readBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new PayloadTooLargeError("request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".map": "application/json",
  ".txt": "text/plain; charset=utf-8",
};

async function serveStatic(
  urlPath: string,
  res: ServerResponse,
  method: string,
): Promise<void> {
  let rel: string;
  try {
    rel = decodeURIComponent(urlPath);
  } catch {
    res.statusCode = 400;
    res.end("Bad request");
    return;
  }

  // Resolve within STATIC_DIR and guard against path traversal.
  const candidate = resolvePath(normalize(join(STATIC_DIR, rel)));
  if (candidate !== STATIC_DIR && !candidate.startsWith(STATIC_DIR + sep)) {
    res.statusCode = 403;
    res.end("Forbidden");
    return;
  }

  const target = await resolveStaticTarget(candidate, rel);
  if (!target) {
    res.statusCode = 404;
    res.end("Not found");
    return;
  }

  res.statusCode = 200;
  res.setHeader(
    "Content-Type",
    MIME_TYPES[extname(target).toLowerCase()] ?? "application/octet-stream",
  );
  if (method === "HEAD") {
    res.end(); // headers only — no body for HEAD
    return;
  }
  createReadStream(target).pipe(res);
}

/** Pick the file to serve: the file itself, dir index, or SPA fallback. */
async function resolveStaticTarget(
  candidate: string,
  rel: string,
): Promise<string | undefined> {
  const isFile = async (p: string): Promise<boolean> => {
    try {
      return (await stat(p)).isFile();
    } catch {
      return false;
    }
  };

  if (rel === "/" || rel.endsWith("/")) {
    const index = join(candidate, "index.html");
    return (await isFile(index)) ? index : undefined;
  }
  if (await isFile(candidate)) {
    return candidate;
  }
  // SPA fallback: extensionless routes resolve to index.html.
  if (!extname(rel)) {
    const index = join(STATIC_DIR, "index.html");
    return (await isFile(index)) ? index : undefined;
  }
  return undefined;
}

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((err) => {
    log(`request error: ${stringifyError(err)}`);
    if (!res.headersSent) {
      res.statusCode = 500;
    }
    res.end();
  });
});
// Bound how long a single request may take (slowloris hardening on 0.0.0.0).
server.requestTimeout = 15_000;
server.headersTimeout = 10_000;

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const method = req.method ?? "GET";
  const url = new URL(
    req.url ?? "/",
    `http://${req.headers.host ?? "localhost"}`,
  );
  const path = url.pathname;

  // --- Device HTTP API: PUT/OPTIONS /api/v1/toradio ---
  if (path === "/api/v1/toradio") {
    setCors(res);
    if (method === "OPTIONS") {
      // RULE 6: probe/preflight — any 2xx satisfies the client.
      res.statusCode = 204;
      res.end();
      return;
    }
    if (method === "PUT") {
      // Fast path for well-behaved clients: reject oversize before reading a byte.
      if (Number(req.headers["content-length"] ?? 0) > MAX_BODY_BYTES) {
        res.statusCode = 413;
        res.end();
        return;
      }
      let body: Uint8Array;
      try {
        // Backstop for chunked / lying Content-Length: caps the streamed read.
        body = await readBody(req);
      } catch (err) {
        if (!res.headersSent) {
          res.statusCode = err instanceof PayloadTooLargeError ? 413 : 400;
        }
        res.end();
        return;
      }
      if (linkDown) {
        res.statusCode = 503; // RULE 4
        res.end();
        return;
      }
      if (isWantConfig(body)) {
        fromRadioQueue.length = 0; // RULE 3
        log("want_config received — flushed fromradio queue");
      }
      try {
        await writeToRadio(body);
        res.statusCode = 200;
        res.end();
      } catch {
        linkDown = true;
        res.statusCode = 503;
        res.end();
      }
      return;
    }
    res.statusCode = 405;
    res.end();
    return;
  }

  // --- Device HTTP API: GET /api/v1/fromradio ---
  if (path === "/api/v1/fromradio") {
    setCors(res);
    if (method === "OPTIONS") {
      res.statusCode = 204;
      res.end();
      return;
    }
    if (method !== "GET") {
      res.statusCode = 405;
      res.end();
      return;
    }
    if (linkDown) {
      res.statusCode = 503; // RULE 4
      res.end();
      return;
    }
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/x-protobuf");
    // RULE 2: at most one protobuf per response; empty body = drained.
    const next = fromRadioQueue.shift();
    if (next && next.byteLength > 0) {
      res.end(Buffer.from(next));
    } else {
      res.end();
    }
    return;
  }

  // --- Static web client ---
  if (method !== "GET" && method !== "HEAD") {
    res.statusCode = 405;
    res.end();
    return;
  }
  await serveStatic(path, res, method);
}

function stringifyError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function shutdown(signal: string): void {
  log(`received ${signal} — shutting down`);
  server.close();
  void teardownTransport().finally(() => process.exit(0));
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// Safety net: a flaky serial link must never take down the web server. Log only
// and keep running — real serial failures recover via the normal port
// error/close → teardown → reconnect path, so we must NOT force linkDown here
// (that could wedge a healthy link on an unrelated exception).
process.on("uncaughtException", (err) => {
  log(`uncaught exception (continuing): ${stringifyError(err)}`);
});
process.on("unhandledRejection", (reason) => {
  log(`unhandled rejection (continuing): ${stringifyError(reason)}`);
});

server.listen(PORT, HOST, () => {
  log(`listening on http://${HOST}:${PORT}  (static: ${STATIC_DIR})`);
  log(`bridging serial device: ${SERIAL_PATH}`);
});

void connectSerial();
