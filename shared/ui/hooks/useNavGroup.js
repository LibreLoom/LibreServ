import { useEffect } from "react";
import { useLocation } from "react-router-dom";

/**
 * A navbar item that holds sub-pages (e.g. Luna's Files → Drives · Shared · Photos).
 *
 * @typedef {{ to: string, label: string, icon: import("react").ElementType, match?: string[] }} NavGroupChild
 * @typedef {{ key: string, label: string, icon: import("react").ElementType, children: NavGroupChild[] }} NavGroupItem
 */

function childMatches(child, pathname) {
  return (child.match || [child.to]).some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/** @param {NavGroupItem} group @param {string} pathname */
export function activeChild(group, pathname) {
  return group.children.find((c) => childMatches(c, pathname)) || null;
}

/**
 * Where the group's own link goes: the sub-page you are on, else the one you
 * used last, else the first. Remembered per browser as a convenience only.
 * @param {NavGroupItem} group
 */
export function useGroupTarget(group) {
  const { pathname } = useLocation();
  const current = activeChild(group, pathname);
  const key = `navGroup:${group.key}`;

  useEffect(() => {
    if (!current) return;
    try {
      localStorage.setItem(key, current.to);
    } catch {
      // Storage blocked — the group just opens its first sub-page.
    }
  }, [current, key]);

  if (current) return current.to;
  let last = null;
  try {
    last = localStorage.getItem(key);
  } catch {
    last = null;
  }
  return group.children.some((c) => c.to === last) ? last : group.children[0].to;
}
