// Sharing: people and links on files, folders, drives and albums; the Shared page;
// the public /s/:token pages; and Luna Forms answers.
//
// One list drives it all — world.sharing.subjects. Each subject is something that is
// shared (or about to be) and holds its own people and links, so adding a person,
// minting a link or revoking one shows up everywhere (share sheet, Shared page,
// /me/access, public page) and sticks until the page reloads.
//
//   world.sharing = {
//     subjects: [{ kind, drive_id, drive_label, path, album_id, name, is_file, owner_id,
//                  my_caps, private, members: [{id,user_id,caps}], links: [link] }],
//     withMe:   [extra "shared with you" rows that have no subject behind them],
//     failAdd, failLink,      // make adding a person / making a link fail
//     tree:     { [token]: entries for a folder link },
//   }
//   link = { id, token, caps, password, has_password, expires_at,
//            downloads, form, kind }
import { del, fail, get, json, patch, post, put, raw } from "../engine.js";
import { nextId } from "../world.js";
import { photoKey } from "../photos.js";
import { bytesFor, needDrive } from "./files.js";
import { privateBoundary, pathContains } from "../policy.js";
import { driveRow, driveUsable, fsOf } from "../fsmodel.js";

const sharing = (w) => {
  if (!w.sharing) w.sharing = { subjects: [], withMe: [] };
  return w.sharing;
};
const nowSec = () => Math.floor(Date.now() / 1000);
const userName = (w, id) => w.users.find((u) => u.id === id)?.display_name || "Someone";
const driveLabel = (w, id) => w.drives.find((d) => d.id === id)?.label || id;

const pathName = (p) => String(p || "").split("/").filter(Boolean).pop() || "";
const sameSubject = (s, q) =>
  s.kind === (q.kind === "album" ? "album" : "path") &&
  s.drive_id === q.drive_id &&
  (s.path || "") === (q.path || "") &&
  (s.album_id || "") === (q.album_id || "");

/** Finds the subject, or invents an empty one so any item can be opened in the share sheet. */
function subjectFor(w, user, q) {
  const s = sharing(w);
  const found = s.subjects.find((x) => sameSubject(x, q));
  if (found) return found;
  const isAlbum = q.kind === "album";
  const album = isAlbum ? w.albums.find((a) => a.id === q.album_id) : null;
  if (isAlbum && !album) return null;
  const created = {
    kind: isAlbum ? "album" : "path",
    drive_id: q.drive_id,
    drive_label: driveLabel(w, q.drive_id),
    path: q.path || "",
    album_id: q.album_id || "",
    name: isAlbum ? album.name : pathName(q.path) || driveLabel(w, q.drive_id),
    is_file: /\.[A-Za-z0-9]{1,5}$/.test(q.path || ""),
    owner_id: user.id,
    my_caps: "full+share",
    private: false,
    members: [],
    links: [],
    pristine: true,
  };
  s.subjects.push(created);
  return created;
}

const memberRow = (w, s, m, me) => ({
  id: m.id,
  user_id: m.user_id,
  name: userName(w, m.user_id),
  caps: m.caps,
  effective_caps: m.effective_caps || m.caps,
  created_by: m.created_by ?? s.owner_id,
  shared_by: userName(w, m.created_by || s.owner_id),
  can_manage: s.my_caps.includes("share"),
  can_remove: s.my_caps.includes("share") || m.user_id === me.id,
});
const linkRow = (s, l) => ({
  id: l.id,
  caps: l.caps,
  has_password: Boolean(l.password),
  created_at: l.created_at ?? 0,
  created_by: s.owner_id,
  expires_at: l.expires_at ?? null,
  url: `/s/${l.token}`,
  can_manage: s.my_caps.includes("share"),
});

get("/api/v1/access/subject", ({ world, user, query }) => {
  const s = subjectFor(world, user, query);
  if (!s) return fail(404, "That album no longer exists.");
  if (s.hidden) return fail(403, "You don't have access to share this.");
  return {
    subject: { kind: s.kind, name: s.name, path: s.path, is_file: s.is_file, private: s.private, private_folder: Boolean(s.private_folder), album_id: s.album_id, drive_id: s.drive_id, exists: s.exists !== false, item_count: s.kind === "album" ? (world.albumItems?.[s.album_id] || []).length : (s.is_file ? 1 : 0), owner: s.owner_id },
    my_caps: s.my_caps,
    private: s.private,
    link_count: s.links.length,
    member_count: s.members.length,
    members: s.members.map((m) => memberRow(world, s, m, user)),
    links: s.links.map((l) => linkRow(s, l)),
    inherited_members: s.inherited_members || [],
    inherited_links: s.inherited_links || [],
  };
});

post("/api/v1/access/members", ({ world, user, body }) => {
  const sh = sharing(world);
  if (sh.failAdd) return fail(500, "Luna couldn't add that person.");
  const s = subjectFor(world, user, body);
  if (!s) return fail(404, "That album no longer exists.");
  if (!s.my_caps.includes("share")) return fail(403, "You can't share this.");
  if (!world.users.some((u) => u.id === body.user_id)) return fail(404, "That person no longer has an account.");
  if (s.members.some((m) => m.user_id === body.user_id)) return fail(409, "That person already has access.");
  const m = { id: nextId("m"), user_id: body.user_id, caps: body.caps || "view" };
  s.members.push(m);
  delete s.pristine;
  if (s.kind === "album") {
    const album = world.albums.find((a) => a.id === s.album_id);
    if (album) album.shared_with = [...(album.shared_with || []), body.user_id];
  }
  return memberRow(world, s, m, user);
});

function findMember(w, id) {
  for (const s of sharing(w).subjects) {
    const m = s.members.find((x) => x.id === id);
    if (m) return { s, m };
  }
  return null;
}
patch("/api/v1/access/members/:id", ({ world, params, body }) => {
  const hit = findMember(world, params.id);
  if (!hit) return fail(404, "That person's access is already gone.");
  hit.m.caps = body.caps;
  return {};
});
del("/api/v1/access/members/:id", ({ world, params }) => {
  const hit = findMember(world, params.id);
  if (hit) {
    hit.s.members = hit.s.members.filter((x) => x !== hit.m);
    if (hit.s.kind === "album") {
      const album = world.albums.find((a) => a.id === hit.s.album_id);
      if (album) album.shared_with = (album.shared_with || []).filter((u) => u !== hit.m.user_id);
    }
    return {};
  }
  // Leaving a share that only exists as a "shared with you" row.
  const sh = sharing(world);
  if (sh.withMe.some((r) => r.id === params.id)) { sh.withMe = sh.withMe.filter((r) => r.id !== params.id); return {}; }
  return fail(404, "That share is already gone.");
});

post("/api/v1/access/links", ({ world, user, body }) => {
  const sh = sharing(world);
  if (sh.failLink) return fail(500, "Luna couldn't make that link.");
  const s = subjectFor(world, user, body);
  if (!s) return fail(404, "That album no longer exists.");
  if (!s.my_caps.includes("share")) return fail(403, "You can't share this.");
  const l = {
    id: nextId("ln"),
    token: `t${Math.random().toString(36).slice(2, 10)}${nextId("")}`,
    caps: body.caps,
    password: body.password || "",
    expires_at: body.expires_in_days ? nowSec() + body.expires_in_days * 86400 : null,
  };
  s.links.push(l);
  delete s.pristine;
  return { id: l.id, url: `/s/${l.token}`, caps: l.caps };
});

function findLink(w, id) {
  for (const s of sharing(w).subjects) {
    const l = s.links.find((x) => x.id === id);
    if (l) return { s, l };
  }
  return null;
}
patch("/api/v1/access/links/:id", ({ world, params, body }) => {
  const hit = findLink(world, params.id);
  if (!hit) return fail(404, "That link no longer exists.");
  if (body.caps !== undefined) hit.l.caps = body.caps;
  if (body.expires_in_days !== undefined) hit.l.expires_at = body.expires_in_days ? nowSec() + body.expires_in_days * 86400 : null;
  if (body.password !== undefined) {
    hit.l.password = body.password || "";
    // A fresh password is a fresh proof: anything unlocked before it is void.
    proofsOf(world).delete(hit.l.id);
  }
  return {};
});
del("/api/v1/access/links/:id", ({ world, params }) => {
  const hit = findLink(world, params.id);
  if (!hit) return fail(404, "That link is already gone.");
  hit.s.links = hit.s.links.filter((x) => x !== hit.l);
  (sharing(world).revoked ||= []).push(hit.l.token);
  return {};
});

// ── Shared page + "what can I open" ─────────────────────────────────────────
function myRows(w, user) {
  const sh = sharing(w);
  const rows = [];
  for (const s of sh.subjects) {
    for (const m of s.members) {
      if (m.user_id !== user.id) continue;
      rows.push({
        id: m.id,
        kind: s.kind,
        drive_id: s.drive_id,
        drive_label: s.drive_label,
        path: s.path,
        album_id: s.album_id,
        name: s.name,
        is_file: s.is_file,
        caps: m.caps,
        created_by: s.owner_id,
        shared_by: userName(w, s.owner_id),
        exists: s.exists !== false,
      });
    }
  }
  return [...rows, ...sh.withMe.map((r) => ({ created_by: "", ...r }))];
}

get("/api/v1/access/mine", ({ world, user }) => {
  const sh = sharing(world);
  const sharingRows = sh.subjects
    .filter((s) => !s.pristine && (s.owner_id === user.id || user.role === "admin") && (s.members.length || s.links.length || s.keepEmpty))
    .map((s) => ({
      kind: s.kind, drive_id: s.drive_id, drive_label: s.drive_label, path: s.path, album_id: s.album_id,
      name: s.name, is_file: s.is_file, exists: s.exists !== false,
      members: s.members.map((m) => ({ id: m.id, user_id: m.user_id, name: userName(world, m.user_id), caps: m.caps })),
      links: s.links.map((l) => ({ id: l.id, caps: l.caps })),
    }));
  return { sharing: sharingRows, with_me: myRows(world, user) };
});

get("/api/v1/me/access", ({ world, user }) => [
  // Grants made straight on the world apply to the person named in `user_id`, or to any Member when none is named.
  ...(world.access || []).filter((r) => !r.user_id || r.user_id === user.id).map(({ user_id: _who, ...row }) => ({
    id: row.id ?? "", kind: row.kind ?? "path", album_id: row.album_id ?? "", drive_id: row.drive_id ?? "", drive_label: row.drive_label ?? "",
    path: row.path ?? "", name: row.name ?? "", is_file: row.is_file ?? false, caps: row.caps,
    created_by: row.created_by ?? "", shared_by: row.shared_by ?? "", exists: row.exists !== false,
  })),
  // Rows from shares: the full "shared with you" row shape.
  ...myRows(world, user),
]);

// ── Forms (signed-in side) ──────────────────────────────────────────────────
const formsOf = (w) => (w.forms ||= {});
const formKey = (q) => `${q.drive_id}\0${q.path}`;

/**
 * The form a link answers, as the key its attachments are filed under. Rust
 * keeps each form's waiting uploads in that form's own folder, so one form can
 * never name another's file.
 *
 * @param {any} s
 * @returns {string}
 */
const linkFormKey = (s) => formKey({ drive_id: s.drive_id, path: s.path });

/**
 * Bytes already claimed into a form's attachment folder, per form and name.
 *
 * @param {any} world
 * @param {string} key
 * @returns {Record<string, number>}
 */
function sentFor(world, key) {
  const all = (world.formSentBytes ||= {});
  return (all[key] ||= {});
}

/**
 * Question pictures the owner uploaded, per form and name. They live in the
 * same folder as sent attachments, so they count against the same room.
 *
 * @param {any} world
 * @param {string} key
 * @returns {Record<string, number>}
 */
function picturesFor(world, key) {
  const all = (world.formPictures ||= {});
  return (all[key] ||= {});
}

/**
 * `PENDING_DIR` contents for one form, created on first use.
 *
 * @param {any} world
 * @param {string} key
 * @returns {Record<string, { size: number, at: number }>}
 */
function pendingFor(world, key) {
  const all = (world.formPending ||= {});
  return (all[key] ||= {});
}

/** `sweep_pending`: an upload nobody sent an answer for is gone after an hour. */
function sweepPending(waiting) {
  const now = nowSec();
  for (const [name, held] of Object.entries(waiting)) {
    if (now - (held?.at ?? now) > 60 * 60) delete waiting[name];
  }
}

/** The waiting file's size, or 0 when it has expired or is not there. */
const waitingSize = (held) => (held && typeof held === "object" ? Number(held.size) || 0 : 0);
/** `wants_count`: only `1` and `true` ask for the length. */
const wantsCount = (raw) => raw === "1" || raw === "true";
get("/api/v1/forms/responses", ({ world, query }) => {
  const list = formsOf(world)[formKey(query)] || [];
  // `id` is the DELETE's field; a GET always answers the whole list or its
  // length.
  if (wantsCount(query.count)) return { count: list.length };
  return { responses: list };
});
del("/api/v1/forms/responses", ({ world, query }) => {
  const id = String(query.id ?? "").trim();
  // An id is what says which answer to remove, so its absence is the request's
  // own fault, not a missing record.
  if (!id)
    return fail(400, "Luna didn't get which response to delete. Reload the page and try again.");
  const k = formKey(query);
  const list = formsOf(world)[k] || [];
  const gone = list.find((x) => x.id === id);
  if (!gone)
    return fail(404, "That response is already gone. Reload the page to see the latest answers.");
  // The answer's attachments go with it, freeing the room they held.
  const sent = sentFor(world, k);
  for (const value of Object.values(gone.answers || {}))
    if (typeof value === "string" && value in sent) delete sent[value];
  formsOf(world)[k] = list.filter((x) => x.id !== id);
  return { ok: true };
});
get("/api/v1/forms/file", () => json({}));
post("/api/v1/forms/picture", ({ world, user, query, body }) => {
  const source = String(body.source ?? "").replace(/^\/+|\/+$/g, "");
  // The editor has to be able to see the picture; copying is what keeps it on
  // the form when the drive changes.
  if (!memberSees(world, user, query.drive_id || "d1", source))
    return fail(403, "You can't open that picture, so it can't go on the form.");
  const leaf = pathName(source);
  let node = null;
  try {
    node = fsOf(world, query.drive_id || "d1").nodes?.[source] || null;
  } catch {
    node = null;
  }
  // The picture is copied off the drive, so the drive has to have it.
  if (!node) return fail(404, "Luna can't find that picture.");
  const ext = node.kind === "file" ? PICTURE_EXTS[leaf.split(".").pop()?.toLowerCase()] || null : null;
  // A source that isn't a photo of a kind Luna stores is refused before
  // anything is written.
  if (!ext) return fail(400, PICTURE_KIND_MESSAGE);
  if (Number(node.size) > 20 * 1024 * 1024)
    return fail(413, "That picture is over 20 MB. Choose a smaller one.");
  // The copy is written into the form's folder, so it needs the same room.
  const key = formKey(query);
  const sent = sentFor(world, key);
  const held = picturesFor(world, key);
  const waiting = pendingFor(world, key);
  sweepPending(waiting);
  const used =
    Object.values(sent).reduce((a, b) => a + b, 0) +
    Object.values(held).reduce((a, b) => a + b, 0) +
    Object.values(waiting).reduce((a, b) => a + waitingSize(b), 0);
  const size = Number(node.size) || 0;
  if (used + size > 2 * 1024 ** 3)
    return fail(
      507,
      "This form has no room for more files. Ask the person who shared it to clear some out.",
    );
  const name = `${mintHex(16)}.${ext}`;
  held[name] = size;
  return { ok: true, name };
});
post("/api/v1/forms/picture-upload", async ({ world, query, body }) => {
  // Absent part: nothing to attach. Present but unnamed: a kind Luna can't
  // read, which is the message `read_multipart_file` gives it.
  if (!("file" in body)) return fail(400, "Choose a file to attach.");
  const file = body.file && typeof body.file === "object" ? body.file : null;
  const filename = file && typeof file.name === "string" ? file.name : "";
  // A question picture is a photo and nothing else — a PDF is an attachment.
  const ext = PICTURE_EXTS[filename.split(".").pop()?.toLowerCase()] || null;
  if (!ext) return fail(400, PICTURE_KIND_MESSAGE);
  const size = Number(file.size) || 0;
  if (size > 20 * 1024 * 1024)
    return fail(413, "That file is over 20 MB. Choose a smaller one.");
  if (size === 0) return fail(400, "That file was empty. Choose another one and try again.");
  // The name is minted from the bytes, so a renamed page or script must not
  // pass as a photo.
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (!pictureBytes(ext, bytes)) return fail(400, PICTURE_KIND_MESSAGE);
  // A picture sits in the form's own folder, so it needs the same room an
  // attachment would.
  const key = formKey(query);
  const sent = sentFor(world, key);
  const held = picturesFor(world, key);
  const waiting = pendingFor(world, key);
  sweepPending(waiting);
  const used =
    Object.values(sent).reduce((a, b) => a + b, 0) +
    Object.values(held).reduce((a, b) => a + b, 0) +
    Object.values(waiting).reduce((a, b) => a + waitingSize(b), 0);
  if (used + size > 2 * 1024 ** 3)
    return fail(
      507,
      "This form has no room for more files. Ask the person who shared it to clear some out.",
    );
  const name = `${mintHex(16)}.${ext}`;
  held[name] = size;
  return { ok: true, name };
});
put("/api/v1/forms/picture", () => ({}));

// ── Public /s/:token ────────────────────────────────────────────────────────
function lookup(w, token) {
  for (const s of sharing(w).subjects) {
    const l = s.links.find((x) => x.token === token);
    if (l) return { s, l };
  }
  return null;
}
const header = (h, name) => {
  if (!h) return "";
  if (typeof h.get === "function") return h.get(name) || "";
  const k = Object.keys(h).find((x) => x.toLowerCase() === name);
  return k ? String(h[k]) : "";
};

// Per world: link id -> the password that was proved right, standing in for
// lunad's proof cookie. Scoped to the world because the harness installs a new
// one repeatedly in a single runtime, and an unlock must not survive into a
// world that happens to reuse the id. Cleared whenever a password is set, as
// lunad re-salts its hash on every change — so A → B → A does not unlock.
const proofsOf = (w) => {
  if (!w.__proofs) w.__proofs = new Map();
  return w.__proofs;
};

/** Runs every check a real link goes through; returns an error answer or the link. */
function open(w, token, headers) {
  const hit = lookup(w, token);
  // `resolve_public_link` words these two refusals itself: a token nothing
  // matches is "doesn't exist", and an expired link is the same closed-link
  // page a revoked one gets, not a shorter sentence of its own.
  if (!hit) return { err: fail(404, "This link doesn't exist.") };
  const { s, l } = hit;
  if (l.expires_at && l.expires_at < nowSec())
    return { err: fail(410, "This link has expired or been removed.") };
  // lunad's `load_link` gate, which runs for every link before anything else:
  // when the link's own subject sits inside a private item whose owner is
  // deleted, the item stays private rather than becoming readable, so the link
  // closes. `linkReaches` only covers items *below* a link, so a share built on
  // the private item itself has to be refused here or it would stay open.
  if (s.kind === "path" && s.drive_id) {
    try {
      fsOf(w, s.drive_id);
      const own = privateBoundary(w, s.drive_id, String(s.path ?? "").replace(/^\/+|\/+$/g, ""));
      if (own && (w.deletedUsers || []).some((u) => u.id === own.owner)) {
        // lunad answers `gone()` here, not `not found`: the link has closed for
        // good, and the share page says so instead of suggesting a typo.
        return { err: fail(410, "This link has expired or been removed.") };
      }
    } catch {
      // No tree to inspect: leave the link open, as `link_reaches` does.
    }
  }
  // lunad hands back a proof cookie once the password is right, and later
  // requests — including the ones a media element makes, which cannot carry a
  // header — present that instead. Remember the unlock the same way, so a photo
  // behind a password is not refused after the folder next to it opened fine.
  if (l.password) {
    const proofs = proofsOf(w);
    // A proof cookie is checked before the lock, as lunad does: a guest who
    // already unlocked keeps working while someone else is guessing.
    if (proofs.get(l.id) === l.password) return { s, l };
    const tries = failedTries(w);
    const mine = tries.get(l.id);
    const anyone = tries.get(`${l.id}:any`);
    const now = nowSec();
    if ((mine && mine.until > now) || (anyone && anyone.until > now))
      return {
        err: fail(429, "Too many wrong passwords. Wait a few minutes and try again."),
      };
    const given = header(headers, "x-share-password");
    if (given && given === l.password) {
      proofs.set(l.id, l.password);
      // Only this client's budget clears; the link-wide one an attacker is
      // burning through stays spent, as `clear_success` does.
      tries.delete(l.id);
    } else {
      if (given) {
        bumpShareAuth(tries, `${l.id}:any`, 64);
        bumpShareAuth(tries, l.id, 8);
      }
      return { err: fail(401, "This link needs its password.") };
    }
  }
  return { s, l };
}

/**
 * Mirrors lunad's `child_under_link`: a link's relative path must stay lexical
 * and below the link. Leading separators, backslashes and `.`/`..` are refused
 * rather than tidied, because tidying them is how a scope check gets bypassed.
 *
 * @param {string} raw
 * @returns {string[] | null} segments, or null when the path is refused
 */
function linkSegments(raw) {
  const extra = String(raw ?? "").trim();
  if (extra.startsWith("/") || extra.includes("\\")) return null;
  if (!extra) return [];
  // Rust's path components drop an interior `.` (`a/./b` reads as `a/b`) but
  // keep a leading one, so `./a` is still refused. `..` is refused anywhere.
  const segments = extra.split("/").filter(Boolean);
  if (segments[0] === ".") return null;
  if (segments.some((seg) => seg === "..")) return null;
  return segments.filter((seg) => seg !== ".");
}

/** Consecutive wrong share passwords per link, as `ShareAuthGuard` counts them. */
function failedTries(w) {
  if (!w.shareAuthTries) w.shareAuthTries = new Map();
  return w.shareAuthTries;
}

/**
 * `share_auth_failure`: count a wrong guess and start the wait once the count
 * reaches this bucket's ceiling. A bucket that is already waiting is left
 * alone, and the window doubles for each failure past the ceiling.
 *
 * @param {Map<string, { count: number, until: number }>} tries
 * @param {string} key
 * @param {number} max
 */
function bumpShareAuth(tries, key, max) {
  const now = nowSec();
  const bucket = tries.get(key);
  if (bucket && bucket.until > now) return;
  const count = (bucket?.count || 0) + 1;
  const until = count >= max ? now + 60 * 2 ** Math.min(count - max, 10) : 0;
  tries.set(key, { count, until });
}

/**
 * Mirrors lunad's `scoped_child`: a link that does not itself sit in the trash
 * can never reach the trash, and says so before it reads anything. The test is
 * on the *joined* path, so a link rooted elsewhere passes this gate and misses
 * on the read instead.
 *
 * @param {{ path?: string }} s
 * @param {string[]} segments
 */
function trashProbe(s, segments) {
  const own = String(s.path || "").replace(/^\/+|\/+$/g, "");
  const joined = [own, segments.join("/")].filter(Boolean).join("/");
  if (!isTrashApi(joined) && !isTrashRel(joined)) return null;
  if (isTrashApi(own)) return null;
  return fail(404, "That item isn't part of this shared link.");
}

/** `is_trash_api`: the alias the API accepts for the trash root, or below it. */
function isTrashApi(rel) {
  return rel === ".luna-trash" || rel.startsWith(".luna-trash/");
}

/**
 * `is_trash_rel`: a top-level entry named `{marker prefix}-trash`, the trash
 * root's real on-disk name. `marker::extract_prefix` only accepts a real UUID.
 */
/**
 * The trash is a folder with a minted name, so a guest asking a trash link
 * about its root is answered with that name and not with the page's word.
 *
 * @param {any} world
 * @returns {string}
 */
function trashRealName(world) {
  world.trashReal ||= `.luna-${mintHex(8)}-${mintHex(4)}-${mintHex(4)}-${mintHex(4)}-${mintHex(12)}-trash`;
  return world.trashReal;
}

function isTrashRel(rel) {
  const first = rel.split("/")[0] || "";
  return /^\.luna-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}-trash$/.test(
    first,
  );
}

/** `zip_archive_basename`: the resolved path names the archive, or "drive". */
function zipArchiveBase(fullRel) {
  const trimmed = String(fullRel || "").replace(/^\/+|\/+$/g, "");
  if (trimmed === ".luna-trash") return "trash";
  if (!trimmed) return "drive";
  const leaf = trimmed.split("/").pop();
  // `content_disposition_filename` runs first: a folder whose name only cleans
  // to "download" (`:download`) collides with the browser's own default too.
  const cleaned = dispositionName(leaf);
  // A folder genuinely named "download" would collide with the browser's own
  // default name, so the daemon renames the archive instead.
  return cleaned === "download" ? "folder" : cleaned;
}

function treeOf(w, token, s) {
  const t = sharing(w).tree?.[token];
  if (t) return t;
  return [
    {
      name: "Holiday",
      kind: "dir",
      size: 0,
      modified: nowSec() - 86400 * 30,
      hidden: false,
      children: [
        { name: "Day1.jpg", kind: "file", size: 180_000, modified: nowSec() - 86400 * 4, hidden: false },
        { name: "notes.txt", kind: "file", size: 900, modified: nowSec() - 86400 * 4, hidden: false },
      ],
    },
    { name: "Menu.pdf", kind: "file", size: 220_000, modified: nowSec() - 86400 * 3, hidden: false },
    { name: `${s.name}-notes.txt`, kind: "file", size: 1200, modified: nowSec() - 3600, hidden: false },
  ];
}

/**
 * Bytes for a shared file that has no drive node behind it, chosen by the name
 * so an image or a PDF is still the kind it claims to be.
 *
 * @param {string} name
 * @returns {any[]} bytes and content type
 */
function syntheticBytes(name) {
  const lower = String(name || "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|avif|bmp|ico)$/.test(lower)) return bytesFor({ sample: "png" });
  if (/\.pdf$/.test(lower)) return bytesFor({ sample: "pdf" });
  return [new TextEncoder().encode(`This is ${name}.\n`), "text/plain; charset=utf-8"];
}

/**
 * Walks a folder link's tree to the entry a relative path names. Every segment
 * but the last must be a folder, so a path can never reach past the shared
 * folder into something else.
 *
 * @param {Array<any>} tree
 * @param {string[]} segments
 * @returns {any} the file entry, or null
 */
/**
 * A listing answer, with the tree's own `children` removed. The field exists so
 * the fake can walk a folder; lunad never sends it, and the contract comparison
 * rejects it as `$.entries[].children`.
 *
 * @param {Array<any>} entries
 * @returns {{entries: Array<any>}}
 */
/**
 * `link_reaches`: a link may not reach into a private item unless that item's
 * own folder is at or above the shared path — a link on `Photos` must never
 * serve `Photos/Private/notes.txt`, while a link on the private folder itself
 * still works.
 *
 * @param {any} world
 * @param {any} link
 * @param {string} rel path relative to the shared folder — not the name of the
 *   folder itself, which is already the tail of `link.path`
 * @returns {boolean}
 */
function linkReaches(world, link, rel, driveId, subjectPath) {
  const drive = driveId || link.drive_id || "d1";
  // A link row carries no path of its own — the shared folder is the subject's,
  // so an empty `link.path` here would compare against nothing.
  const linkPath = String(subjectPath ?? link.path ?? "").replace(/^\/+|\/+$/g, "");
  const full = [linkPath, rel].filter(Boolean).join("/");
  let boundary;
  try {
    // `fsOf` builds the demo tree on first touch; `privateBoundary` alone reads
    // an empty map and would find nothing to refuse.
    fsOf(world, drive);
    boundary = privateBoundary(world, drive, full);
  } catch {
    return true;
  }
  if (!boundary) return true;
  // `owner_state(conn, &b.owner) != Deleted` first, then the path test: when a
  // private item's owner is deleted, the item stays private instead of
  // becoming readable, so a link inside it must close.
  const deleted = (world.deletedUsers || []).some((u) => u.id === boundary.owner);
  if (deleted) return false;
  // The boundary must be the link itself or a folder *above* it — a link on a
  // private folder still opens. A private item inside the share is what gets
  // refused, and `pathContains` is inclusive, so the boundary has to be
  // strictly above the link path rather than merely contained by it.
  return boundary.path === linkPath || pathContains(boundary.path, linkPath);
}

/**
 * files::content_disposition_filename: a name that cannot break the header, and
 * never empty. Without it a name holding a quote truncates at the quote.
 *
 * @param {string} name
 * @returns {string}
 */
function dispositionName(name) {
  const cleaned = String(name ?? "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f"\\/:]/g, "")
    .slice(0, 180)
    .trim();
  return !cleaned || cleaned === "." || cleaned === ".." ? "download" : cleaned;
}

/**
 * `has_cap(CAP_VIEW)` for a member: an admin sees the whole drive, and anybody
 * else sees what a share has given them.
 *
 * @param {any} world
 * @param {any} user
 * @param {string} drive
 * @param {string} path
 * @returns {boolean}
 */
function memberSees(world, user, drive, path) {
  if (!user) return false;
  if (user.role === "admin") return true;
  const want = String(path || "").replace(/^\/+|\/+$/g, "");
  for (const s of sharing(world).subjects) {
    if ((s.drive_id || "d1") !== (drive || "d1")) continue;
    const held =
      (s.members || []).find((m) => m.user_id === user.id)?.caps ||
      (s.inherited_members || []).find((m) => m.user_id === user.id)?.caps ||
      "";
    if (!sees(held)) continue;
    const root = String(s.path || "").replace(/^\/+|\/+$/g, "");
    if (!root || want === root || want.startsWith(`${root}/`)) return true;
  }
  return false;
}

/**
 * `caps_from_str`: "full" and "edit" are all three bits, "write" and
 * "read_write" are view+upload, and `read` is another spelling of view. Every
 * gate below asks this set rather than splitting the string by hand, because
 * splitting alone misses the aliases and lets a full-access link through as if
 * it could not see anything.
 *
 * @param {string | string[]} caps
 * @returns {Set<string>}
 */
function capSet(caps) {
  const parts = (Array.isArray(caps) ? caps : String(caps || "").split("+"))
    .map((part) => String(part).trim().toLowerCase())
    .filter(Boolean);
  if (parts.includes("full") || parts.includes("edit"))
    return new Set(["view", "upload", "edit"]);
  if (parts.includes("write") || parts.includes("read_write")) return new Set(["view", "upload"]);
  const out = new Set();
  for (const part of parts) out.add(part === "read" ? "view" : part);
  return out;
}

/** Does this link carry `CAP_VIEW`? */
function sees(caps) {
  return capSet(caps).has("view");
}

/** `accept_json`: does the caller want to be told about the file, not handed it? */
/**
 * `resolve_respond_link`: a respond link is a path subject carrying the
 * answering capability. Every other link says so and stops.
 *
 * @param {any} s the link's subject row
 * @param {string} caps the link's capabilities
 * @returns {import("../router.js").Res | null}
 */
function respondGate(s, caps) {
  if (s.kind !== "path" || !capSet(caps).has("respond"))
    return fail(403, "This link doesn't open a form.");
  return null;
}

/** One `settings` key of a form document. */
/**
 * The form document a respond link answers. A scenario that does not carry one
 * answers the RSVP the gallery shows, so the questions a page asks and the
 * answers the route judges come from the same place.
 *
 * @param {any} l
 */
function formOf(l) {
  return (
    l.form || {
      title: "RSVP",
      version: 1,
      questions: [
        { id: "q1", type: "short_text", label: "Your name", required: true },
        {
          id: "q2",
          type: "choice",
          label: "Can you come?",
          required: true,
          config: { options: ["Yes", "No", "Maybe"] },
        },
        { id: "q3", type: "long_text", label: "Anything we should know?" },
      ],
      settings: { allowEdits: true, collecting: true },
    }
  );
}

function formSetting(l, key) {
  return formOf(l).settings?.[key];
}

/** `form_allows_edits`: a missing flag means changes are allowed. */
function formAllowsEdits(l) {
  const set = formSetting(l, "allowEdits");
  return set === undefined ? true : Boolean(set);
}

/** `form_max_responses`: missing, zero or junk means no cap. */
function formMaxResponses(l) {
  const n = Number(formSetting(l, "maxResponses"));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** Today in the daemon's `YYYY-MM-DD` form, in local time. */
function localYmd() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * `hard_closed_message`: the two ways a form stops taking answers, in the order
 * the daemon tests them. The answer cap is not one of them — someone holding an
 * edit link may still change an answer.
 *
 * @param {any} l
 * @returns {string | null}
 */
function hardClosed(l) {
  // The fake's scenarios close a link either on the row itself or in the form
  // document it answers; lunad reads the document, and the row is how a seeded
  // scenario says the same thing.
  if (l.accepting === false)
    return l.closed_message || "This form isn't collecting answers anymore.";
  if (formSetting(l, "collecting") === false)
    return "This form isn't collecting answers anymore.";
  const closeOn = formSetting(l, "closeOn");
  if (typeof closeOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(closeOn) && localYmd() > closeOn)
    return `This form stopped taking answers after ${closeOn}.`;
  return null;
}

function acceptJson(headers) {
  return /application\/json/i.test(String(header(headers, "accept") || ""));
}

/**
 * `public_root_inner`'s test: a nonzero `?meta` (it is a `u8`, so `0` means
 * "send the bytes"), or an `Accept` that asks for JSON.
 *
 * @param {Record<string, string>} query
 * @param {Record<string, string>} headers
 * @returns {boolean}
 */
function metaWanted(query, headers) {
  return Number(query.meta ?? 0) !== 0 || acceptJson(headers);
}

/** The extensions a form attachment may use, and the name the daemon mints. */
const ATTACH_EXTS = { jpg: "jpg", jpeg: "jpg", png: "png", gif: "gif", webp: "webp", pdf: "pdf" };
const ATTACH_KIND_MESSAGE = "Attach a photo (JPG, PNG, GIF, or WebP) or a PDF.";

/**
 * `u64::from_str`: digits, with one optional leading `+`, and a number that
 * fits in 64 bits — a longer one fails to parse rather than wrapping.
 */
function parseU64(text) {
  if (!/^\+?\d+$/.test(text)) return null;
  const n = BigInt(text.replace("+", ""));
  return n <= 18446744073709551615n ? n : null;
}

/** The daemon's own ceiling on one file, used to judge a chunk range. */
const MAX_FILE_BYTES = 1099511627776n;

/** A random lowercase-hex string, as the daemon mints its file names. */
function mintHex(len) {
  const alphabet = "0123456789abcdef";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * 16)];
  return out;
}

/** `answer_value_ok`: a scalar, or a list of strings, numbers and booleans. */
function answerValueOk(value) {
  if (value === null || typeof value !== "object") return true;
  if (!Array.isArray(value)) return false;
  return value.every((item) => typeof item === "string" || typeof item === "number" || typeof item === "boolean");
}

/** `is_answered`: a non-empty string, a non-empty list, or any scalar. */
function isAnswered(value) {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim() !== "";
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** `question_options`: only `config.options`, and only the real strings in it. */
function questionOptions(question) {
  const list = question?.config?.options;
  if (!Array.isArray(list)) return [];
  return list.filter((o) => typeof o === "string" && o.trim() !== "");
}

/** `allows_other`: a choice that also takes a typed answer. */
function allowsOther(question) {
  return question?.config?.allowOther === true;
}

/** `number_in_range`: the answer inside the question's own bounds. */
function numberInRange(question, n) {
  if (!Number.isFinite(n)) return false;
  // A bound is a JSON number or it is no bound at all: `"5"` is not a limit.
  const min = typeof question?.config?.min === "number" ? question.config.min : null;
  const max = typeof question?.config?.max === "number" ? question.config.max : null;
  const hasMin = min !== null && Number.isFinite(min);
  const hasMax = max !== null && Number.isFinite(max);
  return (!hasMin || n >= min) && (!hasMax || n <= max);
}

/** `email_ok`: trimmed, one `@`, a dotted domain that does not start or end there. */
function emailOk(value) {
  const text = String(value).trim();
  const parts = text.split("@");
  if (parts.length !== 2) return false;
  const [local, domain] = parts;
  return (
    local !== "" &&
    domain.includes(".") &&
    !domain.startsWith(".") &&
    !domain.endsWith(".") &&
    !/\s/.test(text)
  );
}

/** The extensions a question picture may have — everything but a PDF. */
const PICTURE_EXTS = { jpg: "jpg", jpeg: "jpg", png: "png", gif: "gif", webp: "webp" };

/** The message a wrong kind of picture gets. */
const PICTURE_KIND_MESSAGE = "Choose a photo: JPG, PNG, GIF, or WebP.";

/** `content_matches`: the bytes really are the kind the extension says. */
function contentMatches(ext, bytes) {
  const starts = (...want) => want.every((b, i) => bytes[i] === b);
  if (ext === "pdf") return starts(0x25, 0x50, 0x44, 0x46, 0x2d);
  return pictureBytes(ext, bytes);
}

/** The photo kinds `content_matches` knows. */
function pictureBytes(ext, bytes) {
  const starts = (...want) => want.every((b, i) => bytes[i] === b);
  if (ext === "jpg" || ext === "jpeg") return starts(0xff, 0xd8, 0xff);
  if (ext === "png") return starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  if (ext === "gif")
    return (
      starts(0x47, 0x49, 0x46, 0x38, 0x37, 0x61) || starts(0x47, 0x49, 0x46, 0x38, 0x39, 0x61)
    );
  if (ext === "webp")
    return (
      bytes.length >= 12 &&
      starts(0x52, 0x49, 0x46, 0x46) &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50
    );
  return false;
}

/** `upload_name_ok`: a server-minted name — 16 lowercase hex and an extension. */
function uploadNameOk(name) {
  const dot = String(name).lastIndexOf(".");
  if (dot < 0) return false;
  const stem = String(name).slice(0, dot);
  const ext = String(name).slice(dot + 1);
  return (
    stem.length === 16 &&
    /^[0-9a-f]{16}$/.test(stem) &&
    ["jpg", "jpeg", "png", "gif", "webp", "pdf"].includes(ext)
  );
}

/** A responder's burst allowance: `form_respond_limiter`, 12 a minute. */
function respondAllowed(world, kind) {
  const windows = (world.respondWindows ||= {});
  const bucket = (windows[kind] ||= { count: 0, start: 0 });
  const now = nowSec();
  if (bucket.count === 0 || now - bucket.start >= 60) {
    bucket.count = 1;
    bucket.start = now;
  } else if (bucket.count >= 12) {
    return fail(429, "Too many tries from this network just now. Wait a minute and try again.");
  } else {
    bucket.count += 1;
  }
  return null;
}

/**
 * `question_skipped`: a question carries `logic`, so it is only asked when the
 * question it watches sits above it, is itself asked, and holds the value the
 * logic expects.
 *
 * @param {any} l
 * @param {any} question
 * @param {Record<string, any>} answers
 * @returns {boolean}
 */
function questionSkipped(l, question, answers) {
  const logic = question?.logic;
  if (!logic || typeof logic !== "object" || Array.isArray(logic)) return false;
  const triggerId = typeof logic.questionId === "string" ? logic.questionId : "";
  if (!triggerId) return false;
  const questions = (formOf(l).questions || []).filter((q) => typeof q?.id === "string");
  const idx = questions.findIndex((q) => q.id === question.id);
  const triggerIdx = questions.findIndex((q) => q.id === triggerId);
  if (idx < 0 || triggerIdx < 0 || triggerIdx >= idx) return false;
  if (questionSkipped(l, questions[triggerIdx], answers)) return false;
  const expect = typeof logic.equals === "string" ? logic.equals : "";
  const got = answers[triggerId];
  if (Array.isArray(got)) return got.some((v) => v === expect);
  if (typeof got === "string") return got === expect;
  if (got === undefined || got === null) return expect === "";
  // Anything else is compared with a string and can never equal one.
  return false;
}

/**
 * `keep_known_answers` then `validate_answers`: a question removed while
 * somebody was answering must not cost them the rest, and an answer that is not
 * the shape its question takes is refused with the question named.
 *
 * @param {any} l
 * @param {Record<string, any>} answers
 * @returns {import("../router.js").Res | null}
 */
function checkAnswers(l, answers, canAttach) {
  // A question with no id at all is not judged; one whose id is `""` is still
  // judged (it can be required), but no answer can be filed under it.
  const questions = (formOf(l).questions || []).filter((q) => typeof q?.id === "string");
  const known = new Map(questions.filter((q) => q.id !== "").map((q) => [q.id, q]));
  for (const key of Object.keys(answers)) if (!known.has(key)) delete answers[key];
  for (const question of questions) {
    // The label names the question in a refusal only when it is real text.
    const label =
      (typeof question.label === "string" && question.label.trim()) || "A question";
    const value = answers[question.id];
    const answered = isAnswered(value);
    // A hidden question is not required; a value sent for it anyway still has
    // to be a real answer, because skipping does not turn off the checks.
    if (question.required === true && !answered && !questionSkipped(l, question, answers))
      return fail(400, `"${label}" still needs an answer.`);
    if (!answered) continue;
    const options = questionOptions(question);
    const other = allowsOther(question);
    const inOptions = (v) => options.length === 0 || other || options.includes(v);
    let ok = false;
    switch (question.type) {
      case "multi_choice":
        ok = Array.isArray(value) && value.every((v) => typeof v === "string" && inOptions(v));
        break;
      case "choice":
      case "dropdown":
        ok = typeof value === "string" && inOptions(value);
        break;
      case "yes_no":
        ok = value === "yes" || value === "no";
        break;
      case "date":
      case "short_text":
      case "long_text":
        ok = typeof value === "string";
        break;
      case "email":
        ok = typeof value === "string" && emailOk(value);
        break;
      case "number":
        ok = typeof value === "number" && numberInRange(question, value);
        break;
      case "file":
        // A file answer may only name an attachment this respondent has, or one
        // already on the answer being edited.
        ok =
          typeof value === "string" &&
          uploadNameOk(value) &&
          (canAttach == null || canAttach(value));
        break;
      // A type from a newer Luna stores any flat value it was sent.
      default:
        ok = answerValueOk(value);
    }
    if (!ok)
      return fail(400, `The answer for "${label}" isn't in a shape Luna can store. Try again.`);
  }
  return null;
}

/**
 * Axum deserializes a query before the handler runs, so `?limit=abc` is a 400
 * rather than a clamped page. The fake answers with the same rejection so a
 * guest who mistypes a number is told, not quietly served page one.
 *
 * @param {Record<string, any>} query
 * @param {string} name
 * @param {"u8" | "u32"} kind
 * @returns {{ value?: number, error?: any }}
 */
function queryInt(query, name, kind) {
  const raw = query?.[name];
  if (raw === undefined) return {};
  const text = String(raw);
  if (!/^\d+$/.test(text))
    return {
      error: fail(400, `Failed to deserialize query string: ${name}: invalid digit found in string`),
    };
  const max = kind === "u8" ? 255 : 4_294_967_295;
  const n = Number(text);
  if (n > max)
    return {
      error: fail(400, `Failed to deserialize query string: ${name}: number too large to fit in target type`),
    };
  return { value: n };
}

/**
 * `files::is_internal_temp`: Luna's own bookkeeping — any `.luna-<uuid>`
 * segment, or a dotfile left half-written — is never shown to a guest.
 *
 * @param {string} name
 * @returns {boolean}
 */
function isInternalName(name) {
  const raw = String(name || "");
  const base = raw.split("/").pop() || "";
  const luna = /\.luna-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/;
  return luna.test(base) || (base.startsWith(".") && base.endsWith(".part"));
}

/** `Layout::is_luna_name`: the name opens with a `.luna-<uuid>` marker. */
const lunaMarker = (name) =>
  /^\.luna-[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/.test(
    String(name ?? ""),
  );

/** `files::is_internal_temp`: a marker segment anywhere, or a `.part` leaf. */
const guestInternal = (segments) => {
  const leaf = segments[segments.length - 1] || "";
  return segments.some(lunaMarker) || (leaf.startsWith(".") && leaf.endsWith(".part"));
};

/** `files::safe_name`: a bare, non-empty basename a drive can hold. */
function safeName(name) {
  const raw = String(name ?? "");
  // A path separator or an embedded NUL is not a name a drive can hold.
  if (raw.includes("/") || raw.includes("\\") || raw.includes(String.fromCharCode(0))) return null;
  const trimmed = raw.trim();
  // `safe_name` measures the name in bytes, not characters.
  if (!trimmed || trimmed === "." || trimmed === ".." || new TextEncoder().encode(trimmed).length > 255)
    return null;
  // Luna's own `.luna-<uuid>` namespace and the trash alias are its bookkeeping,
  // so a guest naming one would create something the UI can never show.
  // `is_luna_name` reads a marker prefix off the *start* of the name, so a
  // `.luna-<uuid>` in the middle is just part of somebody's filename.
  if (lunaMarker(trimmed) || trimmed === ".luna-trash") return null;
  return trimmed;
}

/** `gallery::is_media`: the album accepts pictures and video, nothing else. */
function isMediaName(name) {
  const ext = String(name ?? "").split(".").pop().toLowerCase();
  return [
    "jpg", "jpeg", "png", "gif", "heic", "heif", "hif",
    "mp4", "mov", "m4v", "webm",
  ].includes(ext);
}

/** `ChildCounts`: how many things sit directly inside a folder, by kind. */
function childCounts(kids) {
  const counts = { dirs: 0, files: 0, other: 0 };
  for (const kid of kids || []) {
    if (kid.kind === "dir") counts.dirs += 1;
    else if (kid.kind === "file") counts.files += 1;
    else counts.other += 1;
  }
  return counts;
}

function listing(entries) {
  return { entries: entries.map(({ children: _children, ...rest }) => rest) };
}

/** The entry at `segments`, directories included, or null when nothing is there. */
function nodeAt(tree, segments) {
  if (!segments.length) return { kind: "dir", name: "" };
  let level = tree;
  let found = null;
  for (const [i, seg] of segments.entries()) {
    found = level?.find?.((e) => e.name === seg) || null;
    if (!found) return null;
    if (i < segments.length - 1) {
      if (found.kind !== "dir") return null;
      level = found.children || [];
    }
  }
  return found;
}

const publicGet = (p, h) => get(p, h, { public: true });

publicGet("/s/:token", ({ world, params, query, headers }) => {
  // Axum rejects a query it cannot deserialize before the handler body runs, so
  // a bad `?meta` or `?download` is a 400 even for a token that is unknown.
  const badRoot = queryInt(query, "meta", "u8").error || queryInt(query, "download", "u8").error;
  if (badRoot) return badRoot;
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const { s, l } = r;
  // `public_form_document` reports the answer cap separately from closure: an
  // answer cap blocks new answers but not an edit of one already sent.
  const formMax = formMaxResponses(l);
  const full = l.full === true || (formMax !== null && (l.responses || []).length >= formMax);
  if (l.caps === "respond") {
    // `respond_document` names the permission as well as the form: the page
    // reads it to know an answer is what this link is for.
    return {
      kind: "form",
      permission: "respond",
      form: formOf(l),
      accepting: !hardClosed(l),
      full,
      closed_message:
        hardClosed(l) ||
        (full ? "This form has all the answers it can take." : ""),
    };
  }
  // A link with no view capability is a drop box: `public_root_inner` sends it
  // straight to `{kind:"dropbox", caps}` and never lets it name what it points
  // at, because the whole promise of the link is that the uploader sees
  // nothing. Asking it for a path is refused rather than ignored.
  const caps = String(l.caps || "").split("+").filter(Boolean);
  const canView = sees(caps);
  if (s.kind !== "album" && !canView) {
    if (String(query.path ?? "").trim()) return fail(400, "That folder isn't part of this shared link.");
    return { kind: "dropbox", caps: l.caps };
  }
  // `public_root_inner` resolves the album before it answers: a gone drive or a
  // deleted album closes the page rather than showing an empty gallery, and the
  // name it prints is the album's own, read now rather than kept on the link.
  let albumRow = null;
  if (s.kind === "album") {
    const found = albumFor(world, s);
    if (found.err) return found.err;
    albumRow = found.album;
  }
  const kind = s.kind === "album" ? "album" : s.is_file ? "file" : "folder";
  const count = s.kind === "album" ? (world.albumItems?.[s.album_id] || []).length : undefined;
  // `public_root_inner` also answers for a path below the link: the lexical
  // gate, then the trash gate, then the read. An album ignores the path — its
  // branch in the daemon comes first.
  const segments = kind === "album" ? [] : linkSegments(query.path);
  if (!segments) return fail(400, "That folder isn't part of this shared link.");
  if (kind !== "album") {
    const trash = trashProbe(s, segments);
    if (trash) return trash;
  }
  // `public_root_inner` resolves a viewable path subject through
  // `confined_read`. A link whose drive is gone therefore answers with the
  // unavailable wording, not with a shell that mounts a browser over nothing.
  if (kind === "file" || kind === "folder") {
    const goneRoot = unavailableShare(world, s, "The shared files aren't available right now.");
    if (goneRoot) return goneRoot;
  }
  const linkRel = String(s.path || "").replace(/^\/+|\/+$/g, "");
  const rel = segments.length ? segments.join("/") : linkRel;
  // `confined_read` runs `link_reaches` inside the same read, so reaching above
  // the link is the same miss as asking for something that is not there.
  if (kind !== "album" && segments.length && !linkReaches(world, r.l, rel, s.drive_id, s.path))
    return fail(404, "That item isn't part of this shared link.");
  // A file link has nothing beneath it, so any path below it is a miss rather
  // than a walk into a tree that only exists for folder links.
  if (s.is_file && segments.length)
    return fail(404, "The shared files aren't available right now.");
  const found =
    kind !== "album" && segments.length ? nodeAt(treeOf(world, params.token, s), segments) : null;
  if (kind !== "album" && segments.length && !found)
    return fail(404, "The shared files aren't available right now.");
  // `public_root_inner` names a path subject after the last piece of the
  // resolved path, not after something it invented: a whole-drive link (empty
  // path) falls through to "download", and the trash root is spelled "Trash"
  // because its on-disk name carries a nonce.
  const rootName = rel === ".luna-trash" ? "Trash" : rel ? rel.split("/").pop() : "download";
  if (found && found.kind !== "dir") {
    // A path to a file downloads it unless the caller said it wants to be told
    // about it instead — a nonzero `?meta`, or an Accept that asks for JSON.
    if (!metaWanted(query, headers))
      return serveSharedFile(world, r, rel, found.name, Number(query.download ?? 0) !== 0);
    return { kind: "file", name: rootName, caps: l.caps, size: found.size ?? 120_000 };
  }
  // A single-file link has no tree to look through, but `public_root_inner`
  // serves it exactly as it serves a path to a file: bytes, or the descriptor
  // when asked for one. The browser never sees the difference.
  if (kind === "file") {
    if (!metaWanted(query, headers))
      return serveSharedFile(world, r, "", s.name, Number(query.download ?? 0) !== 0);
    return { kind: "file", name: rootName, caps: l.caps, size: 120_000 };
  }
  return {
    kind: kind === "album" ? "album" : segments.length ? "folder" : kind,
    name: kind === "album" ? (albumRow?.name ?? s.name) : rootName,
    caps: l.caps,
    size: s.is_file ? 120_000 : undefined,
    item_count: count,
  };
});

publicGet("/s/:token/items", ({ world, params, query, headers }) => {
  const badItems = queryInt(query, "limit", "u32").error || queryInt(query, "offset", "u32").error;
  if (badItems) return badItems;
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  // lunad's `public_items` answers `gone()` for any link that is not a viewable
  // album, so a folder, file or drop box share has no photo page at all.
  const itemCanView = sees(r.l.caps);
  if (r.s.kind !== "album" || !itemCanView) return fail(410, "This link has expired or been removed.");
  // `public_items` resolves the album's drive first.
  const itemAlbum = albumFor(world, r.s);
  if (itemAlbum.err) return itemAlbum.err;
  const keys = new Set(world.albumItems?.[r.s.album_id] || []);
  const all = (world.photos || []).filter((p) => keys.has(photoKey(p)));
  const limitRaw = Number(query.limit);
  // `public_items` clamps the page size rather than trusting it: 0 is one
  // photo, and a request for a thousand is two hundred.
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), 200) : 80;
  const offset = Number(query.offset) || 0;
  // `album_media_urls` names the guest bytes route, so a public photo is never
  // fetched from the signed-in drive API. The gallery's pictures come back
  // through `/s/:token/media`, exactly as they would from the daemon — the
  // media URLs below are the only difference from the drive's own item shape.
  const mediaUrl = (p, variant) =>
    `/s/${encodeURIComponent(params.token)}/media?drive_id=${encodeURIComponent(p.drive_id || "d1")}` +
    `&path=${encodeURIComponent(p.path || "")}&variant=${variant}`;
  // `public_items` clamps the start to the number of photos, so a page asked
  // for past the end still names the end rather than the offset it never had.
  const start = Math.min(offset, all.length);
  const items = all.slice(start, start + limit).map((p) => ({
    ...p,
    thumb: mediaUrl(p, "thumb"),
    content: mediaUrl(p, "content"),
    download: mediaUrl(p, "download"),
  }));
  return {
    kind: "album",
    name: itemAlbum.album?.name ?? r.s.name,
    item_count: all.length,
    caps: r.l.caps,
    items,
    has_more: start + items.length < all.length,
    next_offset: start + items.length,
  };
});

// `GET /s/:token/media` — the guest's own bytes for one album photo. Without
// this the album page's pictures load from a route lunad doesn't serve.
publicGet("/s/:token/media", ({ world, params, query, headers }) => {
  // `PublicMediaQuery` has two required fields, so axum refuses a request that
  // leaves either out before the token is even resolved.
  for (const field of ["drive_id", "path"])
    if (query[field] === undefined)
      return fail(400, `Failed to deserialize query string: missing field \`${field}\``);
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  // Same gate as `public_media`: anything that is not a viewable album closes,
  // it does not answer bytes.
  const caps = String(r.l.caps || "").split("+").filter(Boolean);
  const canView = sees(caps);
  if (r.s.kind !== "album" || !canView) return fail(410, "This link has expired or been removed.");
  const path = String(query.path || "");
  // `album_for_link` resolves the album's own drive before the photo is looked
  // up: unknown, unplugged, unreadable and deleted each say their own thing.
  const albumDrive = r.s.drive_id || "d1";
  const albumFound = albumFor(world, r.s);
  if (albumFound.err) return albumFound.err;
  // `album_item_allowed` tests the drive and path pair the request named, not
  // the path alone: the same path on another drive is not this album's photo.
  const driveId = String(query.drive_id || albumDrive);
  const photo = (world.photos || []).find(
    (p) =>
      p.path === path &&
      String(p.drive_id || "d1") === driveId &&
      (world.albumItems?.[r.s.album_id] || []).includes(photoKey(p)),
  );
  // `album_item_allowed` refuses anything the album does not hold, and the
  // wording is about the photo rather than about the link.
  if (!photo) return fail(403, "That photo is not part of this shared album.");
  // `public_media` then resolves the drive the request named — an unknown or
  // unplugged one is the plain "couldn't find that photo", not the album 403.
  const photoDrive = driveRow(world, driveId);
  if (!photoDrive || !driveUsable(world, driveId))
    return fail(404, "Luna couldn't find that photo.");
  const variant = String(query.variant || "content");
  // A thumb that has not been built yet is built from the photo when it is
  // asked for, so a missing thumb is not a missing photo; only when there is
  // nothing to build from does the thumb route say it isn't ready.
  const url = variant === "thumb" ? photo.thumb || photo.content : photo.content;
  // Every other variant's miss is named after the file — content and downloads
  // are resolved on the drive, not derived from the album.
  const missingVariant = (name) =>
    variant === "thumb"
      ? fail(404, "This thumbnail isn't ready yet.")
      : fail(404, `Luna couldn't find that ${name}.`);
  if (!url) return missingVariant("photo");
  // The fake's pictures are inline `data:` URLs, so the guest's bytes are the
  // decoded body of one. Any parameters before the comma (`;utf8`) are part of
  // the media type, not of the payload.
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0) return missingVariant("photo");
  const meta = url.slice(5, comma);
  const body = url.slice(comma + 1);
  const type = meta.split(";")[0];
  const bytes = /;base64/i.test(meta)
    ? Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(body));
  // A download is an attachment, a photo to show is inline, and a thumb is
  // streamed as an image with no name at all.
  const disposition =
    variant === "download"
      ? { "Content-Disposition": `attachment; filename="${dispositionName(photo.name || "photo")}"` }
      : variant === "thumb"
        ? {}
        : { "Content-Disposition": `inline; filename="${dispositionName(photo.name || "photo")}"` };
  return raw(bytes, type, 200, disposition);
});

publicGet("/s/:token/list", ({ world, params, query, headers }) => {
  const badList = queryInt(query, "download", "u8").error;
  if (badList) return badList;
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  // lunad's public_list requires a path subject with view access: an album or a
  // link whose only job is answering cannot browse a folder. A drop box
  // promises nobody can see what is in it, so it has no listing either.
  const caps = String(r.l.caps || "").split("+").filter(Boolean);
  // "full" is CAP_ALL, which includes CAP_VIEW; a drop box ("upload") and an
  // answering-only link ("respond") carry no view at all, so they list nothing.
  const canView = sees(caps);
  if (r.s.kind !== "path" || !canView) return fail(410, "This link has expired or been removed.");
  const segments = linkSegments(query.path);
  if (!segments) return fail(400, "That folder isn't part of this shared link.");
  const trash = trashProbe(r.s, segments);
  if (trash) return trash;
  // `public_list` goes through `confined_read` too, so a folder whose drive is
  // gone stops listing rather than looking empty to the guest.
  const goneFolder = unavailableShare(world, r.s, "The shared folder isn't available right now.");
  if (goneFolder) return goneFolder;
  // A single-file link still gets a listing, because its page mounts a file
  // browser: that browser must show the one shared file, not an error. Asking
  // for anything below it asks for something that cannot be a folder.
  if (r.s.is_file) {
    // `public_list` asks `confined_read` for `<link.path>/<extra>` before it
    // asks what the target is, so asking a file link for something below the
    // file is a miss with the listing's own wording, not the is_dir refusal.
    if (segments.length) return fail(404, "The shared folder isn't available right now.");
    // The one entry is `files::stat`'s own answer, serialized as-is: a file
    // carries no `children` or `totals` key at all, because both are skipped
    // when empty rather than printed as null.
    const subjectRel = String(r.s.path || "").replace(/^\/+|\/+$/g, "");
    // `files::stat` stamps `private` on the item that *is* a private share and
    // `in_private` on one protected by a boundary above it, and prints neither
    // when there is none — an ordinary file carries no such keys at all.
    const boundary = privateBoundary(world, r.s.drive_id, subjectRel);
    const stamp = boundary
      ? boundary.path === subjectRel
        ? { private: true }
        : { in_private: true }
      : {};
    return listing([
      {
        name: r.s.name,
        kind: "file",
        size: 120_000,
        modified: nowSec() - 86400,
        created: nowSec() - 86400 * 30,
        hidden: false,
        ...stamp,
        writable: false,
      },
    ]);
  }
  // A guest who opens a folder sees that folder's entries, not the root again.
  const tree = treeOf(world, params.token, r.s);
  // `public_list` drops hidden entries and Luna's own marker folders before it
  // answers, so a dotfile or a `.luna-` marker is never listed to a guest.
  const visible = (e) => !e.hidden && !isInternalName(e.name);
  if (!segments.length)
    return listing(
      tree.filter((e) => visible(e) && linkReaches(world, r.l, e.name, r.s.drive_id, r.s.path)),
    );
  let level = tree;
  for (const [i, seg] of segments.entries()) {
    const soFar = segments.slice(0, i + 1).join("/");
    const found = level?.find?.((e) => e.name === seg) || null;
    // `confined_read` fails when the path is not there at all, and `public_list`
    // then asks `!meta.is_dir()` — a file where a folder was expected is the
    // 400 that points at Download, not a bare miss.
    if (!found) return fail(404, "The shared folder isn't available right now.");
    // `confined_read` runs its `link_reaches` boundary inside the same read
    // that resolves the path, and `public_list` only asks `is_dir` afterwards —
    // so a private file where a folder was expected is `not_in_share`, not the
    // "isn't a folder" refusal. Walking *through* a private folder is reaching
    // into it and answers the same way rather than hiding what is below.
    if (!linkReaches(world, r.l, soFar, r.s.drive_id, r.s.path))
      return fail(404, "That item isn't part of this shared link.");
    if (found.kind !== "dir") {
      // A file part-way down the path cannot be walked through, so the resolve
      // fails before `public_list` asks anything about the target.
      if (i < segments.length - 1) return fail(404, "The shared folder isn't available right now.");
      return fail(400, "That isn't a folder.");
    }
    level = found.children || [];
  }
  return listing(
    level.filter(
      (e) =>
        visible(e) &&
        linkReaches(world, r.l, [...segments, e.name].join("/"), r.s.drive_id, r.s.path),
    ),
  );
});
// `GET /s/:token/zip`: an album link zips the album, a folder link zips that
// folder, and a link to one file hands back the file itself. Without this the
// album page's "Download album" hit the router's 501 and did nothing.
/**
 * `public_zip` serves the file itself when the target is not a directory, and
 * `public_file` serves it always. Both must answer with the drive's real bytes
 * when there is a node, so a shared file downloads as itself rather than as
 * filler wearing its name.
 *
 * @param {any} world
 * @param {any} r      the opened link plus its subject
 * @param {string} rel share-relative path ("" for a single-file share)
 * @param {string} name the filename to offer
 */
/**
 * `confined_read` resolves the link root through `files::resolve_any_including_trash`
 * first, so a drive that is gone fails the read before the entry is looked at.
 * Every public route that streams bytes or lists a folder has to say so in the
 * same words lunad uses, or the page tells the guest the folder was empty.
 *
 * @param {any} world
 * @param {any} s     the link's subject
 * @param {string} msg the caller's not-available wording
 * @returns {any | null} the refusal, or null when the drive is fine
 */
/**
 * `resolve_album` / `album_for_link`: an album's own drive has to be there and
 * the album has to still exist before any of its photos are answered for.
 *
 * @returns {{ err?: any, album?: any }}
 */
function albumFor(world, s) {
  const driveId = s.drive_id || "d1";
  try {
    needDrive(world, driveId);
  } catch (e) {
    if (e?.body?.code === "missing_drive_db")
      return { err: fail(500, "Luna couldn't read this album.") };
    if (!driveRow(world, driveId)) return { err: fail(404, "Luna doesn't know this drive.") };
    return { err: fail(404, "This album's drive isn't plugged in right now.") };
  }
  const album = (world.albums || []).find((a) => a.id === s.album_id);
  // A link whose album was deleted has closed, not lost its photos.
  if (!album) return { err: fail(410, "This link has expired or been removed.") };
  return { err: null, album };
}

function unavailableShare(world, s, msg) {
  if (s.kind !== "path") return null;
  try {
    needDrive(world, s.drive_id || "d1");
    return null;
  } catch {
    return fail(404, msg);
  }
}

function serveSharedFile(world, r, rel, name, download = false) {
  const drive = r.s.drive_id || "d1";
  const full = [r.s.path, rel].filter(Boolean).join("/").replace(/^\/+|\/+$/g, "");
  let node = null;
  if (full) {
    try {
      node = fsOf(world, drive).nodes?.[full] || null;
    } catch {
      node = null;
    }
  }
  const [data, type] = node ? bytesFor(node) : syntheticBytes(name);
  // `serve_file` always names the file, and picks `inline` for the kinds a
  // browser can safely show (not SVG, which can carry script).
  return raw(data, type, 200, {
    "Content-Disposition": `${download || !inlineSafe(type) ? "attachment" : "inline"}; filename="${dispositionName(name)}"`,
  });
}


/** `files::inline_safe`: mimes a browser may render in place. */
/** `files::inline_safe`: mimes a browser may render in place. */
function inlineSafe(type) {
  // Rust compares the bare mime, so a charset parameter must not defeat it.
  const t = String(type || "").split(";")[0].trim().toLowerCase();
  return (
    (t.startsWith("image/") && t !== "image/svg+xml") ||
    t.startsWith("video/") ||
    t.startsWith("audio/") ||
    t.startsWith("font/") ||
    t === "text/plain" ||
    t === "text/csv"
  );
}

publicGet("/s/:token/zip", ({ world, params, query, headers }) => {
  const badZip = queryInt(query, "download", "u8").error;
  if (badZip) return badZip;
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  // lunad's gate is `caps & CAP_VIEW == 0`. "full" is CAP_ALL, which includes
  // CAP_VIEW, and a capsule like "view+upload" does too — so split, never
  // substring-match, or "full" is wrongly refused.
  const caps = String(r.l.caps || "").split("+").filter(Boolean);
  const canView = sees(caps);
  if (!canView) return fail(410, "This link has expired or been removed.");
  if (r.s.kind === "album") {
    // `album_zip_response` resolves the album's drive, then counts its refs: an
    // empty album and one over the 500-photo limit are both refusals.
    const albumRes = albumFor(world, r.s);
    if (albumRes.err) return albumRes.err;
    const photos = (world.albumItems?.[r.s.album_id] || []).length;
    if (!photos) return fail(400, "This album has no photos to download yet.");
    if (photos > 500) {
      return fail(
        400,
        "This album has too many photos to download as one zip (limit 500).",
      );
    }
    // A real zip would be megabytes of real photos; the harness only needs the
    // download to happen and the name to be right.
    // `album_zip_response` names the archive after the album row, not after the
    // cached name on the link's subject, and falls back to `album.zip` when
    // that name sanitises away to nothing.
    const albumBase = dispositionName(albumRes.album.name || r.s.name || "album");
    const albumZipName = albumBase === "download" ? "album" : albumBase;
    return raw(new TextEncoder().encode(`PK\x05\x06${"\0".repeat(18)}`), "application/zip", 200, {
      "Content-Disposition": `attachment; filename="${albumZipName}.zip"`,
    });
  }
  if (r.s.kind !== "path") return fail(410, "This link has expired or been removed.");
  const segments = linkSegments(query.path);
  if (!segments) return fail(400, "That folder isn't part of this shared link.");
  const trashSegment = trashProbe(r.s, segments);
  if (trashSegment) return trashSegment;
  // `public_zip` resolves the target through `confined_read` before it asks
  // whether the target is a directory, so a dead drive is refused for a
  // single-file link too — and its `link_reaches` runs inside that same read.
  const goneFiles = unavailableShare(world, r.s, "The shared files aren't available right now.");
  if (goneFiles) return goneFiles;
  if (r.s.is_file) {
    // A file link has nothing beneath it, so `confined_read` misses and the
    // guest reads the zip route's own plural wording.
    if (segments.length) return fail(404, "The shared files aren't available right now.");
    if (!linkReaches(world, r.l, "", r.s.drive_id, r.s.path))
      return fail(404, "That item isn't part of this shared link.");
    return serveSharedFile(world, r, "", r.s.name || "download", true);
  }
  const tree = treeOf(world, params.token, r.s);
  // A folder is the normal thing to zip, so walk the tree for any entry rather
  // than `inTree`, which deliberately returns null for a directory.
  if (segments.length) {
    let level = tree;
    let found = null;
    for (const [i, seg] of segments.entries()) {
      found = level?.find?.((e) => e.name === seg) || null;
      // `public_zip` resolves the target through `confined_read`, whose failure
      // wording for a zip is the plural one — the guest was downloading files.
      if (!found) return fail(404, "The shared files aren't available right now.");
      if (i < segments.length - 1) {
        if (found.kind !== "dir") return fail(404, "The shared files aren't available right now.");
        level = found.children || [];
      }
    }
    // Zipping must obey the same private-folder boundary as listing and
    // reading, or a guest could zip a folder the link may see but never enter.
    if (!linkReaches(world, r.l, segments.join("/"), r.s.drive_id, r.s.path))
      return fail(404, "That item isn't part of this shared link.");
    // `public_zip` checks the resolved target: only a directory is zipped, and
    // anything else is the file itself. Without this, `?path=Holiday/notes.txt`
    // answers with an empty zip wearing the name `notes.txt.zip`.
    if (found.kind !== "dir") return serveSharedFile(world, r, segments.join("/"), found.name, true);
  }
  // `zip_archive_basename` names the archive from the resolved path, so a
  // whole-drive link zips as `drive.zip` rather than wearing the drive label.
  const zipBase = zipArchiveBase([r.s.path, segments.join("/")].filter(Boolean).join("/"));
  return raw(new TextEncoder().encode(`PK\x05\x06${"\0".repeat(18)}`), "application/zip", 200, {
    "Content-Disposition": `attachment; filename="${dispositionName(zipBase)}.zip"`,
  });
});

// ── Guest changes ───────────────────────────────────────────────────────────
// A link that allows uploads may add; only a link that allows editing may
// change or remove what is already there. Neither may touch the shared item
// itself — the thing the link points at is fixed by whoever made the link.
// What a guest changes lives in the tree the guest pages read, so a new folder
// shows up in the next listing rather than vanishing on the way.

/** How serde names a value in a refusal: `integer \`5\``, `sequence`, `null`. */
function serdeHint(value) {
  if (value === null) return "null";
  if (Array.isArray(value)) return "sequence";
  if (typeof value === "number")
    return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
  if (typeof value === "string") return `string ${JSON.stringify(value)}`;
  if (typeof value === "boolean") return `boolean \`${value}\``;
  return "map";
}

/**
 * A body the route declares as JSON, refused the way serde refuses one: a
 * missing field, a wrong type, a value in a place a body can't be, or a
 * sequence that reads positionally and is too short or too long.
 *
 * @param {any} body
 * @param {Array<[string, "string" | "strings" | "optional"]>} fields in declaration order
 * @param {string} structName
 */
function writeShape(body, fields, structName) {
  const values = {};
  const dataErr = (detail) =>
    fail(422, `Failed to deserialize the JSON body into the target type: ${detail}`);
  const one = (kind, value) => {
    if (kind === "strings") {
      if (!Array.isArray(value)) return `invalid type: ${serdeHint(value)}, expected a sequence`;
      for (const v of value) {
        if (typeof v !== "string") return `invalid type: ${serdeHint(v)}, expected a string`;
      }
      return null;
    }
    if (value === null || typeof value !== "string")
      return `invalid type: ${serdeHint(value)}, expected a string`;
    return null;
  };
  if (Array.isArray(body)) {
    // A derived struct reads a sequence positionally, so each element is
    // checked as it is read, and only then does the reader notice a sequence
    // that ran out or one with something left over.
    for (let i = 0; i < Math.min(body.length, fields.length); i += 1) {
      const [name, kind] = fields[i];
      if (kind === "optional" && body[i] === null) continue;
      const bad = one(kind, body[i]);
      if (bad) return { err: dataErr(bad) };
      values[name] = body[i];
    }
    if (body.length > fields.length) return { err: dataErr("trailing characters") };
    if (body.length < fields.length)
      return {
        err: dataErr(
          `invalid length ${body.length}, expected struct ${structName} with ${fields.length} ${
            fields.length === 1 ? "element" : "elements"
          }`,
        ),
      };
    return { values };
  }
  if (!body || typeof body !== "object") {
    return { err: dataErr(`invalid type: ${serdeHint(body)}, expected struct ${structName}`) };
  }
  for (const key of Object.keys(body)) {
    const field = fields.find(([name]) => name === key);
    if (!field) continue;
    const [name, kind] = field;
    if (kind === "optional" && body[name] === null) continue;
    const bad = one(kind, body[name]);
    if (bad) return { err: dataErr(bad) };
    values[name] = body[name];
  }
  for (const [name, kind] of fields) {
    if (kind === "optional" || body[name] !== undefined) continue;
    return { err: dataErr(`missing field \`${name}\``) };
  }
  return { values };
}

/**
 * The tree a guest's page reads, kept on the sharing world so a change made by
 * one request is there for the next listing.
 */
function guestTree(world, token, s) {
  const sh = sharing(world);
  if (!sh.tree || !sh.tree[token]) {
    sh.tree ||= {};
    sh.tree[token] = treeOf(world, token, s);
  }
  return sh.tree[token];
}

/** The children a folder's segments name, or null when the folder is missing. */
function treeFolder(tree, segments) {
  let level = tree;
  for (const seg of segments) {
    const node = level.find((e) => e.name === seg && e.kind === "dir");
    if (!node) return null;
    node.children ||= [];
    level = node.children;
  }
  return level;
}

/**
 * The path a guest named, or the refusal `mutable_child` makes: a link's own
 * subject and anything outside the share are refused here, and a private wall
 * above the target closes it.
 *
 * @returns {{ segments?: string[], tree?: any[], err?: any }}
 */
function mutableSegments(world, r, raw, { forCreate = false } = {}) {
  // `mutable_child` trims whitespace and then slashes off both ends before it
  // reads the path, so `/Holiday` is `Holiday` and a bare `/` is the shared item
  // rather than a path outside the share.
  const trimmedRaw = String(raw ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (!trimmedRaw)
    return { err: fail(400, "The shared item itself can't be changed through this link.") };
  const segments = linkSegments(trimmedRaw);
  if (!segments) return { err: fail(400, "That path isn't inside this share.") };
  if (!segments.length)
    return { err: fail(400, "The shared item itself can't be changed through this link.") };
  const subjectRel = String(r.s.path || "").replace(/^\/+|\/+$/g, "");
  const rel = segments.join("/");
  if ([subjectRel, rel].filter(Boolean).join("/") === subjectRel)
    return { err: fail(400, "The shared item itself can't be changed through this link.") };
  const trash = trashProbe(r.s, segments);
  if (trash) return { err: trash };
  // A link to one file has nothing beneath it, and either way the walk meets a
  // file rather than a missing name — an `ENOTDIR` the daemon answers with its
  // catch-all, before the missing-name allowance can apply.
  if (r.s.is_file) return { err: guestBroke() };
  // `confined_write` resolves the child first and asks about the wall after,
  // so a path that isn't there is "not there", not "not in this link".
  const tree = treeOf(world, r.l.token, r.s);
  // A path with a file partway along it is `ENOTDIR` out of the walk, and the
  // daemon maps that as its catch-all rather than "not there".
  for (let i = 1; i < segments.length; i += 1) {
    const midway = nodeAt(tree, segments.slice(0, i));
    if (midway && !isFolderNode(midway)) return { err: guestBroke() };
  }
  const exists = Boolean(nodeAt(tree, segments));
  if (!exists && !forCreate)
    return { err: fail(404, "Luna can't find that anymore. Refresh and try again.") };
  if (!linkReaches(world, r.l, rel, r.s.drive_id, r.s.path))
    return { err: fail(404, "That item isn't part of this shared link.") };
  return { segments, tree };
}

/** A node the tree can walk into. */
const isFolderNode = (node) => node.kind === "dir" || node.kind === "folder";

/** The daemon's catch-all for a write it couldn't finish. */
const guestBroke = () => fail(500, "Luna couldn't do that. Check the drive and try again.");

/** A name a drive would take, or the refusal the daemon makes. */
const guestName = (name) =>
  safeName(name) && !guestInternal([name]) ? null : fail(400, "That name isn't allowed here.");

const guestNew = (kind) => ({ world, params, headers, body }) => {
  const shape = writeShape(body, [["path", "string"]], "PublicWriteBody");
  if (shape.err) return shape.err;
  const fields = shape.values;
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  if (!capSet(r.l.caps).has("upload"))
    return fail(
      403,
      "This link is view-only, so it can't receive files. Ask for a link that allows uploads.",
    );
  if (r.s.kind !== "path") return fail(410, "This link has expired or been removed.");
  const trimmed = String(fields.path).trim().replace(/^\/+|\/+$/g, "");
  // A drop box takes one level and nothing else, so a nested name would let a
  // blind uploader probe which folders exist.
  if (!capSet(r.l.caps).has("view") && trimmed.includes("/"))
    return fail(400, "This link only accepts items at the top level.");
  const named = mutableSegments(world, r, fields.path, { forCreate: true });
  if (named.err) return named.err;
  const { segments } = named;
  const name = segments[segments.length - 1];
  if (kind === "dir") {
    // `files::mkdir_as` holds the whole path to the temp-name bar and refuses
    // the trash alias as its first segment — it never calls `safe_name`, so a
    // leaf called `.luna-trash` below an existing folder is just a folder, and
    // a name past what a filesystem takes fails as an ordinary write error.
    // `mkdir_as` reads the *drive-relative* first segment, so a link rooted at
    // `Holiday` may hold a folder called `.luna-trash`.
    const subjectSegments = String(r.s.path || "")
      .split("/")
      .filter(Boolean);
    const driveFirst = [...subjectSegments, ...segments][0];
    if (guestInternal(segments) || driveFirst === ".luna-trash")
      return fail(400, "That name isn't allowed here.");
    // `mkdir_as` never holds the name to `safe_name`, but the folder still has
    // to be made, and a name with a NUL in it is one the filesystem refuses.
    if (name.includes("\0")) return fail(400, "That name isn't allowed here.");
  } else if (!safeName(name) || guestInternal(segments)) {
    // `files::create` holds the leaf to `safe_name` and the temp-name bar; a
    // padded name still passes, because only the check trims, not the path.
    return fail(400, "That name isn't allowed here.");
  }
  const level = treeFolder(guestTree(world, params.token, r.s), segments.slice(0, -1));
  if (!level) return fail(404, "Luna can't find that anymore. Refresh and try again.");
  // Only once the parent is there does the write itself meet the name, so an
  // over-long folder name is an ordinary write failure rather than a refusal.
  if (kind === "dir" && new TextEncoder().encode(name).length > 255)
    return fail(500, "Luna couldn't do that. Check the drive and try again.");
  if (level.some((e) => e.name === name))
    return fail(409, "An item with this name is already here. Choose another name.");
  level.push({
    name,
    kind,
    size: 0,
    modified: nowSec(),
    hidden: name.startsWith("."),
    ...(kind === "file" ? { text: "" } : {}),
  });
  // The answer names the item where the daemon would: drive-relative, so a link
  // rooted below the drive root carries that prefix.
  const subjectRel = String(r.s.path || "").replace(/^\/+|\/+$/g, "");
  return { ok: true, path: [subjectRel, segments.join("/")].filter(Boolean).join("/") };
};
post("/s/:token/mkdir", guestNew("dir"));
post("/s/:token/create", guestNew("file"));

post("/s/:token/rename", ({ world, params, headers, body }) => {
  const shape = writeShape(body, [["path", "string"], ["new_name", "string"]], "PublicRenameBody");
  if (shape.err) return shape.err;
  const fields = shape.values;
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  if (!capSet(r.l.caps).has("edit"))
    return fail(403, "This link doesn't allow changes. Ask for a link that allows editing.");
  if (r.s.kind !== "path") return fail(410, "This link has expired or been removed.");
  const named = mutableSegments(world, r, fields.path);
  if (named.err) return named.err;
  const { segments } = named;
  const level = treeFolder(guestTree(world, params.token, r.s), segments.slice(0, -1));
  const old = segments[segments.length - 1];
  const node = level?.find((e) => e.name === old);
  if (!node) return fail(404, "Luna can't find that anymore. Refresh and try again.");
  // `safe_name` trims before the temp-name bar, so `".x.part "` is `.x.part`.
  const bad = guestName(String(fields.new_name).trim());
  if (bad) return bad;
  const newName = safeName(String(fields.new_name).trim());
  // No same-name shortcut: a no-replace rename onto itself is a clash.
  if (level.some((e) => e.name === newName))
    return fail(409, "An item with this name is already here. Choose another name.");
  node.name = newName;
  node.hidden = newName.startsWith(".");
  return { ok: true };
});

del("/s/:token/file", ({ world, params, query, headers }) => {
  const badQuery = queryInt(query, "download", "u8").error;
  if (badQuery) return badQuery;
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  if (!capSet(r.l.caps).has("edit"))
    return fail(403, "This link doesn't allow changes. Ask for a link that allows editing.");
  if (r.s.kind !== "path") return fail(410, "This link has expired or been removed.");
  const named = mutableSegments(world, r, query.path);
  if (named.err) return named.err;
  const { segments } = named;
  const tree = guestTree(world, params.token, r.s);
  const level = treeFolder(tree, segments.slice(0, -1));
  const name = segments[segments.length - 1];
  const at = level ? level.findIndex((e) => e.name === name) : -1;
  if (at < 0) return fail(404, "Luna can't find that anymore. Refresh and try again.");
  const [gone] = level.splice(at, 1);
  // A guest's page has no trash, so the row only has to leave the listing; the
  // answer still names where it went, because the daemon does.
  return {
    ok: true,
    trash_path: `.luna-trash/${nowSec()}-${gone.name}`,
  };
});

post("/s/:token/move", ({ world, params, headers, body }) => {
  const shape = writeShape(body, [["paths", "strings"], ["dest", "optional"]], "PublicMoveBody");
  if (shape.err) return shape.err;
  const fields = shape.values;
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  if (!capSet(r.l.caps).has("edit"))
    return fail(403, "This link doesn't allow changes. Ask for a link that allows editing.");
  if (r.s.kind !== "path") return fail(410, "This link has expired or been removed.");
  if (!fields.paths.length) return fail(400, "Nothing to move.");
  const destSegments = linkSegments(fields.dest ?? "");
  if (!destSegments) return fail(400, "That path isn't inside this share.");
  const tree = guestTree(world, params.token, r.s);
  const trashDest = trashProbe(r.s, destSegments);
  if (trashDest) return trashDest;
  // The destination is resolved the way a source is, so a path that walks
  // through a file ends the whole request at the daemon's catch-all — and on a
  // link to one file the walk starts under that file.
  if (r.s.is_file && destSegments.length) return guestBroke();
  for (let i = 1; i < destSegments.length; i += 1) {
    const midway = nodeAt(tree, destSegments.slice(0, i));
    if (midway && !isFolderNode(midway)) return guestBroke();
  }
  const destRelBase = destSegments.join("/");
  const destIsDir = destSegments.length === 0 || Boolean(treeFolder(tree, destSegments));
  const destExists = destSegments.length === 0 || Boolean(nodeAt(tree, destSegments));
  if (!destExists) return fail(404, "Luna can't find that anymore. Refresh and try again.");
  if (destRelBase && !linkReaches(world, r.l, destRelBase, r.s.drive_id, r.s.path))
    return fail(404, "That item isn't part of this shared link.");
  const destLevel = destSegments.length === 0 ? tree : treeFolder(tree, destSegments);
  const results = [];
  for (const rawPath of fields.paths) {
    const named = mutableSegments(world, r, rawPath);
    // A path outside the share fails the request itself, not just this item:
    // the daemon resolves every source before it moves anything.
    if (named.err) return named.err;
    const { segments } = named;
    const level = treeFolder(tree, segments.slice(0, -1));
    const name = segments[segments.length - 1];
    const at = level ? level.findIndex((e) => e.name === name) : -1;
    if (at < 0) {
      results.push({
        path: rawPath,
        ok: false,
        status: 404,
        error: "Luna can't find that anymore. Refresh and try again.",
      });
      continue;
    }
    // `move_rel` refuses when the item would land where it already is, or
    // inside itself — the destination with the leaf, not the folder alone —
    // before it resolves anything about the destination.
    const toRel = [...destSegments, name].join("/");
    const fromRel = segments.join("/");
    if (toRel === fromRel || toRel.startsWith(`${fromRel}/`)) {
      results.push({
        path: rawPath,
        ok: false,
        status: 400,
        error: "That name isn't allowed here.",
      });
      continue;
    }
    // A destination that is a file meets `ENOTDIR` inside the walk, which the
    // daemon answers with its catch-all rather than a wording of its own.
    if (!destIsDir) {
      results.push({
        path: rawPath,
        ok: false,
        status: 500,
        error: "Luna couldn't do that. Check the drive and try again.",
      });
      continue;
    }
    if (destLevel.some((e) => e.name === name)) {
      results.push({
        path: rawPath,
        ok: false,
        status: 409,
        error: "An item with this name is already here. Choose another name.",
      });
      continue;
    }
    const [node] = level.splice(at, 1);
    destLevel.push(node);
    results.push({ path: rawPath, ok: true });
  }
  const allOk = results.every((x) => x.ok);
  return allOk ? { results } : json({ results }, 207);
});

// `public_stat` gates like every other path route before it answers a size:
// no view is a 403 that names the drop-box link, a non-path subject has closed,
// and the target has to resolve inside the share.
publicGet("/s/:token/stat", ({ world, params, query, headers }) => {
  // `public_stat` takes the same query struct as `/list`, so axum rejects a
  // non-numeric `download` before the handler runs.
  const badDownload = queryInt(query, "download", "u8").error;
  if (badDownload) return badDownload;
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const caps = String(r.l.caps || "").split("+").filter(Boolean);
  const canView = sees(caps);
  if (!canView)
    return fail(403, "This link is for dropping files off — it doesn't open what others have added.");
  if (r.s.kind !== "path") return fail(410, "This link has expired or been removed.");
  const segments = linkSegments(query.path);
  if (!segments) return fail(400, "That path isn't inside this share.");
  const trash = trashProbe(r.s, segments);
  if (trash) return trash;
  const rel = segments.join("/");
  // `public_stat` hands the path to `confined_read`, so a file link asked for
  // anything below the file is a miss with the guest's wording, not the lexical
  // refusal `readable_child` uses for a `..`.
  if (r.s.is_file && segments.length)
    return fail(404, "Luna can't find that anymore. Refresh and try again.");
  // `confined_read` resolves the link root first, so an ejected drive is that
  // same miss rather than a stale size.
  const goneStat = unavailableShare(
    world,
    r.s,
    "Luna can't find that anymore. Refresh and try again.",
  );
  if (goneStat) return goneStat;
  const statRel = String(r.s.path || "").replace(/^\/+|\/+$/g, "");
  const entry = r.s.is_file
    ? { name: r.s.name, kind: "file" }
    : segments.length
      ? nodeAt(treeOf(world, params.token, r.s), segments)
      : // Asking a folder link about its own root asks about the folder itself,
        // so it answers with the folder's name rather than an empty one.
        // A link that sits on the trash asks about a real folder with a
        // minted name, not about the word a page prints for it, and that
        // folder is hidden the way every `.luna-` marker is.
        statRel === ".luna-trash"
          ? { name: trashRealName(world), kind: "dir", size: 0, hidden: true }
          : { name: statRel.split("/").pop(), kind: "dir", size: 0 };
  // `confined_read` words a missing target for the guest rather than saying
  // the path was never there, and a boundary hit is `not_in_share`.
  if (!entry) return fail(404, "Luna can't find that anymore. Refresh and try again.");
  if (!linkReaches(world, r.l, rel, r.s.drive_id, r.s.path))
    return fail(404, "That item isn't part of this shared link.");
  // `files::stat` counts a folder's direct contents unfiltered — a private item
  // inside the share is counted too — so the root's counts come from the tree
  // level itself rather than from what this link may list.
  const level = entry.kind === "dir"
    ? entry.children || (segments.length ? [] : treeOf(world, params.token, r.s))
    : [];
  return {
    name: entry.name,
    kind: entry.kind === "dir" ? "dir" : "file",
    size: entry.size ?? (entry.kind === "dir" ? 0 : 120_000),
    modified: nowSec() - 86400,
    created: nowSec() - 86400 * 30,
    hidden: Boolean(entry.hidden),
    // `CAP_ALL` ("full") includes `CAP_EDIT`, and the share's own root is
    // never writable whatever the capability says: the daemon compares the
    // resolved drive path against the link's own path.
    writable: capSet(caps).has("edit") && [statRel, rel].filter(Boolean).join("/") !== statRel,
    // `public_stat` re-wraps the stat in `json!`, which prints `None` as null,
    // so both keys are always there — null for a file, a count object for a
    // folder, and `totals` (which the daemon never fills) always null.
    children: entry.kind === "dir" ? childCounts(level) : null,
    totals: null,
  };
});

// The file's own bytes. A guest reads these from the link, not the drive API,
// so without this route a link's editor showed "{}" — the router's answer for
// a path nothing matched — as if that were the file's text.
publicGet("/s/:token/file", ({ world, params, query, headers }) => {
  const badFile = queryInt(query, "download", "u8").error;
  if (badFile) return badFile;
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  // Same subject and capability rule as lunad's public_file: only a path link
  // with view access serves bytes. An upload-only link is a drop box, and an
  // answering-only or album link has no file to read — serving one would
  // contradict screens that promise as much.
  const caps = String(r.l.caps || "").split("+").filter(Boolean);
  const canView = sees(caps);
  if (r.s.kind !== "path" || !canView) return fail(410, "This link has expired or been removed.");
  const segments = linkSegments(query.path);
  if (!segments) {
    return fail(400, "That file isn't part of this shared link.");
  }
  const trash = trashProbe(r.s, segments);
  if (trash) return trash;
  // A link to one file has nothing beneath it, so any relative path asks for
  // something that cannot exist — and `public_file` reaches that answer through
  // `confined_read`, so it wears the not-available wording, not the lexical one.
  if (r.s.is_file && segments.length > 0) {
    return fail(404, "The shared file isn't available right now.");
  }
  const rel = segments.join("/");
  const name = segments[segments.length - 1] || r.s.name;
  // A single-file link serves that file. A folder link serves an entry from its
  // tree, resolved against the shared folder: `Holiday/Menu.pdf` must walk into
  // `Holiday`, so a same-named file outside it is not served instead.
  const entry = r.s.is_file
    ? { name: r.s.name || name, kind: "file" }
    : nodeAt(treeOf(world, params.token, r.s), segments);
  if (!entry) return fail(404, "The shared file isn't available right now.");
  // Every shape goes through the boundary check, single-file links included: a
  // link pointing straight at a private file is the easiest one to leak.
  if (!linkReaches(world, r.l, rel, r.s.drive_id, r.s.path))
    return fail(404, "That item isn't part of this shared link.");
  // An ejected drive serves nothing, exactly as it serves nothing over REST.
  // `public_file` passes one wording to `confined_read` whatever the subject is,
  // so a folder share says "file" here too.
  const goneFile = unavailableShare(world, r.s, "The shared file isn't available right now.");
  if (goneFile) return goneFile;
  // `public_file` asks the target what it is and answers a folder with a 400
  // pointing at the zip download, rather than pretending the folder is missing.
  if (entry.kind === "dir") {
    return fail(400, "That's a folder. Use Download to save it as a zip file.");
  }
  // Serve recognisable bytes for the kind, the same ones the drive's own
  // content route hands out, so a shared image or PDF actually previews.
  const nodeFor = (full) => {
    const key = String(full || "").replace(/^\/+|\/+$/g, "");
    if (!key) return null;
    try {
      return fsOf(world, r.s.drive_id || "d1").nodes?.[key] || null;
    } catch {
      return null;
    }
  };
  // The share's own path plus the whole validated relative path: a request for
  // `Holiday/notes.txt` in `Photos` is `Photos/Holiday/notes.txt`, not
  // `Photos/notes.txt`. `rel` was already resolved through the tree above, so
  // it cannot point outside the share.
  const node = nodeFor(r.s.is_file ? r.s.path : [r.s.path, rel].filter(Boolean).join("/"));
  // No drive node behind the name (the built-in folder tree is just names):
  // still answer with something the browser can show for that kind, so a shared
  // image previews and a shared PDF is a PDF rather than text wearing its name.
  const [data, type] = node ? bytesFor(node) : syntheticBytes(entry.name);
  // `serve_file` always names the file: `inline` for the kinds a browser can
  // safely show, `attachment` when the guest asked to download or cannot.
  const download = Number(query.download ?? 0) !== 0;
  return raw(data, type, 200, {
    "Content-Disposition": `${download || !inlineSafe(type) ? "attachment" : "inline"}; filename="${dispositionName(entry.name)}"`,
  });
});

/** `require_link_upload`: a link without the upload capability receives nothing. */
function uploadGate(r) {
  // `CAP_ALL` ("full") includes `CAP_UPLOAD`, so a full-access link receives
  // files even though it never spells "upload".
  if (!capSet(r.l.caps).has("upload"))
    return fail(403, "This link is view-only, so it can't receive files. Ask for a link that allows uploads.");
  return null;
}

post("/s/:token/upload", ({ world, params, headers, body }) => {
  // Axum deserializes the body before the handler runs, so a body that is not
  // the shape the route declares is refused before the limiter counts it and
  // before the link is resolved — no session, no slot used.
  // A body that is the wrong shape is a data error, which axum answers with
  // 422 — a body that is not JSON at all would be a 400, but it never reaches
  // here because the fake's engine already parsed it.
  // Serde renders what it found the way it reads it: `integer \`5\``, `string
  // "x"`, `floating point \`1.5\``, `boolean \`true\``, `sequence`, `map`.
  const shapeHint = (value) => {
    if (value === null) return "null";
    if (Array.isArray(value)) return "sequence";
    if (typeof value === "number")
      return Number.isInteger(value) ? `integer \`${value}\`` : `floating point \`${value}\``;
    if (typeof value === "string") return `string ${JSON.stringify(value)}`;
    if (typeof value === "boolean") return `boolean \`${value}\``;
    return "map";
  };
  const dataErr = (detail) =>
    fail(422, `Failed to deserialize the JSON body into the target type: ${detail}`);
  // A derived struct also reads a sequence positionally, in field order, so
  // `["a", 5]` is a body serde accepts.
  let shape = body;
  if (Array.isArray(body)) {
    // A derived struct reads only its own fields from a sequence; anything left
    // over is trailing characters, which is its own refusal rather than a
    // length. The fake cannot state serde's column, so it stops at the words.
    if (body.length > 3) return dataErr("trailing characters");
    if (body.length < 2)
      return dataErr(
        `invalid length ${body.length}, expected struct PublicUploadCreate with 3 elements`,
      );
    shape = { name: body[0], size: body[1], path: body[2] };
  }
  if (!shape || typeof shape !== "object")
    return dataErr(`invalid type: ${shapeHint(shape)}, expected struct PublicUploadCreate`);
  if (shape.name === undefined) return dataErr("missing field `name`");
  if (typeof shape.name !== "string")
    return dataErr(`name: invalid type: ${shapeHint(shape.name)}, expected a string`);
  if (shape.size === undefined) return dataErr("missing field `size`");
  // A `u64` is a whole number: a float such as `5.0` is refused, and a large
  // integer is left to the size ceiling rather than judged here.
  if (typeof shape.size !== "number" || !Number.isInteger(shape.size) || shape.size < 0)
    return dataErr(`size: invalid type: ${shapeHint(shape.size)}, expected u64`);
  // An integer literal past `u64::MAX` is read as a float by the JSON parser,
  // so it is refused as a type rather than measured against the ceiling.
  if (shape.size >= 2 ** 64)
    return dataErr(`size: invalid type: floating point \`${shape.size}\`, expected u64`);
  if (shape.path !== undefined && shape.path !== null && typeof shape.path !== "string")
    return dataErr(`path: invalid type: ${shapeHint(shape.path)}, expected a string`);
  body = shape;
  // The daemon's share limiter turns away a client that starts too many
  // sessions (5 a minute), before it even resolves the link.
  // A fixed window, not a sliding one: the count resets when the minute that
  // opened the window is over, so five starts just before the turn and five
  // just after all pass.
  const now = nowSec();
  const bucket = (world.uploadWindow ||= { count: 0, start: 0 });
  if (bucket.count === 0 || now - bucket.start >= 60) {
    bucket.count = 1;
    bucket.start = now;
  } else if (bucket.count >= 5) {
    return fail(
      429,
      "Too many uploads from this address just now. Wait a minute and try again.",
    );
  } else {
    bucket.count += 1;
  }
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const denied = uploadGate(r);
  if (denied) return denied;
  if (sharing(world).failUpload) return fail(500, "Luna couldn't save that file.");
  const size = body.size;
  // `public_upload_create` refuses before it opens a session: a size past the
  // 1 TB ceiling, or a name the drive would not take.
  if (size > 1024 ** 4) return fail(400, "Luna can't accept files larger than 1 TB.");
  const name = safeName(body.name);
  if (!name) return fail(400, "That file name can't be used. Try renaming it.");
  // The daemon passes the path through untouched — only a trailing slash is
  // harmless — and a leading one is read as "outside this link".
  const dest = String(body.path ?? "").trim();
  const caps = capSet(r.l.caps);
  // `upload_dest` resolves the destination before a session exists, so a dead
  // drive, a folder outside the link or a file where a folder was named all
  // answer here rather than at complete time.
  let landIn = "";
  let finalName = name;
  if (r.s.kind === "album") {
    // `album_for_link`: the album's own drive has to be there and readable,
    // and it is asked before the name is judged — a dead album answers about
    // the album, not about the file.
    const albumRes = albumFor(world, r.s);
    if (albumRes.err) return albumRes.err;
    // An album holds pictures and video and nothing else, so an upload there
    // has to be one of those or it would land somewhere nobody can open.
    if (!isMediaName(name))
      return fail(400, "Only photos and videos can go in this album.");
  } else {
    const gone = unavailableShare(world, r.s, "The shared folder isn't available right now.");
    if (gone) return gone;
    if (r.s.is_file) {
      // A full-access link to one file replaces that file: the daemon takes the
      // name from the link's own path, not from the request body.
      finalName = safeName(String(r.s.path || "").split("/").pop()) || name;
    } else {
      // Drop boxes always land at the share root — letting a blind uploader
      // name a subfolder would let them probe which folders exist, so the path
      // is dropped rather than refused.
      // Only a folder link with view reads the path at all; an album, a drop
      // box and a link to one file ignore it, so a leading slash there is not
      // refused — there is nothing it could point outside of.
      const asked = caps.has("view") ? dest : "";
      if (asked.startsWith("/")) return fail(400, "That folder isn't part of this shared link.");
      const segments = linkSegments(asked);
      if (!segments) return fail(400, "That folder isn't part of this shared link.");
      const tree = treeOf(world, params.token, r.s);
      const target = nodeAt(tree, segments);
      if (!target) return fail(404, "That folder isn't part of this shared link.");
      if (target.kind !== "dir") return fail(400, "Uploads can only go into a folder.");
      if (!linkReaches(world, r.l, segments.join("/"), r.s.drive_id, r.s.path))
        return fail(404, "That item isn't part of this shared link.");
      landIn = segments.join("/");
    }
  }
  // A session name is held to the create-path bar as well, and that bar is the
  // filesystem's — it runs after the destination is resolved, so a folder that
  // isn't there answers about the folder rather than about the name.
  if (guestInternal([finalName]))
    return fail(500, "Luna couldn't finish that upload. Check the drive and try again.");
  const id = nextId("up");
  // A session outlives the request that made it, and the daemon tells one it
  // never made (404) from one another link owns (403), so the bookkeeping lives
  // on the world rather than in a list beside the link.
  world.uploads ||= {};
  world.uploads[id] = {
    linkId: r.l.id,
    name: finalName,
    size,
    dest: landIn,
    received: 0,
    covered: 0,
    ranges: [],
    state: "open",
  };
  r.l.uploadIds = [...(r.l.uploadIds || []), id];
  return { upload_id: id, received: 0, size, name: finalName };
}, { public: true });
// Every later request proves the session belongs to this link and is still
// running. lunad deletes the session row when an upload finishes or is
// cancelled, so a second request about that id is one it never made (404).
// A session that errored is only refused once the request itself has been read:
// `NotActive` comes from `write_chunk`, after the chunk is validated.
function uploadFor(world, r, id) {
  const up = world.uploads?.[id];
  if (!up) return { err: fail(404, "Luna doesn't know this upload.") };
  if (up.linkId !== r.l.id) return { err: fail(403, "That upload isn't part of this link.") };
  return { err: null, up };
}
put("/s/:token/upload/:id", ({ world, params, headers, raw }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const denied = uploadGate(r);
  if (denied) return denied;
  const found = uploadFor(world, r, params.id);
  if (found.err) return found.err;
  const spec = String(headers["content-range"] ?? "");
  if (!spec)
    return fail(400, "Each chunk needs a Content-Range header (bytes start-end/total).");
  // `strip_prefix("bytes ")` is literal: two spaces is not a range, and
  // everything from the `/` on (the total) is dropped. What is left is parsed
  // against the daemon's one-terabyte file ceiling, not against this session —
  // so a suffix form counts back from a terabyte and lands far past the file,
  // where its length no longer matches and it is refused for that instead.
  const rest = spec.startsWith("bytes ") ? spec.slice(6) : null;
  const range = rest ? rest.split("/")[0] : null;
  if (range === null) return fail(400, "That chunk range isn't valid.");
  const dash = range.indexOf("-");
  if (dash < 0) return fail(400, "That chunk range isn't valid.");
  const startText = range.slice(0, dash);
  const endText = range.slice(dash + 1);
  const ceiling = MAX_FILE_BYTES;
  let start;
  let end;
  if (startText === "") {
    const n = parseU64(endText);
    if (n === null || n === 0n) return fail(400, "That chunk range isn't valid.");
    // A suffix longer than the file counts back from zero and runs to the end
    // of the ceiling, so it fails the length check below rather than parsing.
    start = ceiling - n > 0n ? ceiling - n : 0n;
    end = ceiling - 1n;
  } else {
    start = parseU64(startText);
    if (start === null) return fail(400, "That chunk range isn't valid.");
    if (endText === "") {
      end = ceiling - 1n;
    } else {
      end = parseU64(endText);
      if (end === null) return fail(400, "That chunk range isn't valid.");
    }
  }
  if (start > end || start >= ceiling) return fail(400, "That chunk range isn't valid.");
  if (end > ceiling - 1n) end = ceiling - 1n;
  const expected = end - start + 1n;
  const got = raw ? raw.size ?? raw.byteLength ?? raw.length ?? 0 : 0;
  // Every byte is counted once: a short body would leave a hole that is written
  // out as zeroes, so it is refused instead of accepted.
  if (BigInt(got) !== expected) return fail(400, "The chunk size doesn't match its range.");
  // `upload_chunk_bytes` is the memory budget for one piece; a bigger body is
  // refused with its own status before the bytes are ever written.
  if (got > 16 * 1024 * 1024)
    return fail(
      413,
      "That upload chunk is too large for the free memory on this Luna. Try a smaller piece, or free some space and try again.",
    );
  // `write_chunk` is where a session that already errored is refused, so the
  // chunk above is validated first and this 409 comes after it.
  if (found.up.state === "error")
    return fail(409, "This upload is already finished or cancelled.");
  // `write_chunk` refuses a range that runs past the declared size instead of
  // growing the file beyond what was asked for.
  if (end >= BigInt(found.up.size))
    return fail(400, "The upload isn't complete yet. Check the connection and try again.");
  // Coverage is the union of the ranges written, so out-of-order chunks still
  // add up — a single `max` would forget everything but the widest chunk.
  found.up.ranges.push([Number(start), Number(end)]);
  const merged = [...found.up.ranges].sort((a, b) => a[0] - b[0]);
  let covered = 0;
  let openEnd = -1;
  for (const [from, to] of merged) {
    if (to <= openEnd) continue;
    covered += to - Math.max(from, openEnd + 1) + 1;
    openEnd = to;
  }
  found.up.covered = covered;
  found.up.received = Math.max(found.up.received, Number(end) + 1);
  return { upload_id: params.id, received: found.up.received };
}, { public: true });
post("/s/:token/upload/:id/complete", ({ world, params, query, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const denied = uploadGate(r);
  if (denied) return denied;
  const found = uploadFor(world, r, params.id);
  if (found.err) return found.err;
  const up = found.up;
  if (up.state === "error")
    return fail(409, "This upload is already finished or cancelled.");
  // `uploads::complete` installs nothing until every byte is there, so a session
  // that skipped a chunk is refused rather than written out with a hole — and a
  // refused complete marks the session errored, so it cannot be retried.
  if (up.covered < up.size) {
    up.state = "error";
    return fail(400, "The upload isn't complete yet. Check the connection and try again.");
  }
  const caps = capSet(r.l.caps);
  // A guest who can see the folder gets a refusal on a taken name; a guest who
  // cannot (a drop box, an album) gets a new name instead, because a refusal
  // would tell them which names are already there.
  const overwrite = String(query.overwrite ?? "") === "1" && caps.has("edit");
  const keepBoth = String(query.keep_both ?? "") === "1" && !overwrite;
  let finalName = up.name;
  if (destTaken(world, r, up.dest, finalName) && !overwrite) {
    if (!caps.has("view") || keepBoth) finalName = freeName(world, r, up.dest, finalName);
    else
      return fail(
        409,
        "A file with this name is already here. Rename it or choose another.",
        "exists",
      );
  }
  delete world.uploads[params.id];
  r.l.uploads = (r.l.uploads || 0) + 1;
  r.l.uploadIds = (r.l.uploadIds || []).filter((x) => x !== params.id);
  // `public_upload_complete` answers with the finished file — a `FileEntry`,
  // which carries none of the stat-only fields.
  return {
    name: finalName,
    kind: "file",
    size: up.size || 0,
    modified: nowSec(),
    hidden: false,
  };
}, { public: true });
del("/s/:token/upload/:id", ({ world, params, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const denied = uploadGate(r);
  if (denied) return denied;
  // `uploads::cancel` does not look at the session state: cancelling an upload
  // whose complete failed is how a guest clears it out.
  const session = world.uploads?.[params.id];
  if (!session) return fail(404, "Luna doesn't know this upload.");
  if (session.linkId !== r.l.id) return fail(403, "That upload isn't part of this link.");
  // Cancelling drops the session, so the id is unknown afterwards, exactly as
  // it is after a finished upload.
  delete world.uploads[params.id];
  r.l.uploadIds = (r.l.uploadIds || []).filter((x) => x !== params.id);
  return { ok: true };
}, { public: true });

/** Is there already something at the upload's destination? */
function destTaken(world, r, dest, name) {
  const key = [r.s.path, dest, name].filter(Boolean).join("/").replace(/^\/+|\/+$/g, "");
  try {
    return Boolean(fsOf(world, r.s.drive_id || "d1").nodes?.[key]);
  } catch {
    return false;
  }
}

/** The `"name (1).ext"` a view-blind upload lands on when the name is taken. */
function freeName(world, r, dest, name) {
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 1; n < 1000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!destTaken(world, r, dest, candidate)) return candidate;
  }
  return name;
}

// Answers to a form link.
// `respond_lookup` resolves the link on the same rails as every other `/s/`
// address — expiry and the password gate included — before it hands back
// answers for an edit token.
get("/s/:token/respond", ({ world, params, query, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  // Only a path subject carrying the answering capability opens a form.
  const gate = respondGate(r.s, r.l.caps);
  if (gate) return gate;
  const busyLookup = respondAllowed(world, "lookup");
  if (busyLookup) return busyLookup;
  const editToken = String(query.edit_token ?? "");
  if (!editToken)
    return fail(400, "That edit link is incomplete. Ask for the full link and try again.");
  // The lookup exists only to power edit mode, so a form that refuses changes
  // answers with its own refusal instead of handing the answers back.
  if (!formAllowsEdits(r.l))
    return fail(403, "This form doesn't let you change answers after you send them.");
  const found = r.l.responses?.find((x) => x.edit_token === editToken);
  return found
    ? { id: found.id, answers: found.answers, ok: true }
    : fail(404, "We couldn't find answers for that edit link.");
}, { public: true });
post("/s/:token/respond", ({ world, params, headers, body }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const gate = respondGate(r.s, r.l.caps);
  if (gate) return gate;
  const busy = respondAllowed(world, "submit");
  if (busy) return busy;
  // A closed form refuses the answer itself, not with a conflict.
  const shut = hardClosed(r.l);
  if (shut) return fail(403, shut);
  const allowEdits = formAllowsEdits(r.l);
  const presented = String(body.edit_token ?? "").trim();
  const targetId = String(body.response_id ?? "").trim();
  // With changes refused, anything shaped like an edit is refused before it
  // can reach the answers.
  if (!allowEdits && (presented || targetId))
    return fail(403, "This form doesn't let you change answers after you send them.");
  if (!body.answers || typeof body.answers !== "object" || Array.isArray(body.answers))
    return fail(400, "Those answers didn't come through whole. Try sending them again.");
  if (
    Object.keys(body.answers).length > 500 ||
    !Object.values(body.answers).every(answerValueOk)
  )
    return fail(400, "Some answers are in a shape Luna can't store. Try again.");
  const list = (r.l.responses ||= []);
  // A presented secret only ever identifies an answer to amend; a target id on
  // its own is an attempt with a missing half of the pair.
  let entry = null;
  if (presented)
    entry =
      list.find(
        (x) => x.edit_token === presented && (!targetId || x.id === targetId),
      ) || null;
  if (presented && !entry)
    return fail(403, "This edit link doesn't match a saved answer on this form.");
  if (!presented && targetId)
    return fail(403, "This edit link doesn't match a saved answer on this form.");
  // Files the answer may name: this respondent's own waiting uploads, or — when
  // editing — files already on this answer.
  const previous = new Set(
    ((entry && formOf(r.l).questions) || [])
      .filter((q) => q?.type === "file" && typeof entry.answers?.[q.id] === "string")
      .map((q) => entry.answers[q.id]),
  );
  let token = presented;
  if (!entry) {
    // The cap is judged before the answers, so a full form says it is full
    // rather than pointing at an answer it will never take.
    const max = formMaxResponses(r.l);
    if (max !== null && list.length >= max)
      return fail(403, "This form has all the answers it can take.");
  }
  // Files the answer may name: this respondent's own waiting uploads for this
  // form, or — when editing — files already on this answer.
  const formId = linkFormKey(r.s);
  const waiting = pendingFor(world, formId);
  sweepPending(waiting);
  const canAttach = (name) => Boolean(waiting[name]) || previous.has(name);
  const shaped = checkAnswers(r.l, body.answers, canAttach);
  if (shaped) return shaped;
  if (!entry) {
    // A new answer always gets a secret the server minted, never one the client
    // offered, so a copied edit link can't be guessed or shared by accident.
    token = nextId("et");
    entry = { id: nextId("r"), at: nowSec(), answers: body.answers, edit_token: token };
    list.push(entry);
  }
  entry.answers = body.answers;
  entry.at = nowSec();
  // An answer that names an attachment claims it: the bytes move out of the
  // waiting queue and count against the form's own folder from then on.
  const sent = sentFor(world, formId);
  const kept = new Set();
  for (const question of formOf(r.l).questions || []) {
    if (question?.type !== "file") continue;
    const name = entry.answers?.[question.id];
    if (typeof name !== "string") continue;
    kept.add(name);
    if (!waiting[name]) continue;
    sent[name] = waitingSize(waiting[name]);
    delete waiting[name];
  }
  // An edit that swapped or removed a file drops the old one and frees room.
  for (const name of previous) {
    if (kept.has(name)) continue;
    delete sent[name];
  }
  // The form's owner sees the same answers on the Files side.
  const fk = r.s.drive_id ? formKey({ drive_id: r.s.drive_id, path: r.s.path }) : null;
  if (fk) formsOf(world)[fk] = list.map((x) => ({ id: x.id, at: x.at, answers: x.answers }));
  // Edit material only exists when the form allows changes; a form that doesn't
  // saves the record but never hands the secret back.
  return { ok: true, id: entry.id, edit_token: allowEdits ? token : null };
}, { public: true });
// `POST /s/:token/respond-file` — a picture or PDF waiting to be named by an
// answer. It is not storage: only a form with a file question takes one.
post("/s/:token/respond-file", async ({ world, params, headers, raw }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const gate = respondGate(r.s, r.l.caps);
  if (gate) return gate;
  const busyFile = respondAllowed(world, "upload");
  if (busyFile) return busyFile;
  // An upload on a closed form says only that it is closed — the daemon does
  // not repeat which date passed here.
  if (hardClosed(r.l)) return fail(403, "This form isn't collecting answers anymore.");
  const questions = formOf(r.l).questions || [];
  if (!questions.some((q) => q && q.type === "file"))
    return fail(400, "This form doesn't ask for files.");
  // A body with no `file` part is not a file of the wrong kind — it is nothing
  // to attach — but a `file` part with no name has a kind Luna can't read.
  const hasPart = Boolean(raw && typeof raw.has === "function" && raw.has("file"));
  const file = hasPart && typeof raw.get === "function" ? raw.get("file") : null;
  if (!hasPart) return fail(400, "Choose a file to attach.");
  const filename = typeof file === "string" ? "" : typeof file?.name === "string" ? file.name : "";
  const ext = ATTACH_EXTS[filename.split(".").pop()?.toLowerCase()] || null;
  if (!ext) return fail(400, ATTACH_KIND_MESSAGE);
  const size = Number(file.size) || 0;
  if (size > 10 * 1024 * 1024)
    return fail(413, "That file is over 10 MB. Choose a smaller one.");
  // An empty part is its own refusal: there is nothing to keep.
  if (size === 0)
    return fail(400, "That file was empty. Choose another one and try again.");
  const bytes = new Uint8Array(await (file?.arrayBuffer ? file.arrayBuffer() : []));
  if (!contentMatches(ext, bytes)) return fail(400, ATTACH_KIND_MESSAGE);
  // Two ceilings, two folders: the waiting queue of unsent attachments has its
  // own limit, and the form's whole attachment folder (sent and unsent) has a
  // bigger one. A form can therefore be full of sent files and still take an
  // upload, which one shared counter could not say.
  const formId = linkFormKey(r.s);
  const waiting = pendingFor(world, formId);
  const sent = sentFor(world, formId);
  sweepPending(waiting);
  const pending = Object.values(waiting).reduce((a, b) => a + waitingSize(b), 0);
  if (pending + size > 256 * 1024 * 1024)
    return fail(
      503,
      "Lots of files are arriving on this form right now. Wait a few minutes and attach it again.",
    );
  const pictures = picturesFor(world, formId);
  const used =
    pending +
    Object.values(sent).reduce((a, b) => a + b, 0) +
    Object.values(pictures).reduce((a, b) => a + b, 0);
  if (used + size > 2 * 1024 ** 3)
    return fail(
      507,
      "This form has no room for more files. Ask the person who shared it to clear some out.",
    );
  const name = `${mintHex(16)}.${ext}`;
  waiting[name] = { size, at: nowSec() };
  return { ok: true, name };
}, { public: true });
get("/s/:token/form-image", () => json({}), { public: true });

