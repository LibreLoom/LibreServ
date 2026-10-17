import { phraseToEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { findMyKeys } from "@libreloom/ui/lib/cloud/cloudKeys.js";
import { getJson, postJson } from "./api";
import { buildPhraseBody, fromBase64, savePhrase, toBase64 } from "./cloudPhrase";

export const RESTORE_QUERY_KEY = ["cloud-restore"];
export const RESTORE_PATH = "/api/v1/cloud/restore";

const RECORD_KINDS = ["self", "recipients", "keys"];

/**
 * Whether Luna has lost its list of cloud backups, and how many versions exist.
 * @returns {Promise<{ needed: boolean, luna_id: string, signing_public: string, cloud_snapshots: number, indexed_snapshots: number }>}
 */
export function getRestoreStatus() {
  return getJson(RESTORE_PATH);
}

/** Fetch one kind of signed record list and decode each payload from base64. */
async function fetchRecords(kind) {
  const body = await getJson(`${RESTORE_PATH}/records/${kind}`);
  return (body.records ?? []).map((r) => ({ name: r.name, data: fromBase64(r.data) }));
}

/**
 * Open this person's backup keys and hand them to Luna.
 * The browser checks every signature before anything is sent. Luna never sees the phrase.
 * @param {string} words
 * @param {{ lunaId: string, signingPublic: string, userId: string, phraseSet: boolean }} ctx
 * @returns {Promise<{ snapshots: number, alreadyIndexed: number, skipped: number }>}
 */
export async function restoreFromPhrase(words, { lunaId, signingPublic, userId, phraseSet }) {
  const entropy = phraseToEntropy(words);

  const [self, recipients, keys] = await Promise.all(RECORD_KINDS.map(fetchRecords));
  // Throws SIGNING_MISMATCH or NO_BACKUPS as plain sentences. Nothing is sent when it does.
  const mine = findMyKeys({
    lunaId,
    entropy,
    self,
    recipients,
    keys,
    expectSigningPublic: fromBase64(signingPublic),
  });

  const result = await postJson(RESTORE_PATH, {
    keys: mine.keys.map((k) => ({
      protection_id: k.protectionId,
      version: k.version,
      key: toBase64(k.key),
      dedup_key: toBase64(k.dedupKey),
    })),
    old_user_ids: mine.userIds.filter((id) => id !== userId),
  });

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
  };
}
