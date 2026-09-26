/**
 * `.excalidraw` file helpers — the on-disk format is Excalidraw's scene
 * JSON (`{type:"excalidraw", version:2, elements, appState, files}`).
 *
 * `.excalidraw.svg`/`.png` are deliberately NOT editor kinds here: this
 * npm build's export functions can't write the embedded-scene variants
 * back, so they stay plain images in the viewer — an `.excalidraw.svg`
 * still renders its preview like any other picture.
 */

/** Provenance stamped into every file we write, like draw.io's `host`. */
export const WHITEBOARD_SOURCE = "https://gt.plainskill.net/LibreLoom/LibreServ";

/** A new blank whiteboard, matching what excalidraw writes for an empty scene. */
export const BLANK_EXCALIDRAW_JSON = `${JSON.stringify(
  {
    type: "excalidraw",
    version: 2,
    source: WHITEBOARD_SOURCE,
    elements: [],
    appState: {},
    files: {},
  },
  null,
  2,
)}\n`;

/** MIME type for the bytes written back to the drive. */
export const WHITEBOARD_MIME = "application/json";
