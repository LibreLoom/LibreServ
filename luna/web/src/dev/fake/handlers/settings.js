// Settings and setup extras: access tokens, Luna Connect device token, cloud
// identity and restore, private-folder cleanup.
import { del, fail, get, post, put } from "../engine.js";
import { nextId } from "../world.js";
import { SIG_PUBLIC_LEN } from "@libreloom/ui/lib/cloud/backupCrypto.js";

const nowSec = () => Math.floor(Date.now() / 1000);
const b64 = (n) => btoa(String.fromCharCode(...new Uint8Array(n).fill(7)));

// ── Access tokens ───────────────────────────────────────────────────────────
get("/api/v1/device-tokens", ({ world }) => world.tokens);
post("/api/v1/device-tokens", ({ world, body }) => {
  const name = String(body.name || "").trim();
  if (!name) return fail(400, "Give the token a name.");
  if (world.tokens.some((t) => t.name === name)) return fail(409, "You already have a token with that name.");
  const created = {
    id: nextId("t"),
    name,
    created_at: nowSec(),
    last_used_at: null,
    expires_at: body.expires_in_days ? nowSec() + Number(body.expires_in_days) * 86400 : null,
  };
  world.tokens.push(created);
  world.tokenUsage ??= {};
  world.tokenUsage[created.id] = [];
  return { ...created, token: `lt_${"ab12".repeat(10)}` };
});
get("/api/v1/device-tokens/:id/usage", ({ world, params }) => world.tokenUsage?.[params.id] ?? []);
del("/api/v1/device-tokens/:id", ({ world, params }) => {
  if (!world.tokens.some((t) => t.id === params.id)) return fail(404, "That token is already gone.");
  world.tokens = world.tokens.filter((t) => t.id !== params.id);
  return {};
});

// ── Luna Connect device token ───────────────────────────────────────────────
post("/api/v1/connect/device-token", ({ world, body }) => {
  const token = String(body.token || "");
  if (!token) return fail(400, "Paste the device token first.");
  if (token === "bad") return fail(400, "Connect didn't accept that device token.");
  world.connect = { ...world.connect, enabled: true, connect_active: true, device_token_error: "" };
  world.connectActive = true;
  return {};
});
del("/api/v1/connect/device-token", ({ world }) => {
  world.connect = { ...world.connect, enabled: false, connect_active: false };
  world.connectActive = false;
  return {};
});

// ── Tailscale remote access ──────────────────────────────────────────────────
get("/api/v1/tailscale/status", ({ world, user }) => user?.role === "admin"
  ? (world.tailscale || { installed: true, enabled: false, state: "off" })
  : fail(403, "Only an Admin can change remote access."));
post("/api/v1/tailscale/connect", ({ world, user }) => {
  if (user?.role !== "admin") return fail(403, "Only an Admin can change remote access.");
  world.tailscale = { installed: true, enabled: true, state: "pending", identity_saved: true, auth_url: "https://login.tailscale.com/a/demo" };
  return world.tailscale;
});
post("/api/v1/tailscale/reconnect", ({ world, user }) => {
  if (user?.role !== "admin") return fail(403, "Only an Admin can change remote access.");
  world.tailscale = { ...world.tailscale, installed: true, enabled: true, state: "pending", error: "", auth_url: "https://login.tailscale.com/a/demo" };
  return world.tailscale;
});
post("/api/v1/tailscale/serve", ({ world, body, user }) => {
  if (user?.role !== "admin") return fail(403, "Only an Admin can change remote access.");
  if (!world.tailscale?.enabled || world.tailscale.state !== "connected") return fail(409, "Connect Tailscale first.");
  if (body.public && !body.confirm_public) return fail(400, "Confirm public access before turning it on.");
  world.tailscale = { ...world.tailscale, state: "connected", private_url: "https://luna.tail-demo.ts.net", public_url: body.public ? "https://luna.tail-demo.ts.net" : undefined, approval_url: undefined };
  return world.tailscale;
});
post("/api/v1/tailscale/stop-serve", ({ world, user }) => {
  if (user?.role !== "admin") return fail(403, "Only an Admin can change remote access.");
  world.tailscale = { ...world.tailscale, private_url: "", public_url: "", approval_url: "", approval_type: "" };
  return world.tailscale;
});
post("/api/v1/tailscale/disable", ({ world, user }) => {
  if (user?.role !== "admin") return fail(403, "Only an Admin can change remote access.");
  world.tailscale = { installed: true, enabled: false, identity_saved: true, state: "off" };
  return world.tailscale;
});
post("/api/v1/tailscale/forget", ({ world, user }) => {
  if (user?.role !== "admin") return fail(403, "Only an Admin can change remote access.");
  world.tailscale = { installed: true, enabled: false, identity_saved: false, state: "off" };
  return world.tailscale;
});

// ── Cloud identity, recovery phrase, restore ────────────────────────────────
post("/api/v1/cloud/identity", ({ world }) => {
  world.phrase.luna_id ||= "luna-1";
  world.phrase.signing_public ||= b64(SIG_PUBLIC_LEN);
  return { luna_id: world.phrase.luna_id, signing_public: world.phrase.signing_public };
});
post("/api/v1/cloud/phrase/challenge", () => ({ challenge: b64(32) }));
post("/api/v1/cloud/phrase/check", ({ world }) => {
  if (world.phraseWrong) return fail(403, "That recovery phrase doesn't match this Luna.");
  world.phrase.check_due = false;
  world.phrase.last_checked_at = nowSec();
  return { ok: true };
});
put("/api/v1/cloud/phrase", ({ world }) => {
  world.phrase = { ...world.phrase, set: true, set_at: nowSec() };
  return { set: true, set_at: world.phrase.set_at };
});

const restoreStatus = (world) => world.restore ?? { needed: false, luna_id: "luna-1", signing_public: b64(SIG_PUBLIC_LEN), cloud_snapshots: 0, indexed_snapshots: 0 };
get("/api/v1/cloud/restore", ({ world }) => restoreStatus(world));
// No signed records on file: any phrase fails with "no backups open with these words".
get("/api/v1/cloud/restore/records/:kind", () => ({ records: [] }));
post("/api/v1/cloud/restore", ({ world }) => {
  const r = restoreStatus(world);
  world.restore = { ...r, needed: false, indexed_snapshots: r.cloud_snapshots };
  return { snapshots: r.cloud_snapshots, already_indexed: 0, skipped: 0 };
});
get("/api/v1/cloud/restore-private", ({ world }) => world.restorePrivate ?? { needed: false, luna_id: "luna-1", signing_public: b64(SIG_PUBLIC_LEN), scopes: 0 });
get("/api/v1/cloud/restore-private/records/:kind", () => ({ records: [] }));
post("/api/v1/cloud/restore-private", () => ({ restored: 0 }));

// ── Private folders left behind ─────────────────────────────────────────────
get("/api/v1/private/orphans", ({ world }) => world.orphans ?? { owners: [], offline_drives: [] });
del("/api/v1/private/orphans/:owner", ({ world, params }) => {
  const o = world.orphans;
  if (o) o.owners = o.owners.filter((x) => x.user_id !== params.owner);
  return { skipped_readonly: [], failed_drives: [], offline_drives: [] };
});
get("/api/v1/private/ownerless", ({ world }) => ({ count: world.ownerless ?? 0 }));
