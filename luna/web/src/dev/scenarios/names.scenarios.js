// Names an exFAT drive can't hold, and the ext4 drive that still takes them.
// The fake refuses like lunad's files/fsrules.rs: before anything is written,
// naming the character.
import { addDir, addFile } from "../fake/handlers/files.js";

const A = "Files";
const demo = (w, fsType) => {
  w.drives[0].fs_type = fsType;
  w.fs = { ...(w.fs || {}), d1: { nodes: {}, trash: [] } };
  addDir(w, "d1", "Holiday");
  addFile(w, "d1", "Holiday/Photo.jpg", { text: "x" });
};

/** @type {import("./registry.js").Scenario[]} */
export default [
  {
    id: "files/exfat-reserved-character", area: A, title: "New folder named with a colon (exFAT drive)", url: "/files/d1",
    seed: (w) => demo(w, "exfat"),
    check: ["New folder named Trip: 2026 is refused", "The message names the colon and the folder name", "Nothing is added to the list", "A name without the colon works"],
  },
  {
    id: "files/exfat-rename-character", area: A, title: "Rename a file to include a question mark (exFAT drive)", url: "/files/d1?path=Holiday",
    seed: (w) => demo(w, "exfat"),
    check: ["Renaming Photo.jpg to Who?.jpg is refused", "The message names the question mark", "Photo.jpg keeps its name"],
  },
  {
    id: "files/exfat-trailing-dot", area: A, title: "Rename a file to end with a dot (exFAT drive)", url: "/files/d1?path=Holiday",
    seed: (w) => demo(w, "exfat"),
    check: ["Renaming Photo.jpg to Photo. is refused", "The message says names can't end with a dot or a space"],
  },
  {
    id: "files/exfat-case-clash", area: A, title: "New file that differs only in capitals (exFAT drive)", url: "/files/d1?path=Holiday",
    seed: (w) => demo(w, "exfat"),
    check: ["Creating photo.jpg next to Photo.jpg says the name is taken", "Renaming Photo.jpg to photo.jpg works (capitals only)"],
  },
  {
    id: "files/ext4-takes-colons", area: A, title: "Colon in a folder name (ext4 drive)", url: "/files/d1",
    seed: (w) => demo(w, "ext4"),
    check: ["New folder named Trip: 2026 is created", "photo.jpg next to Photo.jpg is allowed"],
  },
];
