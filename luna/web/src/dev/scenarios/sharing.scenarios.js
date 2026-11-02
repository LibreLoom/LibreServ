import { DAY, DEFAULT_NOW, HOUR, user } from "../fake/world.js";
import { makePhotos, photoKey } from "../fake/photos.js";

// The fake page clock starts at DEFAULT_NOW, so dates are built from it, not the real clock.
const now = () => Math.floor(DEFAULT_NOW / 1000);
const people = (w, n) => {
  for (let i = 0; i < n; i++) w.users.push(user({ id: `p${i}`, username: `person${i}`, display_name: i === 0 ? "Sam" : `Person number ${i + 1}` }));
};
const asMember = (w, id = "p0") => { w.sessionUserId = id; };

let seq = 0;
/** A shared thing, ready for the Shared page and the sharing sheet. */
function subject(w, over = {}) {
  w.sharing ||= { subjects: [], withMe: [] };
  const s = {
    kind: "path",
    drive_id: "d1",
    drive_label: "Family photos",
    path: "Photos/Holiday",
    album_id: "",
    name: "Holiday",
    is_file: false,
    owner_id: "u1",
    my_caps: "full+share",
    private: false,
    members: [],
    links: [],
    keepEmpty: true,
    ...over,
  };
  w.sharing.subjects.push(s);
  return s;
}
const link = (over = {}) => ({ id: `ln${++seq}`, token: `tok${seq}`, caps: "view", password: "", expires_at: null, ...over });
const member = (user_id, caps = "view") => ({ id: `m${++seq}`, user_id, caps });
const albumSubject = (w, id, name, over = {}) => {
  w.albums.push({ id, home_drive_id: "d1", name, owner_user_id: "u1", locked: false });
  w.albumItems ||= {};
  w.albumItems[id] = (w.photos || []).slice(0, 6).map(photoKey);
  return subject(w, { kind: "album", path: "", album_id: id, name, ...over });
};

/** A signed-out visitor opening one link. */
const guest = (w) => { w.sessionUserId = null; };

/** @type {import("./registry.js").Scenario[]} */
export default [
  // ── Shared page ──────────────────────────────────────────────────────────
  {
    id: "shared/empty-admin",
    area: "Shared",
    title: "Nothing shared yet (Admin)",
    url: "/shared",
    check: ["Opens on 'Manage sharing' with 'Nothing shared yet' and how to start", "Switching to 'Shared with you' also shows a plain empty state"],
  },
  {
    id: "shared/empty-member",
    area: "Shared",
    title: "Nothing shared with a member",
    url: "/shared",
    seed: (w) => { people(w, 1); asMember(w); },
    check: ["'Shared with you' is empty with a plain explanation", "No admin-only tab confusion"],
  },
  {
    id: "shared/many",
    area: "Shared",
    title: "Lots of shared items",
    url: "/shared",
    seed: (w) => {
      people(w, 6);
      w.photos = makePhotos(30);
      for (let i = 0; i < 40; i++) {
        subject(w, {
          path: `Photos/Trip ${i + 1}`, name: i === 3 ? "A very long folder name for a trip that went on for a long time and kept going" : `Trip ${i + 1}`,
          members: i % 3 === 0 ? [member("p0", "view"), member("p1", "full")] : [],
          links: i % 2 === 0 ? [link({ caps: "view" })] : [],
        });
      }
      for (let i = 0; i < 25; i++) {
        w.sharing.withMe.push({ id: `wm${i}`, kind: "path", drive_id: "d1", drive_label: "Family photos", path: `Shared/Folder ${i + 1}`, album_id: "", name: `Folder ${i + 1}`, is_file: i % 4 === 0, caps: i % 3 ? "view" : "full", shared_by: "Max", exists: true });
      }
    },
    check: ["Both tabs scroll and the table stays aligned", "Search 'Trip 7' narrows both lists; a nonsense search says 'Nothing matches'", "Long name is cut off cleanly", "Phone width shows cards, not a squashed table"],
  },
  {
    id: "shared/with-me-states",
    area: "Shared",
    title: "Shared with you: gone items, leaving",
    url: "/shared",
    seed: (w) => {
      people(w, 1);
      asMember(w);
      w.sharing = { subjects: [], withMe: [
        { id: "a", kind: "path", drive_id: "d1", drive_label: "Family photos", path: "Photos", album_id: "", name: "Photos", is_file: false, caps: "full", shared_by: "Max", exists: true },
        { id: "b", kind: "path", drive_id: "d1", drive_label: "Old drive", path: "Taxes", album_id: "", name: "Taxes", is_file: false, caps: "view", shared_by: "Max", exists: false },
        { id: "c", kind: "album", drive_id: "d1", drive_label: "Family photos", path: "", album_id: "al1", name: "Weekend", is_file: false, caps: "view+upload", shared_by: "Max", exists: true },
        { id: "d", kind: "path", drive_id: "d1", drive_label: "Family photos", path: "Docs/plan.pdf", album_id: "", name: "plan.pdf", is_file: true, caps: "view", shared_by: "", exists: true },
      ] };
    },
    check: ["The unplugged drive's item says 'Unavailable' and cannot be opened", "A missing 'Shared by' shows a dash", "Leave asks first, then the row disappears and a toast confirms", "Open album goes to Photos at that album"],
  },
  {
    id: "shared/leave-fails",
    area: "Shared",
    title: "Leaving a share fails",
    url: "/shared",
    seed: (w) => {
      people(w, 1);
      asMember(w);
      w.sharing = { subjects: [], withMe: [{ id: "a", kind: "path", drive_id: "d1", drive_label: "Family photos", path: "Photos", album_id: "", name: "Photos", is_file: false, caps: "full", shared_by: "Max", exists: true }] };
    },
    faults: [{ match: "DELETE /api/v1/access/members/*", mode: "500" }],
    check: ["Leave → confirm: the error shows inside the dialog in plain words", "The row is still there"],
  },
  {
    id: "shared/load-fails",
    area: "Shared",
    title: "Shared page cannot load",
    url: "/shared",
    faults: [{ match: "GET /api/v1/access/mine", mode: "500" }],
    check: ["Plain error: 'Couldn't load sharing…'", "No blank page"],
  },

  // ── Sharing sheet ────────────────────────────────────────────────────────
  {
    id: "share/no-other-users",
    area: "Sharing sheet",
    title: "Nobody else on this Luna",
    url: "/shared",
    seed: (w) => { subject(w, {}); },
    check: ["Manage → People section says there is nobody else to add yet and points to Settings → Users", "Add a person is disabled or hidden, not broken", "Links can still be made"],
  },
  {
    id: "share/add-person-flow",
    area: "Sharing sheet",
    title: "Add, change and remove a person",
    url: "/shared",
    seed: (w) => { people(w, 3); subject(w, {}); },
    check: ["Add Sam with 'Can view': row appears and a toast says access granted", "Change to 'Can view + edit': toast, label changes", "Remove: gone; Sam returns to the Add list", "Reload the page's Shared tab: Holiday still shows the right counts"],
  },
  {
    id: "share/many-people",
    area: "Sharing sheet",
    title: "Sheet with dozens of people and links",
    url: "/shared",
    seed: (w) => {
      people(w, 45);
      subject(w, {
        members: Array.from({ length: 30 }, (_, i) => member(`p${i}`, i % 2 ? "view" : "full")),
        links: Array.from({ length: 8 }, (_, i) => link({ caps: i % 2 ? "view" : "view+upload", password: i % 3 ? "" : "pw", expires_at: now() + (i + 1) * DAY })),
      });
    },
    check: ["Sheet scrolls inside itself, buttons stay reachable", "Picker for adding a person lists the 15 people not added yet", "Phone width: rows do not overflow"],
  },
  {
    id: "share/view-only-member",
    area: "Sharing sheet",
    title: "Opening the sheet without the right to share",
    url: "/shared",
    seed: (w) => { people(w, 2); subject(w, { owner_id: "p0", my_caps: "view", members: [member("p1", "view")] }); },
    check: ["Sheet shows who has access but offers no change/remove/add", "Nothing says 'undefined'; the reason is plain"],
  },
  {
    id: "share/cannot-load",
    area: "Sharing sheet",
    title: "Sheet cannot load the sharing details",
    url: "/shared",
    seed: (w) => { subject(w, {}); },
    faults: [{ match: "GET /api/v1/access/subject", mode: "403", message: "You don't have access to share this." }],
    check: ["Manage opens a sheet that says you don't have access", "Close works"],
  },
  {
    id: "share/add-person-fails",
    area: "Sharing sheet",
    title: "Adding a person fails",
    url: "/shared",
    seed: (w) => { people(w, 3); subject(w, {}); w.sharing.failAdd = true; },
    check: ["Add Sam: the dialog stays open and shows the error", "The person is not added", "Button works again for another try"],
  },
  {
    id: "share/links-all-states",
    area: "Sharing sheet",
    title: "Links: open, password, expired, soon, never",
    url: "/shared",
    seed: (w) => {
      subject(w, {
        links: [
          link({ caps: "view" }),
          link({ caps: "view+upload", password: "secret" }),
          link({ caps: "view", expires_at: now() - 2 * DAY }),
          link({ caps: "upload", expires_at: now() + 3 * HOUR }),
          link({ caps: "full", expires_at: now() + 400 * DAY }),
        ],
      });
    },
    check: ["Each row says its access, 'Password' or 'Anyone with the link', and its expiry", "The expired one says 'expired'", "Edit a link: change password and expiry, save, toast", "Remove one: asks first; gone afterwards"],
  },
  {
    id: "share/create-link",
    area: "Sharing sheet",
    title: "Make a link",
    url: "/shared",
    seed: (w) => { subject(w, {}); },
    check: ["Create with 30 days + password: 'Link ready' with a copyable address", "The new link appears in the sheet with the password note", "Opening that address in the Public page scenarios' style asks for the password"],
  },
  {
    id: "share/create-link-fails",
    area: "Sharing sheet",
    title: "Making a link fails",
    url: "/shared",
    seed: (w) => { subject(w, {}); w.sharing.failLink = true; },
    check: ["The dialog shows a plain error and stays open", "No link is added"],
  },
  {
    id: "share/remove-link-fails",
    area: "Sharing sheet",
    title: "Removing a link fails",
    url: "/shared",
    seed: (w) => { subject(w, { links: [link()] }); },
    faults: [{ match: "DELETE /api/v1/access/links/*", mode: "500" }],
    check: ["Confirm remove: the error shows in the confirm dialog", "The link is still listed"],
  },
  {
    id: "share/upload-only-folder",
    area: "Sharing sheet",
    title: "Upload-only (drop box) folder",
    url: "/shared",
    seed: (w) => { subject(w, { name: "Drop box", path: "Inbox", links: [link({ caps: "upload" })], members: [] }); },
    check: ["Link row says 'Upload only'", "Choices when making a new link include 'Upload only'"],
  },
  {
    id: "share/album-sheet",
    area: "Sharing sheet",
    title: "Sharing an album",
    url: "/gallery#albums",
    seed: (w) => { people(w, 2); w.photos = makePhotos(20); albumSubject(w, "al1", "Weekend"); },
    check: ["Share button on the album opens a sheet titled Album", "Only 'Can view' and 'Can view + add photos' are offered", "Add Sam: the album now shows as shared in Photos"],
  },
  {
    id: "share/private-folder",
    area: "Sharing sheet",
    title: "Private folder sheet",
    url: "/shared",
    seed: (w) => { people(w, 2); subject(w, { private: true, private_folder: true, name: "Diary", path: "Diary" }); },
    check: ["Lock note explains only added people can open it", "Admins appear in the people list for private items"],
  },
  {
    id: "share/inherited",
    area: "Sharing sheet",
    title: "Access that comes from a folder above",
    url: "/shared",
    seed: (w) => {
      people(w, 2);
      subject(w, {
        path: "Photos/Holiday/Day1", name: "Day1",
        inherited_members: [{ id: "im1", user_id: "p0", name: "Sam", caps: "view", inherited_from: { kind: "path", drive_id: "d1", path: "Photos", can_inspect: true } }],
        inherited_links: [{ id: "il1", caps: "view", inherited_from: { kind: "path", drive_id: "d1", path: "Photos", can_inspect: false } }],
      });
    },
    check: ["Sheet says 1 person and 1 link come from a folder above", "A button to open the parent's sheet only appears where allowed"],
  },
  {
    id: "share/phone",
    area: "Sharing sheet",
    title: "Sharing on a phone",
    url: "/shared",
    viewport: "phone",
    seed: (w) => { people(w, 5); subject(w, { members: [member("p0"), member("p1", "full")], links: [link({ password: "x" })] }); },
    check: ["Sheet fits the screen; no sideways scroll", "Access dropdowns open inside the screen"],
  },

  // ── Public page /s/:token ────────────────────────────────────────────────
  {
    id: "public/folder",
    area: "Public link",
    title: "Folder link, view only",
    url: "/s/tokfolder",
    seed: (w) => { guest(w); subject(w, { links: [{ ...link({ caps: "view" }), token: "tokfolder" }] }); },
    check: ["Page opens with no sign-in, titled with the folder name", "Files list shows; no New/Delete/Upload", "Download works for a file"],
  },
  {
    id: "public/folder-edit",
    area: "Public link",
    title: "Folder link with upload",
    url: "/s/tokedit",
    seed: (w) => { guest(w); subject(w, { links: [{ ...link({ caps: "view+upload" }), token: "tokedit" }] }); },
    check: ["Upload is offered; uploading a file shows progress then a success toast", "Cancel during an upload stops it", "Huge file name still fits"],
  },
  {
    id: "public/upload-fails",
    area: "Public link",
    title: "Upload on a link fails",
    url: "/s/tokfail",
    seed: (w) => { guest(w); subject(w, { links: [{ ...link({ caps: "view+upload" }), token: "tokfail" }] }); w.sharing.failUpload = true; },
    check: ["Uploading shows a plain error, not a stuck bar", "Page stays usable"],
  },
  {
    id: "public/dropbox",
    area: "Public link",
    title: "Upload-only link (drop box)",
    url: "/s/tokdrop",
    seed: (w) => { guest(w); subject(w, { name: "Drop box", path: "Inbox", links: [{ ...link({ caps: "upload" }), token: "tokdrop" }] }); },
    check: ["Only an upload area shows: no file list", "After uploading: 'Files uploaded.'", "No hint that other files exist"],
  },
  {
    id: "public/album",
    area: "Public link",
    title: "Album link",
    url: "/s/tokalbum",
    seed: (w) => {
      guest(w);
      w.photos = makePhotos(260);
      albumSubject(w, "al1", "Weekend", {});
      w.albumItems.al1 = w.photos.map(photoKey);
      w.sharing.subjects[0].links.push({ ...link({ caps: "view+upload" }), token: "tokalbum" });
    },
    check: ["Photo grid with the album name and '260 items'", "Scroll loads more", "Open a photo: arrows work, download offered", "Select several and 'Download selected'", "Add photos is offered because the link allows it"],
  },
  {
    id: "public/album-empty",
    area: "Public link",
    title: "Empty album link",
    url: "/s/tokempty",
    seed: (w) => {
      guest(w);
      w.photos = [];
      albumSubject(w, "al1", "Not filled yet");
      w.sharing.subjects[0].links.push({ ...link({ caps: "view" }), token: "tokempty" });
    },
    check: ["'No photos yet' with words that fit a view-only visitor", "With an upload link the words invite adding photos"],
  },
  {
    id: "public/file",
    area: "Public link",
    title: "Single file link",
    url: "/s/tokfile",
    seed: (w) => { guest(w); subject(w, { path: "Docs/plan.pdf", name: "plan.pdf", is_file: true, links: [{ ...link({ caps: "view" }), token: "tokfile" }] }); },
    check: ["Shows the one file by name with Download", "No folder navigation"],
  },
  {
    id: "public/password",
    area: "Public link",
    title: "Link with a password (right is 'secret')",
    url: "/s/tokpw",
    seed: (w) => { guest(w); subject(w, { links: [{ ...link({ caps: "view", password: "secret" }), token: "tokpw" }] }); },
    check: ["Lock card asks for the password in plain words", "'wrong' shakes and says the password is wrong, field kept", "'secret' opens the folder"],
  },
  {
    id: "public/expired",
    area: "Public link",
    title: "Expired link",
    url: "/s/tokold",
    seed: (w) => { guest(w); subject(w, { links: [{ ...link({ expires_at: now() - DAY }), token: "tokold" }] }); },
    check: ["Says the link expired and to ask for a new one", "No file names leak"],
  },
  {
    id: "public/revoked",
    area: "Public link",
    title: "Link that was removed",
    url: "/s/tokgone",
    seed: (w) => { guest(w); w.sharing = { subjects: [], withMe: [] }; },
    check: ["Says the link doesn't exist or the files aren't on Luna", "Reads calmly; no technical words"],
  },
  {
    id: "public/invalid-token",
    area: "Public link",
    title: "Nonsense address",
    url: "/s/!!%20not%20a%20real%20link",
    seed: (w) => { guest(w); },
    check: ["Same calm 'doesn't exist' message", "Nothing crashes on the odd characters"],
  },
  {
    id: "public/disabled",
    area: "Public link",
    title: "Link switched off",
    url: "/s/tokoff",
    seed: (w) => { guest(w); subject(w, { links: [{ ...link({ disabled: true }), token: "tokoff" }] }); },
    check: ["Says the link has been turned off", "Not shown as 'expired' or 'missing'"],
  },
  {
    id: "public/download-limit",
    area: "Public link",
    title: "Link that hit its download limit",
    url: "/s/toklimit",
    seed: (w) => { guest(w); subject(w, { links: [{ ...link({ caps: "view", download_limit: 5, downloads: 5 }), token: "toklimit" }] }); },
    check: ["Says the link has reached its download limit", "Offers no download buttons that will fail"],
  },
  {
    id: "public/offline",
    area: "Public link",
    title: "Opening a link with no connection",
    url: "/s/tokfolder",
    offline: true,
    seed: (w) => { guest(w); subject(w, { links: [{ ...link(), token: "tokfolder" }] }); },
    check: ["Says it could not reach Luna and to check the connection", "Turning offline off and reloading works"],
  },
  {
    id: "public/slow",
    area: "Public link",
    title: "Link opens slowly",
    url: "/s/tokfolder",
    seed: (w) => { guest(w); subject(w, { links: [{ ...link(), token: "tokfolder" }] }); },
    faults: [{ match: "GET /s/tokfolder*", mode: "slow:5000" }],
    check: ["'Opening the shared link…' shows the whole wait", "Page then appears without a flash of an error"],
  },
  {
    id: "public/signed-in-visitor",
    area: "Public link",
    title: "Link opened by someone signed in",
    url: "/s/tokfolder",
    seed: (w) => { subject(w, { links: [{ ...link(), token: "tokfolder" }] }); },
    check: ["Same page as a guest sees; no app navbar", "Does not bounce to the dashboard"],
  },
  {
    id: "public/phone",
    area: "Public link",
    title: "Public album on a phone",
    url: "/s/tokalbum",
    viewport: "phone",
    seed: (w) => {
      guest(w);
      w.photos = makePhotos(60, { videoEvery: 10 });
      albumSubject(w, "al1", "Weekend", {});
      w.albumItems.al1 = w.photos.map(photoKey);
      w.sharing.subjects[0].links.push({ ...link({ caps: "view" }), token: "tokalbum" });
    },
    check: ["Three columns fit; the action buttons wrap", "Large view closes with a swipe and a button"],
  },

  // ── Forms ────────────────────────────────────────────────────────────────
  {
    id: "forms/respond-link",
    area: "Forms",
    title: "Answering a form from a link",
    url: "/s/tokform",
    seed: (w) => { guest(w); subject(w, { path: "Forms/RSVP.lunaform", name: "RSVP", is_file: true, links: [{ ...link({ caps: "respond" }), token: "tokform" }] }); },
    check: ["Questions show; leaving 'Your name' empty shakes and says it is needed", "Sending shows a thank-you screen", "Reload: it remembers you already answered and offers to edit"],
  },
  {
    id: "forms/closed",
    area: "Forms",
    title: "Form that stopped collecting answers",
    url: "/s/tokclosed",
    seed: (w) => { guest(w); subject(w, { path: "Forms/RSVP.lunaform", name: "RSVP", is_file: true, links: [{ ...link({ caps: "respond", accepting: false, closed_message: "Thanks, RSVPs closed on Friday." }), token: "tokclosed" }] }); },
    check: ["Shows the owner's closing message, not an empty form"],
  },
  {
    id: "forms/send-fails",
    area: "Forms",
    title: "Sending answers fails",
    url: "/s/tokform",
    seed: (w) => { guest(w); subject(w, { path: "Forms/RSVP.lunaform", name: "RSVP", is_file: true, links: [{ ...link({ caps: "respond" }), token: "tokform" }] }); },
    faults: [{ match: "POST /s/tokform/respond", mode: "500", message: "Luna couldn't save your answers." }],
    check: ["Answers stay filled in", "A plain error shows with Send answers still available"],
  },
  {
    id: "forms/password",
    area: "Forms",
    title: "Form link with a password",
    url: "/s/tokformpw",
    seed: (w) => { guest(w); subject(w, { path: "Forms/RSVP.lunaform", name: "RSVP", is_file: true, links: [{ ...link({ caps: "respond", password: "secret" }), token: "tokformpw" }] }); },
    check: ["Asks for the password first", "After the right one, the form shows and sending works"],
  },
];
