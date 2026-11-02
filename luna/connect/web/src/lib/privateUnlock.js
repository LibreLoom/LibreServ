import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { derive } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { PSNAPSHOTS_KIND, readPrivateSnapshots, signPrivateOpen } from "@libreloom/ui/lib/cloud/cloudPrivate.js";

/** @typedef {import("./cloudSource.js").CloudSource} CloudSource */
/** @typedef {{ scope: string, sealSecret: Uint8Array, dedupKey: Uint8Array, source: CloudSource }} PrivateKeys */
/** sealSecret in PrivateKeys is the scope's own secret key; the phrase's key only opens the scope. */

const OPEN_FAILED = "Could not open your private items. Try again.";

/**
 * Open one private scope: challenge, sign it with the owner's auth key, open a session, then read its snapshots.
 * A 403 keeps the server's sentence; any other session failure gets OPEN_FAILED.
 * @param {CloudSource} source
 * @param {Uint8Array} entropy the recovery phrase's entropy
 * @param {string} lunaId
 * @param {{ scope: string, dedupKey: Uint8Array, sealSecret: Uint8Array }} scopeInfo one entry of mine.privateScopes (sealSecret is the scope's key)
 * @param {Uint8Array[]} signingPublics
 * @returns {Promise<Array<import("./cloudUnlock.js").CloudBackup & { private: PrivateKeys }>>} one backup per protection, newest first
 */
export async function openPrivateScope(source, entropy, lunaId, scopeInfo, signingPublics) {
  const { scope, dedupKey, sealSecret } = scopeInfo;
  const k = derive(entropy, lunaId);
  let tokenSource;
  try {
    const challenge = await source.privateChallenge();
    const signature = signPrivateOpen(k.authSecret, lunaId, scope, hexToBytes(challenge));
    const { token } = await source.privateOpen({
      scope,
      challenge,
      signature: bytesToHex(signature),
    });
    tokenSource = source.withPrivateToken(token);
  } catch (err) {
    if (/** @type {{ status?: number }} */ (err).status === 403) throw err;
    throw new Error(OPEN_FAILED);
  }

  const psnapshots = await tokenSource.listRecords(PSNAPSHOTS_KIND);
  const snaps = readPrivateSnapshots({ lunaId, sealSecret, scope, psnapshots, signingPublics });

  /** @type {Map<string, Array<any>>} */
  const byProtection = new Map();
  for (const snap of snaps) {
    const list = byProtection.get(snap.protectionId) || [];
    list.push(snap);
    byProtection.set(snap.protectionId, list);
  }

  const privateKeys = { scope, sealSecret, dedupKey, source: tokenSource };
  const backups = [];
  for (const [protectionId, list] of byProtection) {
    const newest = list[0];
    backups.push({
      protectionId,
      name: newest.meta.name,
      sourcePath: newest.meta.sourcePath,
      startedBy: newest.meta.startedBy,
      startedByName: newest.meta.startedByName,
      versions: list.map((snap) => ({
        snapshotId: snap.snapshotId,
        createdAt: snap.createdAt,
        keyVersion: 0,
        treePackId: snap.treePackId,
        treeHash: snap.treeHash,
        meta: snap.sealedMeta,
      })),
      keys: {},
      private: privateKeys,
    });
  }
  return backups;
}

/**
 * Open every private scope this phrase owns on one Luna.
 * @param {CloudSource} source
 * @param {Uint8Array} entropy
 * @param {string} lunaId
 * @param {Array<{ scope: string, dedupKey: Uint8Array, sealSecret: Uint8Array }>} privateScopes
 * @param {Uint8Array[]} signingPublics
 * @returns {Promise<Array<import("./cloudUnlock.js").CloudBackup & { private: PrivateKeys }>>}
 */
export async function unlockPrivate(source, entropy, lunaId, privateScopes, signingPublics) {
  const out = [];
  for (const scopeInfo of privateScopes) {
    out.push(...(await openPrivateScope(source, entropy, lunaId, scopeInfo, signingPublics)));
  }
  return out;
}
