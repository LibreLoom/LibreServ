import { useEffect } from "react";

export const APP_TITLE = "Luna";

/**
 * Names the browser tab after what's open: "<title> · Luna". Pass the most
 * specific thing on screen (a file, folder, drive, page); an empty title
 * leaves the tab as plain "Luna".
 * @param {string | null | undefined} title
 */
export default function usePageTitle(title) {
  useEffect(() => {
    document.title = title ? `${title} · ${APP_TITLE}` : APP_TITLE;
  }, [title]);
}
