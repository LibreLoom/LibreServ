// Settings and setup extras: access tokens, Luna Connect device token, cloud
// identity and recovery phrase.
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

// ── Luna Connect device token ───────────────────────────────────────────────
post("/api/v1/connect/device-token", ({ world, user, body }) => {
  if (world.users.length > 0 && !isAdmin(user)) return fail(403, "Only an Admin can enter a device token.");
  const token = String(body.token || body.code || "");
  if (!token) return fail(400, "Paste the device token first.");
  if (token === "bad") return fail(401, DEVICE_TOKEN_REJECTED);
  const { device_token_error: _gone, ...rest } = world.connect;
  // The fake Connect account already has a payment card, so cloud backup works right away.
  world.connect = { backup_unlocked: true, ...rest, enabled: true, connect_active: true };
  world.connectActive = true;
  return {};
});
del("/api/v1/connect/device-token", ({ world, user }) => {
  requireAdmin(user, "Only an Admin can remove the device token.");
  world.connect = { ...world.connect, enabled: false, connect_active: false };
  world.connectActive = false;
  return {};
});

// The reset flow's unbind step (api/connect.rs unbind). `world.unbindFails`
// makes Connect not answer, for the Retry / Skip state.
post("/api/v1/connect/unbind", ({ world, user, body }) => {
  requireAdmin(user, "Only an Admin can unbind Luna Connect.");
  if (!String(body.password ?? "").trim()) return fail(400, "Type your current password to unbind Luna Connect.");
  if (body.password === "wrong") return fail(401, "That password is wrong. Luna Connect was not unbound.");
  if (!world.connect.device_code && !world.connect.enabled) return fail(400, "This Luna has no device token, so it isn't linked to Luna Connect.");
  if (world.unbindFails) return fail(504, "Luna Connect didn't answer, or had a problem. Check this Luna's internet connection, then try again.");
  world.connect = { ...world.connect, paired: false, hostname: null, domain: null, subdomain: null, tunnel_active: false };
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
  // the very first save has nothing to move. Record when the move started so the
  // status handler can end it after a bounded time instead of showing it forever.
  const replacing = Boolean(world.phrase?.set);
  const previous = world.phrase || {};
  const { resealing: _oldResealing, reseal_started_at: _oldStarted, ...rest } = previous;
  world.phrase = {
    ...rest,
    set: true,
    set_at: nowSec(),
    phrase_words: body?.words || 0,
    last_checked_at: 0,
    ...(replacing ? { resealing: true, reseal_started_at: nowSec() } : {}),
  };
  return { set: true, set_at: world.phrase.set_at, rescope_failed: 0 };
});
