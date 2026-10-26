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
//   link = { id, token, caps, password, has_password, expires_at, disabled, download_limit,
//            downloads, form, kind }
import { del, fail, get, json, patch, post, put } from "../engine.js";
import { nextId } from "../world.js";
import { photoKey } from "../photos.js";

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
  if (body.password !== undefined) hit.l.password = body.password || "";
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
  return [...rows, ...sh.withMe];
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
get("/api/v1/forms/responses", ({ world, query }) => {
  const list = formsOf(world)[formKey(query)] || [];
  if (query.count) return { count: list.length };
  if (query.id) {
    const r = list.find((x) => x.id === query.id);
    return r ? r : fail(404, "That answer is gone.");
  }
  return { responses: list };
});
del("/api/v1/forms/responses", ({ world, query }) => {
  const k = formKey(query);
  formsOf(world)[k] = (formsOf(world)[k] || []).filter((x) => x.id !== query.id);
  return {};
});
get("/api/v1/forms/file", () => json({}));
post("/api/v1/forms/picture", ({ body }) => ({ name: pathName(body.source) || "picture.png" }));
post("/api/v1/forms/picture-upload", ({ body }) => ({ name: body.file?.name || "picture.png" }));
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

/** Runs every check a real link goes through; returns an error answer or the link. */
function open(w, token, headers, { download = false } = {}) {
  const hit = lookup(w, token);
  if (!hit) return { err: fail(404, "Not found.") };
  const { s, l } = hit;
  if (l.disabled) return { err: fail(403, "This link has been turned off.") };
  if (l.expires_at && l.expires_at < nowSec()) return { err: fail(410, "This link has expired.") };
  if (l.password && header(headers, "x-share-password") !== l.password) return { err: fail(401, "This link needs its password.") };
  if (download && l.download_limit != null && (l.downloads || 0) >= l.download_limit) {
    return { err: fail(403, "This link has reached its download limit.") };
  }
  return { s, l };
}

function treeOf(w, token, s) {
  const t = sharing(w).tree?.[token];
  if (t) return t;
  return [
    { name: "Holiday", kind: "dir", size: 0, modified: nowSec() - 86400 * 30, hidden: false },
    { name: "Menu.pdf", kind: "file", size: 220_000, modified: nowSec() - 86400 * 3, hidden: false },
    { name: `${s.name}-notes.txt`, kind: "file", size: 1200, modified: nowSec() - 3600, hidden: false },
  ];
}

const publicGet = (p, h) => get(p, h, { public: true });

publicGet("/s/:token", ({ world, params, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const { s, l } = r;
  if (l.caps === "respond") {
    return {
      kind: "form",
      form: l.form || {
        title: s.name,
        version: 1,
        questions: [
          { id: "q1", type: "short_text", label: "Your name", required: true },
          { id: "q2", type: "choice", label: "Can you come?", required: true, config: { options: ["Yes", "No", "Maybe"] } },
          { id: "q3", type: "long_text", label: "Anything we should know?" },
        ],
        settings: { allowEdits: false, collecting: true },
      },
      accepting: l.accepting !== false,
      full: Boolean(l.full),
      closed_message: l.closed_message || "",
    };
  }
  const kind = s.kind === "album" ? "album" : s.is_file ? "file" : l.caps === "upload" ? "dropbox" : "folder";
  const count = s.kind === "album" ? (world.albumItems?.[s.album_id] || []).length : undefined;
  return { kind, name: s.name, caps: l.caps, size: s.is_file ? 120_000 : undefined, item_count: count };
});

publicGet("/s/:token/items", ({ world, params, query, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const keys = new Set(world.albumItems?.[r.s.album_id] || []);
  const all = (world.photos || []).filter((p) => keys.has(photoKey(p)));
  const limit = Number(query.limit) || 80;
  const offset = Number(query.offset) || 0;
  const items = all.slice(offset, offset + limit).map((p) => ({ ...p, download: p.content }));
  return { items, has_more: offset + items.length < all.length, next_offset: offset + items.length };
});

publicGet("/s/:token/list", ({ world, params, headers }) => {
  const r = open(world, params.token, headers, { download: true });
  if (r.err) return r.err;
  return { entries: treeOf(world, params.token, r.s) };
});
publicGet("/s/:token/stat", ({ world, params, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  return { name: r.s.name, kind: r.s.is_file ? "file" : "dir", size: 120_000, modified: nowSec() - 86400, children: null, created: nowSec() - 86400 * 30, hidden: false, totals: null, writable: false };
});

post("/s/:token/upload", ({ world, params, headers, body }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  if (sharing(world).failUpload) return fail(500, "Luna couldn't save that file.");
  return { upload_id: nextId("up"), name: body.name };
}, { public: true });
put("/s/:token/upload/:id", () => ({}), { public: true });
post("/s/:token/upload/:id/complete", ({ world, params }) => {
  const hit = lookup(world, params.token);
  if (hit) hit.l.uploads = (hit.l.uploads || 0) + 1;
  return {};
}, { public: true });
del("/s/:token/upload/:id", () => ({}), { public: true });

// Answers to a form link.
get("/s/:token/respond", ({ world, params, query }) => {
  const hit = lookup(world, params.token);
  const r = hit?.l.responses?.find((x) => x.edit_token === query.edit_token);
  return r ? { id: r.id, answers: r.answers, ok: true } : fail(404, "We couldn't find answers for that edit link.");
}, { public: true });
post("/s/:token/respond", ({ world, params, headers, body }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  if (r.l.accepting === false) return fail(409, "This form isn't collecting answers anymore.");
  const id = body.response_id || nextId("r");
  const list = (r.l.responses ||= []);
  const entry = { id, at: nowSec(), answers: body.answers, edit_token: body.edit_token };
  const at = list.findIndex((x) => x.id === id);
  if (at >= 0) list[at] = entry; else list.push(entry);
  // The form's owner sees the same answers on the Files side.
  const fk = r.s.drive_id ? formKey({ drive_id: r.s.drive_id, path: r.s.path }) : null;
  if (fk) formsOf(world)[fk] = list.map((x) => ({ id: x.id, at: x.at, answers: x.answers }));
  return { id, edit_token: body.edit_token };
}, { public: true });
post("/s/:token/respond-file", () => ({ name: "attachment.png" }), { public: true });
get("/s/:token/form-image", () => json({}), { public: true });
get("/s/:token/file", () => json({}), { public: true });

