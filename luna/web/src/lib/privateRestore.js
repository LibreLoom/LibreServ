import { phraseToEntropy, derive } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import {
  PSCOPES_KIND,
  PSNAPSHOTS_KIND,
  findMyPrivateScopes,
  openPrivateTreeBytes,
  privateUnwrap,
  readPrivateSnapshots,
} from "@libreloom/ui/lib/cloud/cloudPrivate.js";
import { readRawTreeWith } from "@libreloom/ui/lib/cloud/cloudFormat.js";
import { apiFetch, getJson, postJson } from "./api";
import { fromBase64, toBase64 } from "./cloudPhrase";

export const PRIVATE_RESTORE_QUERY_KEY = ["cloud-restore-private"];
export const PRIVATE_RESTORE_PATH = "/api/v1/cloud/restore-private";

const NOT_FOUND_MESSAGE = "This recovery phrase doesn't open any private backups on this Luna. Check each word.";
const PACK_FAILED_MESSAGE = "Could not download part of your private backups. Check your connection, then try again.";

/**
 * Whether Luna has lost its list of private items, and how many scopes exist.
 * @returns {Promise<{ needed: boolean, luna_id: string, signing_public: string, scopes: number }>}
 */
export function getPrivateRestoreStatus() {
  return getJson(PRIVATE_RESTORE_PATH);
}

/** Fetch one kind of signed record list and decode each payload from base64. */
async function fetchRecords(kind) {
  const body = await getJson(`${PRIVATE_RESTORE_PATH}/records/${kind}`);
  return (body.records ?? []).map((r) => ({ name: r.name, data: fromBase64(r.data) }));
}

/** Download one tree pack as raw bytes, reusing bytes already fetched in this run. */
async function fetchPack(treePackId, cache) {
  if (cache.has(treePackId)) return cache.get(treePackId);
  const res = await apiFetch(`${PRIVATE_RESTORE_PATH}/packs/${treePackId}`);
  if (!res.ok) throw new Error(PACK_FAILED_MESSAGE);
  const bytes = new Uint8Array(await res.arrayBuffer());
  cache.set(treePackId, bytes);
  return bytes;
}

/**
 * Open this person's private items with the recovery phrase and hand the opened pieces to Luna.
 * Every signature is checked in the browser first. The phrase never leaves this browser.
 * @param {string} words
 * @param {{ lunaId: string, signingPublic: string }} ctx
 * @returns {Promise<{ restored: number }>} total versions restored over all scopes
 */
export async function restorePrivateFromPhrase(words, { lunaId, signingPublic }) {
  const entropy = phraseToEntropy(words);
  const signingPublics = [fromBase64(signingPublic)];
  const [pscopes, psnapshots] = await Promise.all([
    fetchRecords(PSCOPES_KIND),
    fetchRecords(PSNAPSHOTS_KIND),
  ]);

  const scopes = findMyPrivateScopes({ lunaId, entropy, pscopes, signingPublics });
  if (scopes.length === 0) throw new Error(NOT_FOUND_MESSAGE);

  // The signed snapshot record bytes, keyed by record name, so Luna gets the original signed bytes.
  const rawSnapshotRecords = new Map(psnapshots.map((r) => [r.name, r.data]));
  const { sealSecret } = derive(entropy, lunaId);
  const packCache = new Map();
  let restored = 0;

  for (const found of scopes) {
    const views = readPrivateSnapshots({
      lunaId,
      entropy,
      scope: found.scope,
      psnapshots,
      signingPublics,
    });
    if (views.length === 0) continue;

    const unwrapKey = privateUnwrap(sealSecret, lunaId, found.scope);
    const openTreeBytes = openPrivateTreeBytes(sealSecret, lunaId, found.scope);
    const snapshots = [];
    for (const snap of views) {
      const recordBytes = rawSnapshotRecords.get(`${found.scope}.${snap.snapshotId}`);
      const treePack = await fetchPack(snap.treePackId, packCache);
      const tree = readRawTreeWith(treePack, snap, unwrapKey, openTreeBytes);
      snapshots.push({
        snapshot_id: snap.snapshotId,
        protection_id: snap.protectionId,
        record: toBase64(recordBytes),
        meta: {
          name: snap.meta.name,
          source_drive: snap.meta.sourceDrive,
          source_path: snap.meta.sourcePath,
        },
        tree,
      });
    }

    const data = await postJson(PRIVATE_RESTORE_PATH, {
      scope: found.scope,
      dedup_key: toBase64(found.dedupKey),
      snapshots,
    });
    restored += data.restored ?? snapshots.length;
  }

  return { restored };
}
