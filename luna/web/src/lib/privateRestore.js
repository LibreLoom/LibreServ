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

/** Fetch one bounded page of caller-owned scope records from the daemon. */
async function fetchScopePage(after, signal, version, total, processed) {
  const query = new URLSearchParams({ limit: "64", processed: String(processed) });
  if (after) query.set("after", after);
  if (version !== undefined) query.set("version", String(version));
  if (total !== undefined) query.set("total", String(total));
  const path = `${PRIVATE_RESTORE_PATH}/records/${PSCOPES_KIND}?${query.toString()}`;
  const page = await requestWithRestoreSignal(signal, () =>
    signal ? getJson(path, { signal }) : getJson(path));
  return { ...page, records: (page.records ?? []).map((r) => ({ name: r.name, data: fromBase64(r.data) })) };
}

function validateScopePage(page, { after, processed, expectedTotal, expectedVersion }) {
  if (!Array.isArray(page.records) || page.records.length > 64
      || !Number.isSafeInteger(page.scanned) || page.scanned < 0 || page.scanned > 64
      || !Number.isSafeInteger(page.total) || page.total < 0
      || !Number.isSafeInteger(page.version) || page.version < 0
      || (expectedTotal !== undefined && page.total !== expectedTotal)
      || (expectedVersion !== undefined && page.version !== expectedVersion)
      || page.records.length > page.scanned
      || (page.next_after != null && (typeof page.next_after !== "string"
        || page.next_after.length > 128
        || !/^[a-z0-9._-]+$/.test(page.next_after)
        || page.next_after === "."
        || page.next_after.includes("..")))) {
    throw new Error("The private backup list changed or returned an invalid page. Try again.");
  }
  let previous = "";
  for (const record of page.records) {
    if (typeof record.name !== "string" || !/^[a-f0-9]{32}$/.test(record.name) || record.name <= previous) {
      throw new Error("The private backup list changed or returned an invalid page. Try again.");
    }
    previous = record.name;
  }
  if ((page.next_after == null && processed + page.scanned !== page.total)
      || (page.next_after != null && (page.scanned !== 64
        || page.next_after <= (after ?? "")
        || page.records.some((record) => record.name > page.next_after)
        || processed + page.scanned >= page.total))) {
    throw new Error("The private backup list changed or returned an incomplete page. Try again.");
  }
}

/** Fetch a bounded page of names from one scope the daemon re-authorizes on every request. */
/** @param {string} kind @param {string} scope @param {string | undefined} after */
/** @returns {Promise<{ names: string[], total: number, next_after?: string | null, version: number }>} */
/** @param {string} kind @param {string} scope @param {string | undefined} after @param {AbortSignal | undefined} signal @param {number | undefined} version @param {number | undefined} total */
async function fetchRecordNames(kind, scope, after, signal, version, total) {
  const query = new URLSearchParams({ scope, limit: "64" });
  if (after) query.set("after", after);
  if (version !== undefined) query.set("version", String(version));
  if (total !== undefined) query.set("total", String(total));
  const path = `${PRIVATE_RESTORE_PATH}/records/${kind}/names?${query.toString()}`;
  return requestWithRestoreSignal(signal, () =>
    signal ? getJson(path, { signal }) : getJson(path));
}

function stoppedRestore() {
  return new DOMException("Restore stopped", "AbortError");
}

function checkRestoreSignal(signal) {
  if (signal?.aborted) throw stoppedRestore();
}

/** @template T @param {AbortSignal | undefined} signal @param {() => Promise<T>} request @returns {Promise<T>} */
async function requestWithRestoreSignal(signal, request) {
  checkRestoreSignal(signal);
  try {
    return await request();
  } catch (error) {
    if (signal?.aborted) throw stoppedRestore();
    throw error;
  }
}

/** @param {{ names: string[], total: number, next_after?: string | null, version?: number }} page */
/** @param {{ scope: string, after: string | undefined, processed: number, expectedTotal: number | undefined, expectedVersion: number | undefined }} context */
function validateRecordNamesPage(page, context) {
  const { scope, after, processed, expectedTotal, expectedVersion } = context;
  const prefix = `${scope}.`;
  if (!Array.isArray(page.names) || page.names.length > 64
      || !Number.isSafeInteger(page.total) || page.total < 0
      || !Number.isSafeInteger(page.version) || page.version < 0
      || (expectedTotal !== undefined && page.total !== expectedTotal)
      || (expectedVersion !== undefined && page.version !== expectedVersion)) {
    throw new Error("The private backup list changed or returned an invalid page. Try again.");
  }
  let previous = after ?? prefix;
  for (const name of page.names) {
    if (typeof name !== "string" || !name.startsWith(prefix) || name <= previous) {
      throw new Error("The private backup list changed or returned an invalid page. Try again.");
    }
    previous = name;
  }
  if ((page.next_after == null && processed + page.names.length !== page.total)
      || (page.next_after != null && (page.names.length !== 64
        || page.next_after !== page.names[page.names.length - 1]
        || page.next_after <= (after ?? "")))) {
    throw new Error("The private backup list changed or returned an incomplete page. Try again.");
  }
}

/** Fetch one signed record after Luna has checked that it belongs to the caller. */
async function fetchRecord(kind, name, signal) {
  const path = `${PRIVATE_RESTORE_PATH}/records/${kind}/${encodeURIComponent(name)}`;
  const body = await requestWithRestoreSignal(signal, () =>
    signal ? getJson(path, { signal }) : getJson(path));
  return { name: body.name, data: fromBase64(body.data) };
}

/**
 * Scopes the old phrase can still open from the copy Luna kept for 30 days after a phrase change.
 * Used only for scopes the current copy did not open. A failed fetch must stay visible so a retry
 * does not silently report success without checking the saved copy.
 */
async function openKeptScopes({ lunaId, entropy, pscopes, signingPublics, skip, kept, signal }) {
  const k = derive(entropy, lunaId);
  const found = [];
  try {
    for (const copy of kept) {
      checkRestoreSignal(signal);
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
async function fetchPack(scope, snapshotId, treePackId, signal) {
  const path = `${PRIVATE_RESTORE_PATH}/packs/${scope}/${snapshotId}/${treePackId}`;
  const res = await requestWithRestoreSignal(signal, () =>
    signal ? apiFetch(path, { signal }) : apiFetch(path));
  if (!res.ok) throw new Error(PACK_FAILED_MESSAGE);
  return new Uint8Array(await requestWithRestoreSignal(signal, () => res.arrayBuffer()));
}

/**
 * Open this person's private items with the recovery phrase and send each opened snapshot to Luna.
 * Every signature is checked in the browser first. The phrase never leaves this browser.
 * @param {string} words
 * @param {{ lunaId: string, signingPublic: string, onProgress?: (progress: { processed: number, total: number, snapshots: number, already_indexed: number, skipped: number, message?: string }) => void, signal?: AbortSignal }} ctx
 * @returns {Promise<{ restored: number }>} total versions restored over all scopes
 */
export async function restorePrivateFromPhrase(words, { lunaId, signingPublic, onProgress, signal }) {
  checkRestoreSignal(signal);
  const entropy = phraseToEntropy(words);
  let scopes = [];
  let scopeRecords = [];
  let restored = 0;
  let alreadyIndexed = 0;
  let skipped = 0;
  let discoveredScopes = 0;
  try {
    const signingPublics = [fromBase64(signingPublic)];
    const keptResponse = await requestWithRestoreSignal(signal, () =>
      signal ? getJson(KEPT_SCOPES_PATH, { signal }) : getJson(KEPT_SCOPES_PATH));
    const kept = keptResponse.kept ?? [];

    let scopeAfter;
    let scopeVersion;
    let scopeTotal;
    let scopeProcessed = 0;
    for (;;) {
      checkRestoreSignal(signal);
      const scopePage = await fetchScopePage(scopeAfter, signal, scopeVersion, scopeTotal, scopeProcessed);
      validateScopePage(scopePage, {
        after: scopeAfter,
        processed: scopeProcessed,
        expectedTotal: scopeTotal,
        expectedVersion: scopeVersion,
      });
      scopeVersion = scopePage.version;
      scopeTotal = scopePage.total;
      scopeRecords = scopePage.records;
      scopes = findMyPrivateScopes({ lunaId, entropy, pscopes: scopeRecords, signingPublics });
      scopes.push(
        ...(await openKeptScopes({
          lunaId,
          entropy,
          pscopes: scopeRecords,
          signingPublics,
          skip: new Set(scopes.map((scope) => scope.scope)),
          kept,
          signal,
        })),
      );
      discoveredScopes += scopes.length;
      let nextPrivateBackupNumber = discoveredScopes - scopes.length;

      for (const found of scopes) {
        checkRestoreSignal(signal);
        const privateBackupNumber = ++nextPrivateBackupNumber;
        try {
          // Each scope has its own key; the phrase opened it in findMyPrivateScopes.
          const { sealSecret } = found;
          const unwrapKey = privateUnwrap(sealSecret, lunaId, found.scope);
          const openTreeBytes = openPrivateTreeBytes(sealSecret, lunaId, found.scope);
          let after;
          let snapshotProcessed = 0;
          let expectedTotal;
          let expectedVersion;
          for (;;) {
            checkRestoreSignal(signal);
            const page = await fetchRecordNames(
              PSNAPSHOTS_KIND,
              found.scope,
              after,
              signal,
              expectedVersion,
              expectedTotal,
            );
            validateRecordNamesPage(page, {
              scope: found.scope,
              after,
              processed: snapshotProcessed,
              expectedTotal,
              expectedVersion,
            });
            expectedTotal = page.total;
            expectedVersion = page.version;
            if (page.total === 0) {
              onProgress?.({
                processed: 0,
                total: 0,
                snapshots: restored,
                already_indexed: alreadyIndexed,
                skipped,
                message: `Checking private backup ${privateBackupNumber}`,
              });
            }
            for (const name of page.names) {
              checkRestoreSignal(signal);
              const record = await fetchRecord(PSNAPSHOTS_KIND, name, signal);
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
                  snapshotProcessed++;
                  onProgress?.({
                    processed: snapshotProcessed,
                    total: page.total,
                    snapshots: restored,
                    already_indexed: alreadyIndexed,
                    skipped,
                    message: `Checking version ${snapshotProcessed} of ${page.total} in private backup ${privateBackupNumber}`,
                  });
                  continue;
                }

                const treePack = await fetchPack(found.scope, snap.snapshotId, snap.treePackId, signal);
                let tree;
                try {
                  tree = readRawTreeWith(treePack, snap, unwrapKey, openTreeBytes);
                  const body = {
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
                  };
                  const data = await requestWithRestoreSignal(signal, () =>
                    signal ? postJson(PRIVATE_RESTORE_PATH, body, { signal }) : postJson(PRIVATE_RESTORE_PATH, body));
                  const inserted = data.restored ?? 1;
                  restored += inserted;
                  alreadyIndexed += inserted === 0 ? 1 : 0;
                } finally {
                  if (Array.isArray(tree?.entries)) tree.entries.length = 0;
                  treePack.fill(0);
                }
                snapshotProcessed++;
                onProgress?.({
                  processed: snapshotProcessed,
                  total: page.total,
                  snapshots: restored,
                  already_indexed: alreadyIndexed,
                  skipped,
                  message: `Restoring version ${snapshotProcessed} of ${page.total} in private backup ${privateBackupNumber}`,
                });
              } finally {
                record.data.fill(0);
              }
            }
            if (page.next_after == null) {
              const verifyAfter = page.names.at(-1) ?? after;
              const verification = await fetchRecordNames(
                PSNAPSHOTS_KIND,
                found.scope,
                verifyAfter,
                signal,
                expectedVersion,
                expectedTotal,
              );
              validateRecordNamesPage(verification, {
                scope: found.scope,
                after: verifyAfter,
                processed: snapshotProcessed,
                expectedTotal,
                expectedVersion,
              });
              if (verification.names.length !== 0) {
                throw new Error("The private backup list changed or returned an incomplete page. Try again.");
              }
              break;
            }
            after = page.next_after;
          }
        } finally {
          found.sealSecret.fill(0);
          found.dedupKey.fill(0);
        }
      }
      for (const record of scopeRecords) record.data.fill(0);
      for (const found of scopes) {
        found.sealSecret.fill(0);
        found.dedupKey.fill(0);
      }
      scopes = [];
      scopeRecords = [];
      scopeProcessed += scopePage.scanned;
      if (scopePage.next_after == null) break;
      onProgress?.({
        processed: 0,
        total: 0,
        snapshots: restored,
        already_indexed: alreadyIndexed,
        skipped,
        message: "Finding your private backups",
      });
      scopeAfter = scopePage.next_after;
    }

    if (discoveredScopes === 0) throw new Error(NOT_FOUND_MESSAGE);
    return { restored };
  } finally {
    entropy.fill(0);
    for (const record of scopeRecords) record.data.fill(0);
    for (const found of scopes) {
      found.sealSecret.fill(0);
      found.dedupKey.fill(0);
    }
  }
}
