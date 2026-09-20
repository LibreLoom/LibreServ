/**
 * dsh-memory-guard: prune tool-result content at append time to bound session
 * memory growth.
 *
 * Root cause of the 2026-08-28 pscA outage: dsh's session event log is an
 * append-only array that never shrinks. Compaction replaces the model-visible
 * surface but the underlying event objects stay in memory. 3 concurrent 36+
 * step CI jobs at reasoningEffort: high grew node heaps to 6-10GB each until
 * the host OOM-killed.
 *
 * The single largest contributor is tool/result events: a cargo build or test
 * log can be hundreds of KB, and the model only ever sees the pruned
 * head/tail (the tool-result-pruner caps it at thresholdChars). But the FULL
 * unpruned content is stored in the session log forever.
 *
 * THIS PLUGIN OPTIMIZES: it prunes tool/result content AT APPEND TIME,
 * synchronously in the same tick, so the in-memory log holds only what the
 * model sees. Persistence is untouched (it enqueues the original event object
 * reference in its own session/event listener, which runs before ours or
 * captures the same object — replacing log[seq] does not affect the queued
 * write). The agent-loop invariant (dispatch messages vs deriveMessages) is
 * safe because pruning happens during append, before the next deriveMessages()
 * call, so both see the same pruned state.
 *
 * Safety analysis (verified against dsh source):
 *  - session.append deep-copies data into a frozen event, pushes to log,
 *    then synchronously fires session/event listeners.
 *  - Persistence coordinator listens on session/event and enqueues the event
 *    for async write; it never re-reads the live log for writes.
 *  - deriveMessages() reads log[seq] for surface nodes — so replacing log[seq]
 *    with a pruned event changes what the model sees (intended).
 *  - tool-pairing (compaction) reads event.data.message.content for
 *    assistant/message tool-call blocks and tool/result — but only for
 *    surface nodes, and only to count tool-call/result balance. Pruning
 *    content preserves the block structure (type, id, name), so balance
 *    counting is unaffected.
 *  - The agent-loop invariant compares dispatch messages to a fresh
 *    deriveMessages() at llm/stream time. Since pruning is synchronous during
 *    append (before buildRequest/deriveMessages), both see pruned state.
 *
 * The V8 --max-old-space-size flag on the node process is the hard backstop.
 *
 * @module dsh-memory-guard
 */
import z from "@deepseek-ai/schemastery";

const name = "memory-guard";
const inject = ["agents"];

const Config = z.object({
  /** Prune tool-result text content when it exceeds this many chars (stock: 8192). */
  thresholdChars: z.number().step(1).min(1).default(8192),
  /** Keep this many chars from the head of pruned tool-result text (stock: 4096). */
  headChars: z.number().step(1).min(0).default(4096),
  /** Keep this many chars from the tail of pruned tool-result text (stock: 1024). */
  tailChars: z.number().step(1).min(0).default(1024),
  /** Heap usage threshold in MB that triggers abort (last resort). */
  heapLimitMb: z.number().step(1).min(1).default(2048),
  /** Polling interval in milliseconds. */
  intervalMs: z.number().step(1).min(100).max(60000).default(2000),
  /** Grace period (ms) after abort before force exit. */
  abortGraceMs: z.number().step(1).min(100).max(10000).default(2000),
  /** When true, log pruning stats. */
  verbose: z.boolean().default(false),
});

function mb(bytes) {
  return Math.round(bytes / 1048576);
}

function codePointLength(text) {
  return Array.from(text).length;
}

/**
 * Prune text content to head + marker + tail, preserving Unicode code points.
 * Returns null when within budget.
 */
function pruneText(text, thresholdChars, headChars, tailChars) {
  const total = codePointLength(text);
  if (total <= thresholdChars) return null;
  const marker = "\n\n[... tool result middle pruned ...]\n\n";
  const chars = Array.from(text);
  const head = chars.slice(0, headChars).join("");
  const tail = chars.slice(total - tailChars).join("");
  return head + marker + tail;
}

/**
 * Prune a tool/result event's content blocks in place (on a copy).
 * Returns a new data object with pruned content, or null if within budget.
 *
 * Real shape (verified from persisted sessions):
 *   data.message.content[0] = { type: "tool-result", toolCallId, content: [...], isError }
 *   data.message.content[0].content[0] = { type: "text", text: "..." }
 */
function pruneToolResultData(data, config) {
  const message = data?.message;
  if (!message || !Array.isArray(message.content) || message.content.length === 0) {
    return null;
  }
  const block = message.content[0];
  if (!block || block.type !== "tool-result" || !Array.isArray(block.content)) {
    return null;
  }
  // Find the first text block inside the tool-result content.
  let prunedAny = false;
  const newInner = block.content.map((b) => {
    if (b.type !== "text" || typeof b.text !== "string") return b;
    const prunedText = pruneText(b.text, config.thresholdChars, config.headChars, config.tailChars);
    if (prunedText === null) return b;
    prunedAny = true;
    return { ...b, text: prunedText };
  });
  if (!prunedAny) return null;

  const newContent = message.content.map((b, i) =>
    i === 0 ? { ...b, content: newInner } : b
  );
  return {
    ...data,
    message: {
      ...message,
      content: newContent,
    },
  };
}

function apply(ctx, config) {
  let prunedTotal = 0;
  let prunedBytes = 0;
  let triggered = false;
  console.error(`[memory-guard] apply() loaded: threshold=${config.thresholdChars} head=${config.headChars} tail=${config.tailChars} heapLimit=${config.heapLimitMb}`);

  // Hook session/event — fires synchronously during session.append.
  // Prune tool/result content in the LOG (replace log[seq]) so the in-memory
  // log holds only what the model sees. Persistence already captured the
  // original event in its own listener.
  ctx.on("session/event", (session, event) => {
    if (event.type !== "tool/result") return;
    const prunedData = pruneToolResultData(event.data, config);
    if (prunedData === null) return;

    // Replace log[seq] with a pruned copy. Preserve structural fields.
    const original = event.data;
    const before = JSON.stringify(original).length;
    const after = JSON.stringify(prunedData).length;
    session.log[event.seq] = Object.freeze({
      type: event.type,
      seq: event.seq,
      time: event.time,
      ...(event.surfaceOp !== undefined ? { surfaceOp: event.surfaceOp } : {}),
      ...(event.sourceEventSeqs !== undefined ? { sourceEventSeqs: event.sourceEventSeqs } : {}),
      data: prunedData,
    });
    prunedTotal++;
    prunedBytes += before - after;
    console.error(
      `[memory-guard] PRUNED tool/result seq=${event.seq} ${before}B -> ${after}B (saved ${before - after}B)`
    );
  });

  // Heap watchdog (last resort — pruning should keep this from firing).
  const poll = () => {
    if (triggered) return;
    const mem = process.memoryUsage();
    const heapMb = mb(mem.heapUsed);
    if (heapMb >= config.heapLimitMb) {
      triggered = true;
      console.error(
        `[memory-guard] heap ${heapMb}MB exceeds limit ${config.heapLimitMb}MB — aborting session`
      );
      try {
        const agent = ctx.agents?.requireInitiator?.();
        if (agent?.session) {
          agent.session.append("memory/pressure", {
            heapUsedMb: heapMb,
            heapLimitMb: config.heapLimitMb,
            prunedEvents: prunedTotal,
            prunedBytes: prunedBytes,
            message: "Session aborted: process heap exceeded configured limit",
          });
        }
        if (agent?.session?.abort) {
          agent.session.abort(
            new Error(`memory-guard: heap ${heapMb}MB exceeded limit ${config.heapLimitMb}MB`)
          );
        }
      } catch (e) {
        console.error(`[memory-guard] abort failed: ${e.message}`);
      }
      setTimeout(() => {
        console.error("[memory-guard] force exit — process did not exit gracefully");
        process.exit(1);
      }, config.abortGraceMs).unref?.();
    }
  };

  const timer = setInterval(poll, config.intervalMs);
  timer.unref?.();
  setImmediate(poll);

  ctx.effect(
    () => async () => {
      clearInterval(timer);
    },
    "memory-guard: cleanup timer"
  );
}

export { Config, apply, inject, name };