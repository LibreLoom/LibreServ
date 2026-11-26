import { derive, phraseToEntropy } from "@libreloom/ui/lib/cloud/backupCrypto.js";
import { findMyKeys, NO_BACKUPS } from "@libreloom/ui/lib/cloud/cloudKeys.js";
import { decryptMeta, readTree, readTreeWith, verifySnapshot } from "@libreloom/ui/lib/cloud/cloudFormat.js";
import { openPrivateTreeBytes, PSCOPES_KIND, privateNamespace, privateUnwrap } from "@libreloom/ui/lib/cloud/cloudPrivate.js";
import { unlockPrivate } from "./privateUnlock.js";

/** @typedef {import("./privateUnlock.js").PrivateKeys} PrivateKeys */
/** @typedef {{ snapshotId: string, createdAt: number, keyVersion: number, treePackId: string, treeHash: Uint8Array, meta: Uint8Array }} CloudVersion */
/** @typedef {{ protectionId: string, name: string, sourcePath: string, startedBy: string, startedByName: string, versions: CloudVersion[], keys: Record<number, { key: Uint8Array, dedupKey: Uint8Array }>, private?: PrivateKeys }} CloudBackup */

/**
 * Open everything the phrase can open on this source: shared backups, then private backups.
 * @param {import("./cloudSource.js").CloudSource} source
 * @param {string} words  12 or 24 words as typed
 * @param {{ requireLatest?: boolean }} [opts] requireLatest (share links): keep a shared backup only if the phrase opens its newest key version
 * @returns {Promise<{ userIds: string[], backups: CloudBackup[] }>} private backups are every one this phrase opens, together
 */
export async function unlockBackups(source, words, opts = {}) {
  const entropy = phraseToEntropy(words);
  try {
    // The namespace is derived here from the phrase; Connect only ever sees this one namespace.
    const mineKeys = derive(entropy, source.lunaId);
    const namespace = privateNamespace(mineKeys.authPublic);
    mineKeys.sealSecret.fill(0);
    mineKeys.selfKey.fill(0);
    mineKeys.authSecret.fill(0);
    const [self, recipients, keys, snapshots, pscopes] = await Promise.all(
      ["self", "recipients", "keys", "snapshots", PSCOPES_KIND].map((kind) =>
        source.listRecords(kind, kind === PSCOPES_KIND ? namespace : undefined),
      ),
    );
    const mine = findMyKeys({ lunaId: source.lunaId, entropy, self, recipients, keys, pscopes });

    /** @type {Map<string, { key: Uint8Array, dedupKey: Uint8Array }>} */
    const keyFor = new Map();
    for (const k of mine.keys) keyFor.set(`${k.protectionId}:${k.version}`, k);

    /** @type {Map<string, { versions: CloudVersion[], metas: Map<string, { name: string, sourcePath: string, startedBy: string, startedByName: string }> }>} */
    const byProtection = new Map();
    for (const rec of snapshots) {
      const view = verifySnapshot(rec.data, mine.signingPublics, source.lunaId);
      if (!view) continue;
      const pair = keyFor.get(`${view.protectionId}:${view.keyVersion}`);
      if (!pair) continue;
      let meta;
      try {
        meta = decryptMeta(view.meta, pair.key);
      } catch {
        continue;
      }
      let group = byProtection.get(view.protectionId);
      if (!group) {
        group = { versions: [], metas: new Map() };
        byProtection.set(view.protectionId, group);
      }
      group.versions.push({
        snapshotId: view.snapshotId,
        createdAt: view.createdAt,
        keyVersion: view.keyVersion,
        treePackId: view.treePackId,
        treeHash: view.treeHash,
        meta: view.meta,
      });
      group.metas.set(view.snapshotId, meta);
    }

    /** @type {CloudBackup[]} */
    let shared = [];
    for (const [protectionId, group] of byProtection) {
      group.versions.sort((a, b) => b.createdAt - a.createdAt);
      const newest = group.metas.get(group.versions[0].snapshotId);
      if (!newest) continue;
      /** @type {Record<number, { key: Uint8Array, dedupKey: Uint8Array }>} */
      const keysByVersion = {};
      for (const k of mine.keys) {
        if (k.protectionId === protectionId) keysByVersion[k.version] = { key: k.key, dedupKey: k.dedupKey };
      }
      shared.push({
        protectionId,
        name: newest.name,
        sourcePath: newest.sourcePath,
        startedBy: newest.startedBy,
        startedByName: newest.startedByName,
        versions: group.versions,
        keys: keysByVersion,
      });
    }

    if (opts.requireLatest) {
      shared = shared.filter((b) => {
        const latest = mine.latestVersion[b.protectionId];
        return latest !== undefined && keyFor.has(`${b.protectionId}:${latest}`);
      });
    }

    const privateBackups = await unlockPrivate(source, entropy, source.lunaId, mine.privateScopes, mine.signingPublics);

    const backups = [...shared, ...privateBackups];
    if (backups.length === 0) throw new Error(NO_BACKUPS);
    backups.sort((a, b) => a.name.localeCompare(b.name));
    return { userIds: mine.userIds, backups };
  } finally {
    entropy.fill(0);
  }
}

/**
 * Group the shared backups by who started them: [{ startedBy, name, backups }], name = startedByName of the newest backup, or "Someone no longer on this Luna" when empty. Sorted by name.
 * Private backups are left out: they are shown together in one Private backups area, never per person.
 * @param {CloudBackup[]} backups
 */
export function groupByStarter(backups) {
  /** @type {Map<string, CloudBackup[]>} */
  const byStarter = new Map();
  for (const backup of backups) {
    if (backup.private) continue;
    const list = byStarter.get(backup.startedBy) || [];
    list.push(backup);
    byStarter.set(backup.startedBy, list);
  }
  const groups = [...byStarter].map(([startedBy, list]) => {
    const newest = list.reduce((a, b) => (b.versions[0].createdAt > a.versions[0].createdAt ? b : a));
    return {
      startedBy,
      name: newest.startedByName || "Someone no longer on this Luna",
      backups: list,
    };
  });
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * File list of one version: fetch its tree pack and read it. Private backups read through their own token source and private keys.
 * @param {import("./cloudSource.js").CloudSource} source
 * @param {CloudBackup} backup
 * @param {CloudVersion} version
 */
export async function loadTree(source, backup, version) {
  if (backup.private) {
    const { sealSecret, scope, source: privateSource } = backup.private;
    const treePack = await privateSource.getPack(version.treePackId);
    return readTreeWith(
      treePack,
      version,
      privateUnwrap(sealSecret, source.lunaId, scope),
      openPrivateTreeBytes(sealSecret, source.lunaId, scope),
    );
  }
  const treePack = await source.getPack(version.treePackId);
  return readTree(treePack, version, backup.keys[version.keyVersion].key);
}
