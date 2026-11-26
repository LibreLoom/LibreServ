// Settings and setup extras: access tokens, Luna Connect pairing, cloud
// identity and recovery phrase.
import { del, fail, get, post, put } from "../engine.js";
import { isAdmin, requireAdmin } from "../policy.js";
import { nextId } from "../world.js";
import { SIG_PUBLIC_LEN } from "@libreloom/ui/lib/cloud/backupCrypto.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const b64 = (n) => btoa(String.fromCharCode(...new Uint8Array(n).fill(7)));
const CONNECT_STATES = new Set(["unbound", "pairing", "bound", "revoked"]);
const CONNECT_PENDING_ERROR = "Luna is still disconnecting from Luna Connect. Remote access and pairing are stopped until it finishes.";
const normalizeDeviceToken = (value) => String(value || "")
  .trim()
  .replace(/[-_\s]/g, "")
  .toUpperCase()
  .replace(/[IL]/g, "1")
  .replace(/O/g, "0");
const fakeConnectState = (world) => CONNECT_STATES.has(world.connect?.state)
  ? world.connect.state
  : world.connect?.paired ? "bound" : "unbound";

// ── Access tokens (api/device_tokens.rs): each person sees their own ────────
const tokenJson = (t) => ({ id: t.id, name: t.name, created_at: t.created_at, last_used_at: t.last_used_at ?? 0, expires_at: t.expires_at ?? null, revoked: Boolean(t.revoked) });
const mineOf = (world, user) => world.tokens.filter((t) => (t.user_id ?? "u1") === user.id);
get("/api/v1/device-tokens", ({ world, user }) => mineOf(world, user).map(tokenJson));
post("/api/v1/device-tokens", ({ world, user, body }) => {
  const name = String(body.name || "").trim();
  if (!name || name.length > 80) return fail(400, "Give this access token a name between 1 and 80 characters.");
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
  return (world.tokenUsage?.[params.id] ?? []).map((u) => ({ client: "", origin: "", ...u }));
});
del("/api/v1/device-tokens/:id", ({ world, user, params }) => {
  if (!mineOf(world, user).some((t) => t.id === params.id)) return fail(404, "Luna doesn't know this access token.");
  world.tokens = world.tokens.filter((t) => t.id !== params.id);
  return { ok: true };
});

// ── Luna Connect device token (local file only; never sent to Connect) ─────
get("/api/v1/connect/device-token", ({ world, user }) => {
  requireAdmin(user, "Only an Admin can see the device token.");
  return { device_token_set: Boolean(world.connect.device_token) };
});
put("/api/v1/connect/device-token", ({ world, user, body }) => {
  if (world.users.length > 0 && !isAdmin(user)) return fail(403, "Only an Admin can change the device token.");
  const token = normalizeDeviceToken(body.device_token);
  if (!/^[0-9A-HJKMNP-TV-Z]{20}$/.test(token)) return fail(400, "Enter the 20-character device token.");
  // Local-only: the Connect binding, remote access and backups do not change.
  world.connect = { ...world.connect, device_token: token };
  return { ok: true };
});

// Disconnect cancels pairing, revokes a bound Luna, or clears a revoked
// account link after password step-up. A revoked failure stays revoked rather
// than pretending there is an ordinary pending revocation to retry.
post("/api/v1/connect/unbind", ({ world, user, body }) => {
  requireAdmin(user, "Only an Admin can disconnect Luna Connect.");
  if (!String(body.password ?? "").trim()) return fail(400, "Type your current password to disconnect Luna Connect.");
  if (body.password === "wrong") return fail(401, "That password is wrong. Luna Connect was not disconnected.");
  const state = fakeConnectState(world);
  if (state === "unbound" && !world.connect.unbind_pending) return fail(400, "This Luna is not paired with Luna Connect.");
  if (world.unbindFails) {
    world.connect = {
      ...world.connect,
      state,
      paired: false,
      unbind_pending: state !== "revoked",
      tunnel_active: false,
      backup_unlocked: false,
      backup_sources: [],
    };
    world.connectActive = false;
    return fail(504, "Luna Connect didn't answer, or had a problem. Check this Luna's internet connection, then try again.");
  }
  world.connect = {
    ...world.connect,
    state: "unbound",
    revoked: false,
    account_id: null,
    pairing_id: null,
    paired: false,
    unbind_pending: false,
    hostname: null,
    domain: null,
    subdomain: null,
    tunnel_active: false,
    backup_unlocked: false,
    backup_sources: [],
    connect_error: null,
  };
  world.connectActive = false;
  return { ok: true };
});

// ── Cloud identity and recovery phrase ─────────────────────────────────────
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
// No private scopes in Photos, so nothing to re-seal and nothing that fails to re-seal.
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
