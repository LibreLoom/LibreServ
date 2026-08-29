import { FilePlus, FolderPlus } from "lucide-react";

/**
 * Things people can make from the New menu.
 *
 * Add office types here later (document, spreadsheet, slides). The menu
 * groups by `group` and stays one New button no matter how long this list
 * gets.
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 *   group: string,
 *   icon: import("react").ElementType,
 *   action: "mkdir" | "create-file",
 *   openAfter?: "text",
 *   title: string,
 *   nameLabel: string,
 *   confirmLabel: string,
 *   defaultName: string,
 *   defaultExt?: string,
 * }} CreateKind
 */

/** @type {CreateKind[]} */
export const CREATE_KINDS = [
  {
    id: "folder",
    label: "Folder",
    group: "Organize",
    icon: FolderPlus,
    action: "mkdir",
    title: "New folder",
    nameLabel: "Name for this folder",
    confirmLabel: "Create folder",
    defaultName: "",
  },
  {
    id: "text",
    label: "Text file",
    group: "Files",
    icon: FilePlus,
    action: "create-file",
    openAfter: "text",
    title: "New text file",
    nameLabel: "Name for this text file",
    confirmLabel: "Create file",
    defaultName: "note.txt",
    defaultExt: ".txt",
  },
];

/**
 * @param {string[] | null | undefined} ids
 * @returns {CreateKind[]}
 */
export function createKindsFor(ids) {
  if (!ids || ids.length === 0) return CREATE_KINDS;
  const allow = new Set(ids);
  return CREATE_KINDS.filter((kind) => allow.has(kind.id));
}

/**
 * @param {CreateKind[]} [kinds]
 * @returns {Array<{ label: string, items: CreateKind[] }>}
 */
export function groupedCreateKinds(kinds = CREATE_KINDS) {
  /** @type {Array<{ label: string, items: CreateKind[] }>} */
  const groups = [];
  /** @type {Map<string, { label: string, items: CreateKind[] }>} */
  const byLabel = new Map();
  for (const kind of kinds) {
    const label = kind.group || "";
    let group = byLabel.get(label);
    if (!group) {
      group = { label, items: [] };
      byLabel.set(label, group);
      groups.push(group);
    }
    group.items.push(kind);
  }
  return groups;
}
