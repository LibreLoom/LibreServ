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
import { driveRow, fsOf } from "../fsmodel.js";

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
    const given = header(headers, "x-share-password");
    const unlocked = proofs.get(l.id) === l.password;
    if (given && given === l.password) proofs.set(l.id, l.password);
    else if (!unlocked) return { err: fail(401, "This link needs its password.") };
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
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const { s, l } = r;
  if (l.caps === "respond") {
    // `respond_document` names the permission as well as the form: the page
    // reads it to know an answer is what this link is for.
    return {
      kind: "form",
      permission: "respond",
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
  // A link with no view capability is a drop box: `public_root_inner` sends it
  // straight to `{kind:"dropbox", caps}` and never lets it name what it points
  // at, because the whole promise of the link is that the uploader sees
  // nothing. Asking it for a path is refused rather than ignored.
  const caps = String(l.caps || "").split("+").filter(Boolean);
  const canView = caps.includes("view") || caps.includes("full") || caps.includes("read");
  if (s.kind !== "album" && !canView) {
    if (String(query.path ?? "").trim()) return fail(400, "That folder isn't part of this shared link.");
    return { kind: "dropbox", caps: l.caps };
  }
  const kind = s.kind === "album" ? "album" : s.is_file ? "file" : "folder";
  const count = s.kind === "album" ? (world.albumItems?.[s.album_id] || []).length : undefined;
  // `public_root_inner` resolves a viewable path subject through
  // `confined_read`. A link whose drive is gone therefore answers with the
  // unavailable wording, not with a shell that mounts a browser over nothing.
  if (kind === "file" || kind === "folder") {
    const goneRoot = unavailableShare(world, s, "The shared files aren't available right now.");
    if (goneRoot) return goneRoot;
  }
  // `public_root_inner` names a path subject after the last piece of its own
  // path, not after something it invented: a whole-drive link (empty path)
  // falls through to "download", and a trash entry is spelled "Trash" because
  // its on-disk name carries a nonce.
  const linkRel = String(s.path || "").replace(/^\/+|\/+$/g, "");
  const rootName =
    linkRel === ".luna-trash" ? "Trash" : linkRel ? linkRel.split("/").pop() : "download";
  return {
    kind,
    name: kind === "album" ? s.name : rootName,
    caps: l.caps,
    size: s.is_file ? 120_000 : undefined,
    item_count: count,
  };
});

publicGet("/s/:token/items", ({ world, params, query, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  // lunad's `public_items` answers `gone()` for any link that is not a viewable
  // album, so a folder, file or drop box share has no photo page at all.
  const itemCaps = String(r.l.caps || "").split("+").filter(Boolean);
  const itemCanView = itemCaps.includes("view") || itemCaps.includes("full") || itemCaps.includes("read");
  if (r.s.kind !== "album" || !itemCanView) return fail(410, "This link has expired or been removed.");
  const keys = new Set(world.albumItems?.[r.s.album_id] || []);
  const all = (world.photos || []).filter((p) => keys.has(photoKey(p)));
  const limit = Number(query.limit) || 80;
  const offset = Number(query.offset) || 0;
  // `album_media_urls` names the guest bytes route, so a public photo is never
  // fetched from the signed-in drive API. The gallery's pictures come back
  // through `/s/:token/media`, exactly as they would from the daemon — the
  // media URLs below are the only difference from the drive's own item shape.
  const mediaUrl = (p, variant) =>
    `/s/${encodeURIComponent(params.token)}/media?drive_id=${encodeURIComponent(p.drive_id || "d1")}` +
    `&path=${encodeURIComponent(p.path || "")}&variant=${variant}`;
  const items = all.slice(offset, offset + limit).map((p) => ({
    ...p,
    thumb: mediaUrl(p, "thumb"),
    content: mediaUrl(p, "content"),
    download: mediaUrl(p, "download"),
  }));
  return {
    kind: "album",
    name: r.s.name,
    item_count: all.length,
    caps: r.l.caps,
    items,
    has_more: offset + items.length < all.length,
    next_offset: offset + items.length,
  };
});

// `GET /s/:token/media` — the guest's own bytes for one album photo. Without
// this the album page's pictures load from a route lunad doesn't serve.
publicGet("/s/:token/media", ({ world, params, query, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  // Same gate as `public_media`: anything that is not a viewable album closes,
  // it does not answer bytes.
  const caps = String(r.l.caps || "").split("+").filter(Boolean);
  const canView = caps.includes("view") || caps.includes("full") || caps.includes("read");
  if (r.s.kind !== "album" || !canView) return fail(410, "This link has expired or been removed.");
  const path = String(query.path || "");
  // `album_for_link` resolves the album's own drive before the photo is looked
  // up, and each failure has its own sentence: unknown, unplugged, unreadable.
  const albumDrive = r.s.drive_id || "d1";
  try {
    needDrive(world, albumDrive);
  } catch (e) {
    if (e?.body?.code === "missing_drive_db")
      return fail(500, "Luna couldn't read this album.");
    if (!driveRow(world, albumDrive)) return fail(404, "Luna doesn't know this drive.");
    return fail(404, "This album's drive isn't plugged in right now.");
  }
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
  const variant = String(query.variant || "content");
  const url = variant === "thumb" ? photo.thumb : photo.content;
  if (!url) return fail(404, "Luna can't find that anymore. Refresh and try again.");
  // The fake's pictures are inline `data:` URLs, so the guest's bytes are the
  // decoded body of one. Any parameters before the comma (`;utf8`) are part of
  // the media type, not of the payload.
  const comma = url.indexOf(",");
  if (!url.startsWith("data:") || comma < 0)
    return fail(404, "Luna can't find that anymore. Refresh and try again.");
  const meta = url.slice(5, comma);
  const body = url.slice(comma + 1);
  const type = meta.split(";")[0];
  const bytes = /;base64/i.test(meta)
    ? Uint8Array.from(atob(body), (ch) => ch.charCodeAt(0))
    : new TextEncoder().encode(decodeURIComponent(body));
  return raw(
    bytes,
    type,
    200,
    variant === "download"
      ? { "Content-Disposition": `attachment; filename="${dispositionName(photo.name || "photo")}"` }
      : {},
  );
});

publicGet("/s/:token/list", ({ world, params, query, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  // lunad's public_list requires a path subject with view access: an album or a
  // link whose only job is answering cannot browse a folder. A drop box
  // promises nobody can see what is in it, so it has no listing either.
  const caps = String(r.l.caps || "").split("+").filter(Boolean);
  // "full" is CAP_ALL, which includes CAP_VIEW; a drop box ("upload") and an
  // answering-only link ("respond") carry no view at all, so they list nothing.
  const canView = caps.includes("view") || caps.includes("full") || caps.includes("read");
  if (r.s.kind !== "path" || !canView) return fail(410, "This link has expired or been removed.");
  const segments = linkSegments(query.path);
  if (!segments) return fail(400, "That folder isn't part of this shared link.");
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
    return listing([{ name: r.s.name, kind: "file", size: 120_000, modified: nowSec() - 86400, hidden: false }]);
  }
  // A guest who opens a folder sees that folder's entries, not the root again.
  const tree = treeOf(world, params.token, r.s);
  if (!segments.length) return listing(tree.filter((e) => linkReaches(world, r.l, e.name, r.s.drive_id, r.s.path)));
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
    if (found.kind !== "dir") return fail(400, "That isn't a folder.");
    level = found.children || [];
  }
  return listing(level.filter((e) => linkReaches(world, r.l, [...segments, e.name].join("/"), r.s.drive_id, r.s.path)));
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
function unavailableShare(world, s, msg) {
  if (s.kind !== "path") return null;
  try {
    needDrive(world, s.drive_id || "d1");
    return null;
  } catch {
    return fail(404, msg);
  }
}

function serveSharedFile(world, r, rel, name) {
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
  return raw(data, type, 200, {
    "Content-Disposition": `attachment; filename="${dispositionName(name)}"`,
  });
}

publicGet("/s/:token/zip", ({ world, params, query, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  // lunad's gate is `caps & CAP_VIEW == 0`. "full" is CAP_ALL, which includes
  // CAP_VIEW, and a capsule like "view+upload" does too — so split, never
  // substring-match, or "full" is wrongly refused.
  const caps = String(r.l.caps || "").split("+").filter(Boolean);
  const canView = caps.includes("view") || caps.includes("full") || caps.includes("read");
  if (!canView) return fail(410, "This link has expired or been removed.");
  if (r.s.kind === "album") {
    // `public_zip` counts the album's refs first: an empty album and one over
    // the 500-photo limit are both refusals, not empty or enormous downloads.
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
    return raw(new TextEncoder().encode(`PK\x05\x06${"\0".repeat(18)}`), "application/zip", 200, {
      "Content-Disposition": `attachment; filename="${dispositionName(r.s.name || "album")}.zip"`,
    });
  }
  if (r.s.kind !== "path") return fail(410, "This link has expired or been removed.");
  const segments = linkSegments(query.path);
  if (!segments) return fail(400, "That folder isn't part of this shared link.");
  // `public_zip` resolves the target through `confined_read` before it asks
  // whether the target is a directory, so a dead drive is refused for a
  // single-file link too — and its `link_reaches` runs inside that same read.
  const goneFiles = unavailableShare(world, r.s, "The shared files aren't available right now.");
  if (goneFiles) return goneFiles;
  if (r.s.is_file) {
    if (segments.length) return fail(400, "That folder isn't part of this shared link.");
    if (!linkReaches(world, r.l, "", r.s.drive_id, r.s.path))
      return fail(404, "That item isn't part of this shared link.");
    return serveSharedFile(world, r, "", r.s.name || "download");
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
    if (found.kind !== "dir") return serveSharedFile(world, r, segments.join("/"), found.name);
  }
  const base = segments.length ? segments[segments.length - 1] : (r.s.name || "download");
  return raw(new TextEncoder().encode(`PK\x05\x06${"\0".repeat(18)}`), "application/zip", 200, {
    "Content-Disposition": `attachment; filename="${dispositionName(base)}.zip"`,
  });
});

// `public_stat` gates like every other path route before it answers a size:
// no view is a 403 that names the drop-box link, a non-path subject has closed,
// and the target has to resolve inside the share.
publicGet("/s/:token/stat", ({ world, params, query, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const caps = String(r.l.caps || "").split("+").filter(Boolean);
  const canView = caps.includes("view") || caps.includes("full") || caps.includes("read");
  if (!canView)
    return fail(403, "This link is for dropping files off — it doesn't open what others have added.");
  if (r.s.kind !== "path") return fail(410, "This link has expired or been removed.");
  const segments = linkSegments(query.path);
  if (!segments) return fail(400, "That path isn't inside this share.");
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
        { name: statRel === ".luna-trash" ? "Trash" : statRel.split("/").pop(), kind: "dir", size: 0 };
  // `confined_read` words a missing target for the guest rather than saying
  // the path was never there, and a boundary hit is `not_in_share`.
  if (!entry) return fail(404, "Luna can't find that anymore. Refresh and try again.");
  if (!linkReaches(world, r.l, rel, r.s.drive_id, r.s.path))
    return fail(404, "That item isn't part of this shared link.");
  return {
    name: entry.name,
    kind: entry.kind === "dir" ? "dir" : "file",
    size: entry.size ?? (entry.kind === "dir" ? 0 : 120_000),
    modified: nowSec() - 86400,
    children: null,
    created: nowSec() - 86400 * 30,
    hidden: false,
    totals: null,
    // `CAP_ALL` ("full") includes `CAP_EDIT`, and the share's own root is
    // never writable whatever the capability says.
    writable: (caps.includes("edit") || caps.includes("full")) && rel !== "",
  };
});

// The file's own bytes. A guest reads these from the link, not the drive API,
// so without this route a link's editor showed "{}" — the router's answer for
// a path nothing matched — as if that were the file's text.
publicGet("/s/:token/file", ({ world, params, query, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  // Same subject and capability rule as lunad's public_file: only a path link
  // with view access serves bytes. An upload-only link is a drop box, and an
  // answering-only or album link has no file to read — serving one would
  // contradict screens that promise as much.
  const caps = String(r.l.caps || "").split("+").filter(Boolean);
  const canView = caps.includes("view") || caps.includes("full") || caps.includes("read");
  if (r.s.kind !== "path" || !canView) return fail(410, "This link has expired or been removed.");
  const segments = linkSegments(query.path);
  if (!segments) {
    return fail(400, "That file isn't part of this shared link.");
  }
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
  return raw(data, type, 200, {
    ...(query.download === "1" ? { "Content-Disposition": `attachment; filename="${dispositionName(entry.name)}"` } : {}),
  });
});

/** `require_link_upload`: a link without the upload capability receives nothing. */
function uploadGate(r) {
  const caps = String(r.l.caps || "").split("+").filter(Boolean);
  if (!caps.includes("upload"))
    return fail(403, "This link is view-only, so it can't receive files. Ask for a link that allows uploads.");
  return null;
}

post("/s/:token/upload", ({ world, params, headers, body }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const denied = uploadGate(r);
  if (denied) return denied;
  if (sharing(world).failUpload) return fail(500, "Luna couldn't save that file.");
  const id = nextId("up");
  const size = Number(body.size) || 0;
  // A session outlives the request that made it, and the daemon tells one it
  // never made (404) from one another link owns (403), so the bookkeeping lives
  // on the world rather than in a list beside the link.
  world.uploads ||= {};
  world.uploads[id] = { linkId: r.l.id, name: body.name, size, received: 0, state: "open" };
  r.l.uploadIds = [...(r.l.uploadIds || []), id];
  return { upload_id: id, received: 0, size, name: body.name };
}, { public: true });
// Every later request proves the session belongs to this link and is still
// running: a finished or cancelled one answers 409 rather than starting over.
function uploadFor(world, r, id) {
  const up = world.uploads?.[id];
  if (!up) return { err: fail(404, "Luna doesn't know this upload.") };
  if (up.linkId !== r.l.id) return { err: fail(403, "That upload isn't part of this link.") };
  if (up.state !== "open")
    return { err: fail(409, "This upload is already finished or cancelled.") };
  return { err: null, up };
}
put("/s/:token/upload/:id", ({ world, params, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const denied = uploadGate(r);
  if (denied) return denied;
  const found = uploadFor(world, r, params.id);
  if (found.err) return found.err;
  const spec = headers["content-range"];
  if (!spec)
    return fail(400, "Each chunk needs a Content-Range header (bytes start-end/total).");
  const range = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/.exec(String(spec));
  if (!range) return fail(400, "That chunk range isn't valid.");
  found.up.received = Math.max(found.up.received, Number(range[2]) + 1);
  return { upload_id: params.id, received: found.up.received };
}, { public: true });
post("/s/:token/upload/:id/complete", ({ world, params, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const denied = uploadGate(r);
  if (denied) return denied;
  const found = uploadFor(world, r, params.id);
  if (found.err) return found.err;
  found.up.state = "done";
  r.l.uploads = (r.l.uploads || 0) + 1;
  r.l.uploadIds = (r.l.uploadIds || []).filter((x) => x !== params.id);
  // `public_upload_complete` answers with the finished file — the same entry a
  // listing shows — so the page can put it straight on screen.
  return {
    name: found.up.name || "upload",
    kind: "file",
    size: found.up.size || 0,
    modified: nowSec(),
    created: nowSec(),
    hidden: false,
    children: null,
    totals: null,
  };
}, { public: true });
del("/s/:token/upload/:id", ({ world, params, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  const denied = uploadGate(r);
  if (denied) return denied;
  const found = uploadFor(world, r, params.id);
  if (found.err) return found.err;
  found.up.state = "cancelled";
  r.l.uploadIds = (r.l.uploadIds || []).filter((x) => x !== params.id);
  return { ok: true };
}, { public: true });

// Answers to a form link.
// `respond_lookup` resolves the link on the same rails as every other `/s/`
// address — expiry and the password gate included — before it hands back
// answers for an edit token.
get("/s/:token/respond", ({ world, params, query, headers }) => {
  const r = open(world, params.token, headers);
  if (r.err) return r.err;
  // Only a path subject carrying the answering capability opens a form; every
  // other link closes here rather than answering about a form it never was.
  const caps = String(r.l.caps || "").split("+").filter(Boolean);
  if (r.s.kind !== "path" || !caps.includes("respond"))
    return fail(403, "This link doesn't open a form.");
  const editToken = String(query.edit_token ?? "");
  if (!editToken)
    return fail(400, "That edit link is incomplete. Ask for the full link and try again.");
  // The lookup exists only to power edit mode, so a form that refuses changes
  // answers with its own refusal instead of handing the answers back.
  if (r.l.form?.settings?.allowEdits === false)
    return fail(403, "This form doesn't let you change answers after you send them.");
  const found = r.l.responses?.find((x) => x.edit_token === editToken);
  return found
    ? { id: found.id, answers: found.answers, ok: true }
    : fail(404, "We couldn't find answers for that edit link.");
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

