#!/usr/bin/env node
// Decode dsh session.jsonl.zstd the same way
// @deepseek-ai/dsh-session-persistence-jsonl does: Node zlib zstdDecompressSync
// plus concatenated-frame scan. Do not call the host glibc zstd binary.
//
// v2 (memory fix, 2026-08-28): the original tailed the session file by
// re-decompressing the ENTIRE file every 2s and re-parsing every line,
// retaining every event key in an unbounded `seen` Set. For long CI jobs
// (100+ steps, 4000+ events) this ballooned to 5.7GB+ RSS and was a
// major contributor to the 2026-08-28 pscA OOM. This version reads only the
// NEW bytes appended since the last tick (zstd flush frames are appended
// monotonically by the persistence layer), so memory stays flat regardless
// of session size.
import { zstdDecompressSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const ZSTD_MAGIC = 0xfd2fb528;
const SKIP = new Set([
  "assistant/chunk",
  "tool-call-chunks",
  "request/header",
  "request/context",
  "agent/inbox/spliced",
  "user/message",
  "session/title",
]);

function scanZstdFrames(buffer, maxFrames = Number.POSITIVE_INFINITY) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return { frames, tornStart: start };
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid zstd magic at ${offset}`);
    }
    offset += 4;
    if (offset === buffer.length) return { frames, tornStart: start };
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 24) !== 0) throw new Error("reserved frame-header bit");
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : (1 << contentSizeFlag);
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start };
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start };
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      if (blockType === 3) throw new Error("reserved block type");
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start };
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start };
      offset += 4;
    }
    frames.push({ start, end: offset });
    if (frames.length === maxFrames) return { frames };
  }
  return { frames };
}

// Decompress only the frames wholly contained in `buffer` (all of them, or
// starting from a given offset). Returns { text, completeFramesEnd } where
// completeFramesEnd is the byte offset just past the last fully-decoded frame.
function decompressFrames(buffer, fromOffset = 0) {
  const { frames } = scanZstdFrames(buffer.subarray(fromOffset));
  const parts = [];
  // Frames are relative to fromOffset; convert back.
  let lastEnd = fromOffset;
  for (const { start, end } of frames) {
    const absStart = fromOffset + start;
    const absEnd = fromOffset + end;
    try {
      parts.push(zstdDecompressSync(buffer.subarray(absStart, absEnd)));
      lastEnd = absEnd;
    } catch {
      // torn/partial frame at the tail; stop here
      break;
    }
  }
  return { text: parts.length ? Buffer.concat(parts).toString("utf8") : "", lastEnd };
}

function collectLogs(dir, acc) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    const full = path.join(dir, ent.name);
    let isDir = ent.isDirectory();
    let isFile = ent.isFile();
    if (ent.isSymbolicLink()) {
      try {
        const st = fs.statSync(full);
        isDir = st.isDirectory();
        isFile = st.isFile();
      } catch {
        continue;
      }
    }
    if (isDir) collectLogs(full, acc);
    else if (isFile && (ent.name === "session.jsonl.zstd" || ent.name === "session.jsonl")) acc.push(full);
  }
}

function newestSession(roots) {
  const files = [];
  for (const root of roots) collectLogs(root, files);
  let best = null;
  let bestM = -1;
  for (const f of files) {
    try {
      const m = fs.statSync(f).mtimeMs;
      if (m >= bestM) {
        best = f;
        bestM = m;
      }
    } catch {
      /* gone */
    }
  }
  return best;
}

function summarize(ev) {
  const t = ev.type || "";
  const d = ev.data && typeof ev.data === "object" ? ev.data : {};
  if (t === "tool/call") return `tool ${d.name || "?"}`;
  if (t === "tool/result") return `tool-result${d.error || d.isError ? " err" : ""}`;
  if (t === "llm/retry" || t === "llm/retry-started") {
    const fail = d.failure && typeof d.failure === "object" ? d.failure : {};
    return `${t} ${fail.code || d.code || ""}`.trim();
  }
  if (t === "step/start") return `step ${d.step ?? "?"}`;
  if (t === "reasoning-chunks") return "reasoning";
  if (t === "assistant/message") return "assistant";
  if (
    t === "session" ||
    t === "turn/start" ||
    t === "permission/preset" ||
    t === "sandbox/mode" ||
    t === "approval/policy"
  ) {
    return `${t} ${d.policy || d.preset || d.mode || ""}`.trim();
  }
  return t;
}

function emitLine(line, logf) {
  if (logf !== null) fs.writeSync(logf, line);
  process.stderr.write(line);
}

// Replay lines from `raw` that we have not emitted yet, keyed by (seq,type).
// `seen` retains the dedup keys for the CURRENT file only; when we switch
// files we reset it. For a single growable file, we only ever hand `raw`
// the NEW tail, so `seen` stays small.
function replay(raw, file, seen, logf) {
  for (const line0 of raw.split("\n")) {
    const line = line0.trim();
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const key = `${file}\0${ev.seq ?? ""}\0${ev.type || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = ev.type || "";
    if (SKIP.has(t)) continue;
    emitLine(`==> dsh ${summarize(ev)}\n`, logf);
  }
}

function visibleAssistantText(ev) {
  const msg = ev && ev.data && ev.data.message;
  const content = msg && typeof msg === "object" ? msg.content : null;
  if (!Array.isArray(content)) return "";
  const bits = [];
  for (const part of content) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "reasoning") continue;
    if (part.type === "text" && typeof part.text === "string") bits.push(part.text);
  }
  return bits.join("").trim();
}

function lastVisibleText(raw) {
  let last = "";
  for (const line0 of raw.split("\n")) {
    const line = line0.trim();
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type !== "assistant/message") continue;
    const t = visibleAssistantText(ev);
    if (t) last = t;
  }
  return last;
}

// Read only the bytes of `file` from `fromOffset` onward, decompress new
// frames, and replay new events. Returns the new safe offset (end of the
// last complete frame) or the previous offset if nothing was gained.
function processTail(file, fromOffset) {
  let fd;
  let buf;
  try {
    fd = fs.openSync(file, "r");
    const st = fs.fstatSync(fd);
    const size = st.size;
    if (size <= fromOffset) return fromOffset;
    // Read from the last processed offset to EOF.
    buf = Buffer.allocUnsafe(size - fromOffset);
    fs.readSync(fd, buf, 0, buf.length, fromOffset);
  } catch {
    return fromOffset;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
  let text = "";
  let lastEnd = fromOffset;
  if (buf.length > 0) {
    try {
      const dec = decompressFrames(buf);
      text = dec.text;
      lastEnd = fromOffset + (dec.lastEnd - 0);
    } catch {
      return fromOffset;
    }
  }
  if (text) replay(text, file, seenFor(file), logf);
  return lastEnd;
}

// Per-file seen sets: only current file's keys are retained.
const seenMaps = new Map();
function seenFor(file) {
  let s = seenMaps.get(file);
  if (!s) {
    s = new Set();
    seenMaps.set(file, s);
    // Bound memory: if we track many files, drop the oldest.
    if (seenMaps.size > 4) {
      const first = seenMaps.keys().next().value;
      seenMaps.delete(first);
    }
  }
  return s;
}

if (process.argv.slice(2)[0] === "--last-text") {
  const home = process.argv.slice(2)[1] || "/opt/lock-bot/dsh-home";
  const roots = [...new Set([
    path.join(home, "sessions"),
    "/opt/lock-bot/dsh-home/sessions",
    "/opt/dsh/sessions",
  ])];
  const newest = newestSession(roots);
  if (!newest) process.exit(1);
  let raw = "";
  try {
    const buf = fs.readFileSync(newest);
    raw = decompressFrames(buf).text;
  } catch {
    process.exit(1);
  }
  const text = lastVisibleText(raw);
  if (!text) process.exit(1);
  process.stdout.write(text);
  process.exit(0);
}

if (process.argv.slice(2)[0] === "--once") {
  const file = process.argv.slice(2)[1];
  if (!file) {
    process.stderr.write("log_dsh_events.mjs --once <session.jsonl.zstd>\n");
    process.exit(2);
  }
  const buf = fs.readFileSync(file);
  const raw = decompressFrames(buf).text;
  const seen = new Set();
  replay(raw, file, seen, null);
  process.exit(0);
}

const home = process.argv.slice(2)[0] || "/opt/lock-bot/dsh-home";
const logfile = process.argv.slice(2)[1];
if (!logfile) {
  process.stderr.write("log_dsh_events.mjs <DSH_HOME> <logfile>\n");
  process.exit(2);
}

const roots = [...new Set([
  path.join(home, "sessions"),
  "/opt/lock-bot/dsh-home/sessions",
  "/opt/dsh/sessions",
])];

const logf = fs.openSync(logfile, "a");
emitLine("==> dsh logger start\n", logf);

let lastFile = "";
let offsets = new Map();

function tick() {
  const newest = newestSession(roots);
  if (!newest) return;
  if (newest !== lastFile) {
    lastFile = newest;
  }
  let off = offsets.get(newest) || 0;
  let next = off;
  try {
    next = processTail(newest, off);
  } catch {
    // transient; keep old offset (rescan from old offset next tick)
    return;
  }
  if (next > off) offsets.set(newest, next);
}

setInterval(tick, 2000);
tick();