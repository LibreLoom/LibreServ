// Settings and setup extras: access tokens, Luna Connect device token, cloud
// identity and restore, private-folder cleanup.
import { del, fail, get, post, put } from "../engine.js";
import { isAdmin, requireAdmin } from "../policy.js";
import { DEVICE_TOKEN_REJECTED } from "./core.js";
import { nextId } from "../world.js";
import { SIG_PUBLIC_LEN } from "@libreloom/ui/lib/cloud/backupCrypto.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const b64 = (n) => btoa(String.fromCharCode(...new Uint8Array(n).fill(7)));

// ── Access tokens (api/device_tokens.rs): each person sees their own ────────
const tokenJson = (t) => ({ id: t.id, name: t.name, created_at: t.created_at, last_used_at: t.last_used_at ?? 0, expires_at: t.expires_at ?? null, revoked: Boolean(t.revoked) });
const mineOf = (world, user) => world.tokens.filter((t) => (t.user_id ?? "u1") === user.id);
get("/api/v1/device-tokens", ({ world, user }) => mineOf(world, user).map(tokenJson));
post("/api/v1/device-tokens", ({ world, user, body }) => {
  const name = String(body.name || "").trim();
  if (!name || name.length > 80) return fail(400, "Give this device a name between 1 and 80 characters.");
  const created = {
    id: nextId("t"),
    user_id: user.id,
    name,
    created_at: nowSec(),
    last_used_at: 0,
    expires_at: body.expires_in_days ? nowSec() + Number(body.expires_in_days) * 86400 : null,
  };
  world.tokens.push(created);
  world.tokenUsage ??= {};
  world.tokenUsage[created.id] = [];
  return { ...tokenJson(created), token: `lt_${"ab12".repeat(10)}` };
});
get("/api/v1/device-tokens/:id/usage", ({ world, user, params }) => {
  if (!mineOf(world, user).some((t) => t.id === params.id)) return fail(404, "Luna doesn't know this access token.");
  return world.tokenUsage?.[params.id] ?? [];
});
del("/api/v1/device-tokens/:id", ({ world, user, params }) => {
  if (!mineOf(world, user).some((t) => t.id === params.id)) return fail(404, "Luna doesn't know this access token.");
  world.tokens = world.tokens.filter((t) => t.id !== params.id);
  return { ok: true };
});

// ── Luna Connect device token ───────────────────────────────────────────────
post("/api/v1/connect/device-token", ({ world, user, body }) => {
  if (world.users.length > 0 && !isAdmin(user)) return fail(403, "Only an Admin can enter a device token.");
  const token = String(body.token || body.code || "");
  if (!token) return fail(400, "Paste the device token first.");
  if (token === "bad") return fail(401, DEVICE_TOKEN_REJECTED);
  const { device_token_error: _gone, ...rest } = world.connect;
  world.connect = { ...rest, enabled: true, connect_active: true };
  world.connectActive = true;
  return {};
});
del("/api/v1/connect/device-token", ({ world, user }) => {
  requireAdmin(user, "Only an Admin can change remote access.");
  world.connect = { ...world.connect, enabled: false, connect_active: false };
  world.connectActive = false;
  return {};
});

// ── Cloud identity, recovery phrase, restore ────────────────────────────────
post("/api/v1/cloud/identity", ({ world }) => {
  world.phrase.luna_id ||= "luna-1";
  world.phrase.signing_public ||= b64(SIG_PUBLIC_LEN);
  return { luna_id: world.phrase.luna_id, signing_public: world.phrase.signing_public };
});
post("/api/v1/cloud/phrase/challenge", () => ({ challenge: b64(32) }));
post("/api/v1/cloud/phrase/check", ({ world }) => {
  if (world.phraseWrong) return fail(403, "That doesn't match the recovery phrase set for your account.");
  world.phrase.check_due = false;
  world.phrase.last_checked_at = nowSec();
  return { ok: true };
});
// No private scopes in the gallery, so nothing to re-seal and nothing that fails to re-seal.
get("/api/v1/cloud/phrase/scopes", () => ({ scopes: [] }));
put("/api/v1/cloud/phrase", ({ world, body }) => {
  if (world.passwordWrong && body?.proof === "password") {
    world.passwordWrong = false; // refused once, so the next try can go through
    return fail(403, "That is not your Luna password");
  }
  if (body?.words !== undefined && body.words !== null && body.words !== 12 && body.words !== 24) return fail(400, "A recovery phrase has 12 or 24 words.");
  // A replacement leaves Luna moving the cloud backups to the new phrase in the background;
  // the very first save has nothing to move.
  const replacing = Boolean(world.phrase?.set);
  world.phrase = { ...world.phrase, set: true, set_at: nowSec(), phrase_words: body?.words || 0, last_checked_at: 0, ...(replacing ? { resealing: true } : {}) };
  return { set: true, set_at: world.phrase.set_at, rescope_failed: 0 };
});

const restoreStatus = (world) => world.restore ?? { needed: false, luna_id: "luna-1", signing_public: b64(SIG_PUBLIC_LEN), cloud_snapshots: 0, indexed_snapshots: 0 };
get("/api/v1/cloud/restore", ({ world }) => restoreStatus(world));
// No signed records on file: any phrase fails with "no backups open with these words".
get("/api/v1/cloud/restore/records/:kind", ({ user }) => { restoreGate(user); return { records: [] }; });
const restoreGate = (user) => requireAdmin(user, "Only an Admin can bring back cloud backups.");
post("/api/v1/cloud/restore", ({ world, user }) => {
  restoreGate(user);
  const r = restoreStatus(world);
  world.restore = { ...r, needed: false, indexed_snapshots: r.cloud_snapshots };
  return { snapshots: r.cloud_snapshots, already_indexed: 0, skipped: 0 };
});
get("/api/v1/cloud/restore-private", ({ world }) => world.restorePrivate ?? { needed: false, luna_id: "luna-1", signing_public: b64(SIG_PUBLIC_LEN), scopes: 0 });
get("/api/v1/cloud/restore-private/records/:kind", () => ({ records: [] }));
post("/api/v1/cloud/restore-private", ({ user }) => { restoreGate(user); return { restored: 0 }; });
