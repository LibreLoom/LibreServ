import { phraseToEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { findMyKeys } from "@libreloom/ui/lib/cloud/cloudKeys.js";
import { apiFetch, getJson } from "./api";
import { buildPhraseBody, fromBase64, savePhrase, signFreshChallenge, toBase64 } from "./cloudPhrase";

export const RESTORE_QUERY_KEY = ["cloud-restore"];
export const RESTORE_PATH = "/api/v1/cloud/restore";

const RECORD_KINDS = ["self", "recipients", "keys"];

/**
 * Whether Luna has lost its list of cloud backups, and how many versions exist.
 * @returns {Promise<{ needed: boolean, relink_pending?: boolean, luna_id: string, signing_public: string, cloud_snapshots: number, indexed_snapshots: number }>}
 */
export function getRestoreStatus() {
  return getJson(RESTORE_PATH);
}

/** Fetch one kind of signed record list and decode each payload from base64. */
async function fetchRecords(kind, signal) {
  const body = await getJson(`${RESTORE_PATH}/records/${kind}`, { signal });
  return (body.records ?? []).map((r) => ({ name: r.name, data: fromBase64(r.data) }));
}

/**
 * Open this person's backup keys and hand them to Luna.
 * The browser checks every signature before anything is sent. Luna never sees the phrase.
 * @param {string} words
 * @param {{ lunaId: string, signingPublic: string, userId: string, phraseSet: boolean }} ctx
 * @param {(progress: { processed: number, total: number, snapshots: number, already_indexed: number, skipped: number }) => void} [onProgress]
 * @param {AbortSignal} [signal]
 * @returns {Promise<{ snapshots: number, alreadyIndexed: number, skipped: number, warning?: string }>}
 */
export async function restoreFromPhrase(words, { lunaId, signingPublic, userId, phraseSet }, onProgress = () => {}, signal) {
  const entropy = phraseToEntropy(words);
  let mine;
  try {
    const [self, recipients, keys] = await Promise.all(RECORD_KINDS.map((kind) => fetchRecords(kind, signal)));
    // Throws SIGNING_MISMATCH or NO_BACKUPS as plain sentences. Nothing is sent when it does.
    mine = findMyKeys({
      lunaId,
      entropy,
      self,
      recipients,
      keys,
      expectSigningPublic: fromBase64(signingPublic),
    });

    // Proves this person holds the phrase, so Luna can re-link their old backups.
    // If the challenge or signing fails, send an empty signature: Luna still rebuilds
    // its list but does not re-link anything.
    let signature = "";
    try {
      signature = await signFreshChallenge(entropy, lunaId, signal);
    } catch {
      signature = "";
  }
    let response;
    try {
      response = await apiFetch(RESTORE_PATH, {
        method: "POST",
        signal,
        headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
        body: JSON.stringify({
          keys: mine.keys.map((k) => ({
            protection_id: k.protectionId,
            version: k.version,
            key: toBase64(k.key),
            dedup_key: toBase64(k.dedupKey),
          })),
          old_user_ids: mine.userIds.filter((id) => id !== userId),
          signature,
        }),
      });
    } catch (err) {
      if (signal?.aborted) throw new DOMException("Restore stopped", "AbortError");
      throw err;
    }
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Luna could not finish reading cloud backups. Try again.");
    }
    if (!response.body) throw new Error("Luna could not show restore progress. Try again.");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let result;
    let latestProgress = {};
    while (true) {
      const { value, done } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const frames = buffer.split("\n\n");
      buffer = frames.pop() || "";
      for (const frame of frames) {
        const line = frame.split("\n").find((part) => part.startsWith("data: "));
        if (!line) continue;
        const event = JSON.parse(line.slice(6));
        if (event.type === "progress") {
          latestProgress = event;
          onProgress(event);
        }
        if (event.type === "error") throw new Error(event.message);
        if (event.type === "done") {
          result = event;
          onProgress({ ...latestProgress, ...event, type: "finishing", message: phraseSet ? "Finishing restore…" : "Saving your recovery phrase…" });
        }
      }
      if (done) break;
    }
    if (!result) throw new Error("Restore stopped before it finished. Some backup versions may already be back; you can safely try again.");

    if (!phraseSet) {
      try {
        await savePhrase(buildPhraseBody(entropy, { lunaId, userId, signingPublic }));
      } catch {
        throw new Error(
          "Your backups are back, but saving your recovery phrase to this account failed. Set it up again in Settings → Cloud backup.",
        );
      }
    }

    return {
      snapshots: result.snapshots ?? 0,
      alreadyIndexed: result.already_indexed ?? 0,
      skipped: result.skipped ?? 0,
      ...(result.warning ? { warning: result.warning } : {}),
    };
  } catch (err) {
    if (signal?.aborted) throw new DOMException("Restore stopped", "AbortError");
    throw err;
  } finally {
    entropy.fill(0);
    for (const key of mine?.keys ?? []) {
      key.key.fill(0);
      key.dedupKey.fill(0);
    }
    for (const scope of mine?.privateScopes ?? []) scope.dedupKey.fill(0);
  }
}
