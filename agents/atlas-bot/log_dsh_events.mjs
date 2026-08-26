#!/usr/bin/env node
// Decode dsh session.jsonl.zstd the same way
// @deepseek-ai/dsh-session-persistence-jsonl does: Node zlib zstdDecompressSync
// plus concatenated-frame scan. Do not call the host glibc zstd binary.
import { zstdDecompressSync } from "node:zlib";
import fs from "node:fs";
import path from "node:path";

const ZSTD_MAGIC = 0xFD2FB528;
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

function decompressFile(file) {
  const buf = fs.readFileSync(file);
  if (!file.endsWith(".zstd")) return buf.toString("utf8");
  const { frames } = scanZstdFrames(buf);
  const parts = [];
  for (const { start, end } of frames) {
    try {
      parts.push(zstdDecompressSync(buf.subarray(start, end)));
    } catch {
      break;
    }
  }
  return parts.length ? Buffer.concat(parts).toString("utf8") : "";
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

function replay(raw, file, lastN, seen, logf) {
  let n = 0;
  for (const line0 of raw.split("\n")) {
    n += 1;
    if (n <= lastN) continue;
    const line = line0.trim();
    if (!line) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    const key = `${file}\0${ev.seq ?? n}\0${ev.type || ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const t = ev.type || "";
    if (SKIP.has(t)) continue;
    emitLine(`==> dsh ${summarize(ev)}\n`, logf);
  }
  return n;
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

const argv = process.argv.slice(2);
if (argv[0] === "--last-text") {
  const home = argv[1] || "/opt/atlas-bot/dsh-home";
  const roots = [...new Set([
    path.join(home, "sessions"),
    "/opt/atlas-bot/dsh-home/sessions",
    "/opt/dsh/sessions",
  ])];
  const newest = newestSession(roots);
  if (!newest) process.exit(1);
  let raw = "";
  try {
    raw = decompressFile(newest);
  } catch {
    process.exit(1);
  }
  const text = lastVisibleText(raw);
  if (!text) process.exit(1);
  process.stdout.write(text);
  process.exit(0);
}

if (argv[0] === "--once") {
  const file = argv[1];
  if (!file) {
    process.stderr.write("log_dsh_events.mjs --once <session.jsonl.zstd>\n");
    process.exit(2);
  }
  const raw = decompressFile(file);
  replay(raw, file, 0, new Set(), null);
  process.exit(0);
}

const home = argv[0] || "/opt/atlas-bot/dsh-home";
const logfile = argv[1];
if (!logfile) {
  process.stderr.write("log_dsh_events.mjs <DSH_HOME> <logfile>\n");
  process.exit(2);
}

const roots = [...new Set([
  path.join(home, "sessions"),
  "/opt/atlas-bot/dsh-home/sessions",
  "/opt/dsh/sessions",
])];

const logf = fs.openSync(logfile, "a");
emitLine("==> dsh logger start\n", logf);

let lastFile = "";
let lastN = 0;
const seen = new Set();

function tick() {
  const newest = newestSession(roots);
  if (!newest) return;
  if (newest !== lastFile) {
    lastFile = newest;
    lastN = 0;
  }
  let raw = "";
  try {
    raw = decompressFile(newest);
  } catch {
    return;
  }
  lastN = replay(raw, newest, lastN, seen, logf);
}

setInterval(tick, 2000);
tick();
