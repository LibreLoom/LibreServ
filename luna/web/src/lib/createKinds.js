import { FilePlus, FileSpreadsheet, FileText, FolderPlus, Presentation } from "lucide-react";

/**
 * Things people can make from the New menu.
 *
 * @typedef {{
 *   id: string,
 *   label: string,
 *   group: string,
 *   icon: import("react").ElementType,
 *   action: "mkdir" | "create-file",
 *   openAfter?: "text" | "viewer",
 *   title: string,
 *   nameLabel: string,
 *   confirmLabel: string,
 *   defaultName: string,
 *   defaultExt?: string,
 *   stub?: "docx" | "xlsx" | "pptx",
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
  {
    id: "document",
    label: "Document",
    group: "Office",
    icon: FileText,
    action: "create-file",
    openAfter: "viewer",
    title: "New document",
    nameLabel: "Name for this document",
    confirmLabel: "Create document",
    defaultName: "Document.docx",
    defaultExt: ".docx",
    stub: "docx",
  },
  {
    id: "spreadsheet",
    label: "Spreadsheet",
    group: "Office",
    icon: FileSpreadsheet,
    action: "create-file",
    openAfter: "viewer",
    title: "New spreadsheet",
    nameLabel: "Name for this spreadsheet",
    confirmLabel: "Create spreadsheet",
    defaultName: "Spreadsheet.xlsx",
    defaultExt: ".xlsx",
    stub: "xlsx",
  },
  {
    id: "presentation",
    label: "Presentation",
    group: "Office",
    icon: Presentation,
    action: "create-file",
    openAfter: "viewer",
    title: "New presentation",
    nameLabel: "Name for this presentation",
    confirmLabel: "Create presentation",
    defaultName: "Presentation.pptx",
    defaultExt: ".pptx",
    stub: "pptx",
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
