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
//            downloads, form, kind, created_by }
//
// Links follow lunad's rule (api/access/access_admin.rs): they belong to the item. Read
// (my_caps has view, or the share bit) sees them all; Write (view plus upload or edit, or the
// share bit) makes them and manages any link within its own caps, whoever made it.
import { del, fail, get, json, patch, post, put, raw } from "../engine.js";
import { nextId } from "../world.js";
import { photoKey } from "../photos.js";
import { CAP, CAP_MANAGE, canMakeLinks, canSeeLinks, capsBits, capsCover } from "../../../lib/access.js";

const sharing = (w) => {
  if (!w.sharing) w.sharing = { subjects: [], withMe: [] };
  return w.sharing;
};
const nowSec = () => Math.floor(Date.now() / 1000);
const userName = (w, id) => w.users.find((u) => u.id === id)?.display_name || "Someone";
const driveLabel = (w, id) => w.drives.find((d) => d.id === id)?.label || id;
const itemCount = (w, s) => s.kind === "album" ? (w.albumItems?.[s.album_id] || []).length : Number(Boolean(s.is_file));

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
  const album = isAlbum ? w.albums.find((a) => a.id === q.album_id && a.home_drive_id === q.drive_id) : null;
  if (isAlbum && !album) return null;
  const created = {
    kind: isAlbum ? "album" : "path",
    drive_id: q.drive_id,
    drive_label: driveLabel(w, q.drive_id),
    path: q.path || "",
    album_id: q.album_id || "",
    name: isAlbum ? album.name : pathName(q.path) || driveLabel(w, q.drive_id),
    is_file: /\.[A-Za-z0-9]{1,5}$/.test(q.path || ""),
    owner_id: isAlbum ? album.owner_user_id : user.id,
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
  can_manage: s.kind === "album" ? canRetuneAlbumMember(s, m, me) : s.my_caps.includes("share"),
  can_remove: m.user_id === me.id || (s.kind === "album"
    ? capsBits(s.my_caps) === CAP_MANAGE || (s.my_caps.includes("share") && strictCover(capsBits(s.my_caps), m.caps))
    : s.my_caps.includes("share")),
});
function callerCaps(w, s, user) {
  if (s.kind !== "album") return capsBits(s.my_caps);
  if (s.owner_id === user.id || user.role === "admin") return CAP_MANAGE;
  const grant = s.members.find((m) => m.user_id === user.id);
  if (grant) return capsBits(grant.caps);
  const album = w.albums.find((a) => a.id === s.album_id && a.home_drive_id === s.drive_id);
  return album?.shared_with?.includes(user.id) ? CAP.VIEW : 0;
}

const albumContentCaps = (caps) => [CAP.VIEW, CAP.UPLOAD, CAP.VIEW | CAP.UPLOAD].includes(caps);
const wireCaps = (bits) => {
  if (bits === CAP_MANAGE) return "full+share";
  const base = { 1: "view", 2: "upload", 3: "view+upload" }[bits & ~CAP.SHARE] || "none";
  return bits & CAP.SHARE ? `${base}+share` : base;
};
const forCaller = (w, s, user) =>
  s.kind === "album" ? { ...s, my_caps: wireCaps(callerCaps(w, s, user)) } : s;
const strictCover = (mine, want) => mine !== capsBits(want) && capsCover(mine, want);
function canRetuneAlbumMember(s, m, user) {
  const mine = capsBits(s.my_caps);
  if (m.user_id === user.id) return capsCover(mine, m.caps);
  return mine === CAP_MANAGE || ((mine & CAP.SHARE) !== 0 && strictCover(mine, m.caps));
}

const managesLink = (s, l) => {
  const mine = capsBits(s.my_caps);
  const want = capsBits(l.caps);
  const covers = want === CAP.RESPOND ? (mine & (CAP.UPLOAD | CAP.EDIT)) !== 0 : capsCover(mine, want);
  return canMakeLinks(s.my_caps) && covers;
};
const linkRow = (s, l) => ({
  id: l.id,
  caps: l.caps,
  has_password: Boolean(l.password),
  created_at: l.created_at ?? 0,
  created_by: l.created_by ?? s.owner_id,
  expires_at: l.expires_at ?? null,
  // The address only goes to people who may manage the link.
  url: managesLink(s, l) ? `/s/${l.token}` : null,
  can_manage: managesLink(s, l),
});

get("/api/v1/access/subject", ({ world, user, query }) => {
  const stored = subjectFor(world, user, query);
  if (!stored) return fail(404, "That album no longer exists.");
  const s = forCaller(world, stored, user);
  if (s.hidden || (s.kind === "album" && !capsBits(s.my_caps))) return fail(403, "You don't have access to this.");
  return {
    subject: { kind: s.kind, name: s.name, path: s.path, is_file: s.is_file, private: s.private, private_folder: Boolean(s.private_folder), album_id: s.album_id, drive_id: s.drive_id, exists: s.exists !== false, item_count: itemCount(world, s), owner: s.owner_id },
    my_caps: s.my_caps,
    private: s.private,
    link_count: s.links.length,
    member_count: s.members.length,
    // Like lunad, the roster only goes to callers with the share bit.
    members: s.my_caps.includes("share") ? s.members.map((m) => memberRow(world, s, m, user)) : [],
    links: canSeeLinks(s.my_caps) ? s.links.map((l) => linkRow(s, l)) : [],
    inherited_members: s.inherited_members || [],
    inherited_links: s.inherited_links || [],
  };
});

post("/api/v1/access/members", ({ world, user, body }) => {
  const sh = sharing(world);
  if (sh.failAdd) return fail(500, "Luna couldn't add that person.");
  const s = subjectFor(world, user, body);
  if (!s) return fail(404, "That album no longer exists.");
  const mine = callerCaps(world, s, user);
  if (!(mine & CAP.SHARE)) return fail(403, "You can't share this.");
  if (s.kind === "album") {
    const want = capsBits(body.caps || "view");
    if (!albumContentCaps(want & ~CAP.SHARE)) return fail(400, "That access level doesn't apply here.");
    if (mine !== CAP_MANAGE && !strictCover(mine, want)) return fail(403, "You can only give less access than you have.");
  }
  if (!world.users.some((u) => u.id === body.user_id)) return fail(404, "That person no longer has an account.");
  if (s.members.some((m) => m.user_id === body.user_id)) return fail(409, "That person already has access.");
  const m = { id: nextId("m"), user_id: body.user_id, caps: body.caps || "view" };
  s.members.push(m);
  delete s.pristine;
  if (s.kind === "album") {
    const album = world.albums.find((a) => a.id === s.album_id);
    if (album) album.shared_with = [...(album.shared_with || []), body.user_id];
  }
  return memberRow(world, forCaller(world, s, user), m, user);
});

function findMember(w, id) {
  for (const s of sharing(w).subjects) {
    const m = s.members.find((x) => x.id === id);
    if (m) return { s, m };
  }
  return null;
}
patch("/api/v1/access/members/:id", ({ world, user, params, body }) => {
  const hit = findMember(world, params.id);
  if (!hit) return fail(404, "That person's access is already gone.");
  if (hit.s.kind === "album") {
    const mine = callerCaps(world, hit.s, user);
    const want = capsBits(body.caps);
    if (!albumContentCaps(want & ~CAP.SHARE)) return fail(400, "That access level doesn't apply here.");
    const allowed = hit.m.user_id === user.id
      ? capsCover(hit.m.caps, want) || (capsCover(mine, hit.m.caps) && capsCover(mine, want))
      : mine === CAP_MANAGE || ((mine & CAP.SHARE) && strictCover(mine, hit.m.caps) && strictCover(mine, want));
    if (!allowed) return fail(403, "You can't change access at or above your own level.");
  }
  hit.m.caps = body.caps;
  return {};
});
del("/api/v1/access/members/:id", ({ world, user, params }) => {
  const hit = findMember(world, params.id);
  if (hit) {
    if (hit.s.kind === "album" && hit.m.user_id !== user.id) {
      const mine = callerCaps(world, hit.s, user);
      if (!(mine & CAP.SHARE) || !strictCover(mine, hit.m.caps)) {
        return fail(403, "You can't remove access wider than your own.");
      }
    }
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
  const subject = forCaller(world, s, user);
  if (!canMakeLinks(subject.my_caps)) return fail(403, "You can make links only for things you can change.");
  if (s.kind === "album") {
    if (!albumContentCaps(capsBits(body.caps))) return fail(400, "That access level doesn't apply here.");
    if (!managesLink(subject, body)) return fail(403, "You can only share access you already have.");
  }
  const l = {
    id: nextId("ln"),
    token: `t${Math.random().toString(36).slice(2, 10)}${nextId("")}`,
    caps: body.caps,
    password: body.password || "",
    expires_at: body.expires_in_days ? nowSec() + body.expires_in_days * 86400 : null,
    created_by: user.id,
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
patch("/api/v1/access/links/:id", ({ world, user, params, body }) => {
  const hit = findLink(world, params.id);
  if (!hit) return fail(404, "That link no longer exists.");
  const subject = forCaller(world, hit.s, user);
  if (!managesLink(subject, hit.l)) return fail(403, "You can't change this link.");
  if (body.caps !== undefined && hit.s.kind === "album" && !albumContentCaps(capsBits(body.caps))) {
    return fail(400, "That access level doesn't apply here.");
  }
  if (body.caps !== undefined && !managesLink(subject, { caps: body.caps })) {
    return fail(403, "You can't give a link more access than you have.");
  }
  if (body.caps !== undefined) hit.l.caps = body.caps;
  if (body.expires_in_days !== undefined) hit.l.expires_at = body.expires_in_days ? nowSec() + body.expires_in_days * 86400 : null;
  if (body.password !== undefined) hit.l.password = body.password || "";
  return {};
});
del("/api/v1/access/links/:id", ({ world, user, params }) => {
  const hit = findLink(world, params.id);
  if (!hit) return fail(404, "That link is already gone.");
  if (!managesLink(forCaller(world, hit.s, user), hit.l)) return fail(403, "You can't remove this link.");
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
  // Extra "shared with you" rows have no share-sheet subject behind them, so a
  // scenario may seed only a few keys (the dashboard's nine album rows name just
  // id/kind/drive/album/name/caps/exists). lunad always sends every key, so fill
  // the rest explicitly rather than letting the seed decide the response shape.
  return [...rows, ...sh.withMe.map((r) => {
    const row = { created_by: "", ...r };
    return {
      ...row,
      drive_label: row.drive_label ?? driveLabel(w, row.drive_id),
      path: row.path ?? "",
      is_file: row.is_file ?? false,
      shared_by: row.shared_by ?? "",
    };
  })];
}

get("/api/v1/access/mine", ({ world, user }) => {
  const sh = sharing(world);
  const sharingRows = sh.subjects
    .filter((s) => !s.pristine && (s.owner_id === user.id || user.role === "admin") && (s.members.length || s.links.length || s.keepEmpty))
    .map((s) => forCaller(world, s, user))
    .map((s) => ({
      kind: s.kind, drive_id: s.drive_id, drive_label: s.drive_label, path: s.path, album_id: s.album_id,
      name: s.name, is_file: s.is_file, exists: s.exists !== false,
      item_count: itemCount(world, s),
      my_caps: s.my_caps,
      members: s.members.map((m) => ({ id: m.id, user_id: m.user_id, name: userName(world, m.user_id), caps: m.caps })),
      links: canSeeLinks(s.my_caps) ? s.links.map((l) => linkRow(s, l)) : [],
    }));
  return { sharing: sharingRows, with_me: myRows(world, user) };
});

get("/api/v1/me/access", ({ world, user }) => [
  // Grants made straight on the world apply to the person named in `user_id`, or to any Member when none is named.
  ...(world.access || []).filter((r) => !r.user_id || r.user_id === user.id).map(({ user_id: _who, ...row }) => ({
    // Seeds often name only the drive and path; lunad fills these in too, and
    // the Files card needs them for its title and breadcrumb.
    id: row.id ?? "", kind: row.kind ?? "path", album_id: row.album_id ?? "", drive_id: row.drive_id ?? "", drive_label: row.drive_label ?? driveLabel(world, row.drive_id),
    path: row.path ?? "", name: row.name ?? pathName(row.path), is_file: row.is_file ?? false, caps: row.caps,
    created_by: row.created_by ?? "", shared_by: row.shared_by ?? "", exists: row.exists !== false,
  })),
  // Rows from shares: the full "shared with you" row shape.
  ...myRows(world, user),
]);

// ── Forms (signed-in side) ──────────────────────────────────────────────────
const formsOf = (w) => (w.forms ||= {});
const formKey = (q) => `${q.drive_id}\0${q.path}`;
function formPage(list, query) {
  const offset = Math.max(0, Number(query.offset) || 0);
  const limit = Math.min(500, Math.max(1, Number(query.limit) || 100));
  const responses = list.slice(offset, offset + limit);
  const next = offset + responses.length;
  return {
    responses,
    total: list.length,
    next_offset: next < list.length ? next : null,
    revision: 0,
  };
}

function formSummary(list) {
  const byQuestion = new Map();
  for (const rec of list) {
    for (const [id, value] of Object.entries(rec.answers || {})) {
      let entry = byQuestion.get(id);
      if (!entry) {
        entry = { id, answered: 0, values: new Map() };
        byQuestion.set(id, entry);
      }
      entry.answered += 1;
      const key = JSON.stringify(value ?? null);
      entry.values.set(key, (entry.values.get(key) || 0) + 1);
    }
  }
  return {
    total: list.length,
    questions: [...byQuestion.values()].map((entry) => ({
      id: entry.id,
      answered: entry.answered,
      values: [...entry.values].map(([key, count]) => ({
        value: JSON.parse(key),
        count,
      })),
    })),
  };
}

get("/api/v1/forms/responses", ({ world, query }) => {
  const list = formsOf(world)[formKey(query)] || [];
  if (query.count) return { count: list.length };
  if (query.id) {
    const r = list.find((x) => x.id === query.id);
    return r ? r : fail(404, "That answer is gone.");
  }
  return formPage(list, query);
});
get("/api/v1/forms/summary", ({ world, query }) => {
  const list = formsOf(world)[formKey(query)] || [];
  return formSummary(list);
});
get("/api/v1/forms/usage", () => ({ used_bytes: 0, quota_bytes: 512 * 1024 * 1024, free_bytes: 0 }));
del("/api/v1/forms/responses", ({ world, query }) => {
  const k = formKey(query);
  if (query.clear) {
    formsOf(world)[k] = [];
    return {};
  }
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
function open(w, token, headers) {
  const hit = lookup(w, token);
  if (!hit) return { err: fail(404, "Not found.") };
  const { s, l } = hit;
  if (l.disabled) return { err: fail(403, "This link has been turned off.") };
  if (l.expires_at && l.expires_at < nowSec()) return { err: fail(410, "This link has expired or been removed.") };
  let supplied = header(headers, "x-share-password");
  const encoded = header(headers, "x-share-password-utf8");
  if (encoded) {
    try {
      supplied = new TextDecoder().decode(Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0)));
    } catch {
      supplied = null;
    }
  }
  if (l.password && supplied !== l.password) return { err: fail(401, "This link needs its password.") };
  // Gallery-only simulated state: real lunad has no download counter on access
  // links, so this gate can't be reached outside the fake. Checked on every
  // open, including the first meta request, so the page says so up front
  // instead of offering downloads that would fail.
  if (l.download_limit != null && (l.downloads || 0) >= l.download_limit) {
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
        settings: { allowEdits: true, collecting: true },
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
  if (!(capsBits(r.l.caps) & CAP.VIEW)) return fail(403, "This link only lets you add photos.");
  const keys = new Set(world.albumItems?.[r.s.album_id] || []);
  const all = (world.photos || []).filter((p) => keys.has(photoKey(p)));
  const limit = Number(query.limit) || 80;
  const offset = Number(query.offset) || 0;
  const items = all.slice(offset, offset + limit).map((p) => ({ ...p, download: p.content }));
  return { items, has_more: offset + items.length < all.length, next_offset: offset + items.length };
});

publicGet("/s/:token/list", ({ world, params, headers }) => {
  const r = open(world, params.token, headers);
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
  return r ? { id: r.id, answers: r.answers, ok: true } : fail(404, "Luna can't find answers for that edit link.");
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

// A shared file's bytes. A plain open reads them as text; `download=1` is the
// browser's Save path and needs a filename, not a JSON envelope.
get("/s/:token/file", ({ world, params, headers, query }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const name = pathName(query.path) || r.s.name || "download";
  const bytes = new TextEncoder().encode(`${r.s.name || "File"} — shared from Luna.\n`);
  return raw(bytes, "text/plain; charset=utf-8", 200, query.download === "1"
    ? { "Content-Disposition": `attachment; filename="${name}"` }
    : {});
}, { public: true });

// Album downloads point here; a small zip payload is all the fake needs.
get("/s/:token/zip", ({ world, params, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const name = r.s.name || "album";
  return raw(new Uint8Array(22), "application/zip", 200, {
    "Content-Disposition": `attachment; filename="${name}.zip"`,
  });
}, { public: true });

