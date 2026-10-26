import { derive, phraseToEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import {
  PSCOPES_KIND,
  PSNAPSHOTS_KIND,
  findMyPrivateScopes,
  openPrivateDedup,
  openPrivateTreeBytes,
  openScopeSecret,
  privateUnwrap,
  readPrivateSnapshots,
  scopeOf,
  verifyScopeRecord,
} from "@libreloom/ui/lib/cloud/cloudPrivate.js";
import { readRawTreeWith } from "@libreloom/ui/lib/cloud/cloudFormat.js";
import { apiFetch, getJson, postJson } from "./api";
import { fromBase64, toBase64 } from "./cloudPhrase";

export const PRIVATE_RESTORE_QUERY_KEY = ["cloud-restore-private"];
export const PRIVATE_RESTORE_PATH = "/api/v1/cloud/restore-private";
export const KEPT_SCOPES_PATH = "/api/v1/cloud/phrase/kept-scopes";

const NOT_FOUND_MESSAGE = "This recovery phrase doesn't open any private backups on this Luna. Check each word.";
const PACK_FAILED_MESSAGE = "Could not download part of your private backups. Check your connection, then try again.";

/**
 * Whether Luna has lost its list of private items, and how many scopes exist.
 * @returns {Promise<{ needed: boolean, luna_id: string, signing_public: string, scopes: number }>}
 */
export function getPrivateRestoreStatus() {
  return getJson(PRIVATE_RESTORE_PATH);
}

/** Fetch the small scope list and decode each payload from base64. */
async function fetchRecords(kind) {
  const body = await getJson(`${PRIVATE_RESTORE_PATH}/records/${kind}`);
  return (body.records ?? []).map((r) => ({ name: r.name, data: fromBase64(r.data) }));
}

/** Fetch the names of records without retaining all signed snapshot bytes in the browser. */
async function fetchRecordNames(kind) {
  const body = await getJson(`${PRIVATE_RESTORE_PATH}/records/${kind}/names`);
  return body.names ?? [];
}

/** Fetch one signed record after Luna has checked that it belongs to the caller. */
async function fetchRecord(kind, name) {
  const body = await getJson(`${PRIVATE_RESTORE_PATH}/records/${kind}/${encodeURIComponent(name)}`);
  return { name: body.name, data: fromBase64(body.data) };
}

/**
 * Scopes the old phrase can still open from the copy Luna kept for 30 days after a phrase change.
 * Used only for scopes the current copy did not open. A failed fetch just means no fallback.
 */
async function openKeptScopes({ lunaId, entropy, pscopes, signingPublics, skip }) {
  let kept = [];
  try {
    kept = (await getJson(KEPT_SCOPES_PATH)).kept ?? [];
  } catch {
    return [];
  }
  const k = derive(entropy, lunaId);
  const found = [];
  try {
    for (const copy of kept) {
      if (skip.has(copy.scope)) continue;
      const record = pscopes.find((r) => r.name === copy.scope);
      if (!record) continue;
      const rec = verifyScopeRecord(record.data, signingPublics, lunaId);
      if (!rec || rec.scope !== copy.scope) continue;
      let sealSecret;
      let dedupKey;
      try {
        sealSecret = openScopeSecret(fromBase64(copy.sealed_scope_secret), k.sealSecret, lunaId, rec.scope);
        dedupKey = openPrivateDedup(rec.sealedDedup, sealSecret, lunaId, rec.scope);
      } catch {
        sealSecret?.fill(0);
        dedupKey?.fill(0);
        continue;
      }
      if (scopeOf(dedupKey) !== rec.scope) {
        sealSecret.fill(0);
        dedupKey.fill(0);
        continue;
      }
      found.push({ scope: rec.scope, userId: rec.userId, createdAt: rec.createdAt, dedupKey, sealSecret });
    }
    return found;
  } finally {
    k.sealSecret.fill(0);
    k.selfKey.fill(0);
    k.authSecret.fill(0);
  }
}

/** Download one tree pack as raw bytes. The caller clears it after opening the tree. */
async function fetchPack(treePackId) {
  const res = await apiFetch(`${PRIVATE_RESTORE_PATH}/packs/${treePackId}`);
  if (!res.ok) throw new Error(PACK_FAILED_MESSAGE);
  return new Uint8Array(await res.arrayBuffer());
}

/**
 * Open this person's private items with the recovery phrase and send each opened snapshot to Luna.
 * Every signature is checked in the browser first. The phrase never leaves this browser.
 * @param {string} words
 * @param {{ lunaId: string, signingPublic: string, onProgress?: (progress: { processed: number, total: number, snapshots: number, already_indexed: number, skipped: number }) => void }} ctx
 * @returns {Promise<{ restored: number }>} total versions restored over all scopes
 */
export async function restorePrivateFromPhrase(words, { lunaId, signingPublic, onProgress }) {
  const entropy = phraseToEntropy(words);
  let scopes = [];
  try {
    const signingPublics = [fromBase64(signingPublic)];
    const [pscopes, snapshotNames] = await Promise.all([
      fetchRecords(PSCOPES_KIND),
      fetchRecordNames(PSNAPSHOTS_KIND),
    ]);

    scopes = findMyPrivateScopes({ lunaId, entropy, pscopes, signingPublics });
    // After a phrase change, the old phrase no longer opens the current copy. Luna keeps the previous
    // copy for 30 days (only when no one else could have the phrase), so try that for the rest.
    scopes.push(
      ...(await openKeptScopes({
        lunaId,
        entropy,
        pscopes,
        signingPublics,
        skip: new Set(scopes.map((s) => s.scope)),
      })),
    );
    if (scopes.length === 0) throw new Error(NOT_FOUND_MESSAGE);

    const namesByScope = new Map(scopes.map((scope) => [
      scope.scope,
      snapshotNames.filter((name) => name.startsWith(`${scope.scope}.`)),
    ]));
    const total = [...namesByScope.values()].reduce((sum, names) => sum + names.length, 0);
    let processed = 0;
    let alreadyIndexed = 0;
    let skipped = 0;
    let restored = 0;
    const reportProgress = () => onProgress?.({
      processed,
      total,
      snapshots: restored,
      already_indexed: alreadyIndexed,
      skipped,
    });
    reportProgress();

    for (const found of scopes) {
      // Each scope has its own key; the phrase opened it in findMyPrivateScopes.
      const { sealSecret } = found;
      const unwrapKey = privateUnwrap(sealSecret, lunaId, found.scope);
      const openTreeBytes = openPrivateTreeBytes(sealSecret, lunaId, found.scope);
      for (const name of namesByScope.get(found.scope) ?? []) {
        const record = await fetchRecord(PSNAPSHOTS_KIND, name);
        try {
          const [snap] = readPrivateSnapshots({
            lunaId,
            sealSecret,
            scope: found.scope,
            psnapshots: [record],
            signingPublics,
          });
          if (!snap) {
            skipped++;
            processed++;
            reportProgress();
            continue;
          }

          const treePack = await fetchPack(snap.treePackId);
          let tree;
          try {
            tree = readRawTreeWith(treePack, snap, unwrapKey, openTreeBytes);
            const data = await postJson(PRIVATE_RESTORE_PATH, {
              scope: found.scope,
              dedup_key: toBase64(found.dedupKey),
              snapshots: [{
                snapshot_id: snap.snapshotId,
                protection_id: snap.protectionId,
                record: toBase64(record.data),
                meta: {
                  name: snap.meta.name,
                  source_drive: snap.meta.sourceDrive,
                  source_path: snap.meta.sourcePath,
                },
                tree,
              }],
            });
            const inserted = data.restored ?? 1;
            restored += inserted;
            alreadyIndexed += inserted === 0 ? 1 : 0;
          } finally {
            if (Array.isArray(tree?.entries)) tree.entries.length = 0;
            treePack.fill(0);
          }
          processed++;
          reportProgress();
        } finally {
          record.data.fill(0);
        }
      }
    }

    return { restored };
  } finally {
    entropy.fill(0);
    for (const found of scopes) {
      found.sealSecret.fill(0);
      found.dedupKey.fill(0);
    }
  }
}
