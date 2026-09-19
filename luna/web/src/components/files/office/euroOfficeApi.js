/** EuroOffice client-side editing: DocsAPI load, x2t.wasm conversion, bundle IO.
 *
 * The stock editor pack runs entirely in the browser. `x2t.wasm` (served from
 * the pack) converts OOXML files to the editor's internal `Editor.bin` on the
 * client, and lunad's docstorage socket relays co-editing traffic. No Document
 * Server is involved: `document.url` in the editor config is never fetched.
 *
 * There is no pre-flight probe: a missing pack is discovered when the DocsAPI
 * script fails to load (or serves HTML without `window.DocsAPI`).
 */

import { apiFetch, postForm, postJson, putBinary } from "../../../lib/api.js";
import { OFFICE_FORMATS, OFFICE_SAVE_EXT, fileExtension } from "../../../lib/fileKinds.js";
import { contentHref } from "../../../lib/paths.js";

export const EUROOFFICE_API_SRC = "/eurooffice/web-apps/apps/api/documents/api.js";
// The worker lives inside the pack: x2t.js resolves x2t.wasm relative to the
// worker script's directory, so they must sit side by side.
const WORKER_SRC = "/eurooffice/x2t/office-x2t-worker.js";
// Everything the in-browser converter needs from the pack — checked when a
// conversion fails so a half-installed pack isn't blamed on the file.
const CONVERTER_ASSETS = [WORKER_SRC, "/eurooffice/x2t/x2t.js", "/eurooffice/x2t/x2t.wasm"];

const LUNA_UNREACHABLE =
  "Couldn't reach Luna. Check this device's connection and try again.";

/**
 * Thrown when the EuroOffice pack itself can't be used — missing entirely
 * or missing pieces. FileViewer swaps in its install card for this instead
 * of the open-error card, so "the pack isn't here" never reads as "the
 * file is broken".
 */
export class EuroOfficeUnavailableError extends Error {
  constructor(message = "The EuroOffice pack is not installed on this Luna.") {
    super(message);
    this.name = "EuroOfficeUnavailableError";
  }
}

/**
 * HEAD-probe a pack asset. Without the pack dir, lunad never mounts the
 * /eurooffice route and every pack path falls through to the SPA fallback —
 * which answers 200 text/html — so the content type, not the status, says
 * whether the file is really there.
 * @returns {Promise<"present" | "missing" | "unreachable">}
 */
async function packAssetState(src) {
  try {
    const res = await apiFetch(src, { method: "HEAD" });
    const type = res.headers.get("content-type") || "";
    return res.ok && /javascript|wasm|octet-stream/i.test(type) ? "present" : "missing";
  } catch {
    return "unreachable";
  }
}

/**
 * Load DocsAPI once from the local pack. Rejects with
 * EuroOfficeUnavailableError when the pack is missing or unusable, and with
 * a reachability error when Luna itself can't be contacted — a bare script
 * error can't tell the two apart, so a failed load probes the script URL
 * once before blaming the pack. A failed tag removes itself so the next
 * open retries cleanly instead of attaching to a settled script whose load
 * event will never fire again.
 */
export async function loadEuroOfficeDocsApi() {
  const w = /** @type {any} */ (window);
  if (typeof window !== "undefined" && w.DocsAPI?.DocEditor) {
    return w.DocsAPI;
  }
  try {
    return await new Promise((resolve, reject) => {
      const existing = document.querySelector(`script[data-luna-eurooffice="1"]`);
      if (existing) {
        existing.addEventListener("load", () => {
          if (w.DocsAPI?.DocEditor) resolve(w.DocsAPI);
          else reject(new Error("EuroOffice script loaded without DocsAPI."));
        });
        existing.addEventListener("error", () => reject(new Error("EuroOffice failed to load.")));
        return;
      }
      const script = document.createElement("script");
      script.src = EUROOFFICE_API_SRC;
      script.async = true;
      script.dataset.lunaEurooffice = "1";
      script.onload = () => {
        if (w.DocsAPI?.DocEditor) {
          resolve(w.DocsAPI);
        } else {
          script.remove();
          reject(new Error("EuroOffice script loaded without DocsAPI."));
        }
      };
      script.onerror = () => {
        script.remove();
        reject(new Error("EuroOffice failed to load."));
      };
      document.head.appendChild(script);
    });
  } catch {
    if ((await packAssetState(EUROOFFICE_API_SRC)) === "unreachable") {
      throw new Error(LUNA_UNREACHABLE);
    }
    throw new EuroOfficeUnavailableError();
  }
}

/**
 * Ask lunad for a doc key + office token bound to this file. The key also
 * names the bundle dir and the docstorage room.
 * @param {string} driveId
 * @param {string} path
 */
export async function createEuroOfficeSession(driveId, path) {
  return postJson("/api/v1/office/session", {
    drive_id: driveId,
    path,
  });
}

// ---------- x2t.wasm conversion (Web Worker) ----------

let worker = null;
let workerSeq = 0;
const workerWait = new Map();
// A wasm abort kills the worker silently — any request in flight must fail
// fast and the next one must start a fresh worker, not post into the corpse.
const X2T_TIMEOUT_MS = 180_000;

function killWorker() {
  try {
    worker?.terminate();
  } catch {
    // already gone
  }
  worker = null;
}

function failAll(data) {
  for (const settle of workerWait.values()) settle(data);
  workerWait.clear();
}

function x2tWorker() {
  if (worker) return worker;
  worker = new Worker(WORKER_SRC);
  worker.onmessage = (e) => {
    if (e.data?.id === -1) {
      // Boot/abort failure — fail every pending conversion and drop the
      // worker so the next request respawns instead of failing the same way.
      failAll(e.data);
      killWorker();
      return;
    }
    const settle = workerWait.get(e.data?.id);
    if (settle) {
      workerWait.delete(e.data.id);
      settle(e.data);
    }
  };
  worker.onerror = (e) => {
    failAll({ ok: false, error: `worker ${e.message || "failed"}` });
    killWorker();
  };
  return worker;
}

/**
 * Convert via x2t.wasm in the worker.
 * @param {string} inName  e.g. "in.docx" or "Editor.bin"
 * @param {string} outName e.g. "Editor.bin" or "out.docx"
 * @param {Uint8Array} bytes
 * @returns {Promise<{ out: Uint8Array, media: Record<string, Uint8Array> }>}
 */
let workerChain = Promise.resolve();

export function x2tConvert(inName, outName, bytes) {
  // Serialize conversions — the worker's cleanWork() wipes its whole
  // /working FS per request, so concurrent calls would corrupt each other.
  const run = () =>
    new Promise((resolve, reject) => {
      const id = ++workerSeq;
      const timeout = setTimeout(() => {
        // No reply in time — the worker is wedged; drop it so the next call
        // respawns rather than queueing behind a dead one.
        workerWait.delete(id);
        killWorker();
        reject(new Error("The document converter took too long. Try again."));
      }, X2T_TIMEOUT_MS);
      workerWait.set(id, (d) => {
        clearTimeout(timeout);
        if (d.ok) resolve(d);
        else reject(new Error(d.error || "conversion failed"));
      });
      // Always copy before transferring — a transferred buffer detaches in the
      // sender, and callers reuse their input afterwards (the save path PUTs
      // `bytes` as Editor.bin after this call). Detaching it makes the PUT a
      // 0-byte write, which poisons the whole bundle.
      const payload =
        bytes instanceof Uint8Array
          ? bytes.slice()
          : new Uint8Array(bytes.slice ? bytes.slice(0) : bytes);
      x2tWorker().postMessage(
        { id, op: "convert", inName, outName, input: payload },
        [payload.buffer],
      );
    });
  const p = workerChain.then(run, run);
  workerChain = p.then(
    () => {},
    () => {},
  );
  return p;
}

// ---------- bundle (converted document storage on lunad) ----------

export function bundleUrl(key, name) {
  return `/api/v1/office/bundle/${encodeURIComponent(key)}/${name
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
}

async function bundleHas(key, name) {
  const res = await apiFetch(bundleUrl(key, name), { method: "HEAD" });
  if (!res.ok) return false;
  // A 0-byte Editor.bin is a poisoned bundle — it exists on disk so HEAD
  // succeeds, but the editor can't open it. Treat it as missing so the
  // open path converts afresh instead of skipping straight to a dead doc.
  if (name === "Editor.bin") {
    return Number(res.headers.get("content-length")) > 0;
  }
  return true;
}

async function putBundle(key, name, bytes, coverage) {
  // A bundle file is never legitimately empty. An empty body here means the
  // buffer was emptied before send (e.g. a detached typed array) — writing
  // it would poison the bundle while the server still compacts the replay
  // log for Editor.bin. Fail the save loudly instead.
  if (!bytes || (bytes.byteLength ?? 0) === 0) {
    throw new Error(
      "Luna couldn't store the converted document — it came out empty. Try saving again.",
    );
  }
  // putBinary throws ApiError on non-2xx. `coverage` on an Editor.bin PUT
  // is the saver's self-reported op index — the only honest bound for how
  // much of the replay log the new bundle bakes in (server-side delivery
  // tracking can't tell a received broadcast from a dead socket).
  const url =
    coverage == null
      ? bundleUrl(key, name)
      : `${bundleUrl(key, name)}?coverage=${coverage}`;
  await putBinary(url, bytes);
}

/**
 * Make sure a converted bundle exists for this session. First opener converts
 * the OOXML file client-side and uploads `Editor.bin` + `origin.<ext>` +
 * `media/*`; joiners skip straight to the editor.
 * @returns {Promise<{ converted: boolean }>}
 */
export async function ensureOfficeBundle(driveId, path, session) {
  const key = session.key;
  if (await bundleHas(key, "Editor.bin")) return { converted: false };

  const res = await apiFetch(contentHref(driveId, path));
  if (!res.ok) throw new Error("Luna couldn't read this file for conversion.");
  const src = new Uint8Array(await res.arrayBuffer());
  let conv;
  try {
    conv = await x2tConvert(`in.${session.file_type}`, "Editor.bin", src);
  } catch (err) {
    console.error("[eurooffice] open conversion failed:", err);
    // The converter is pack assets too — probe them before blaming the
    // file, so a missing/half-installed pack reports as unavailable and a
    // dead connection as unreachable instead of "damaged file".
    const states = await Promise.all(CONVERTER_ASSETS.map(packAssetState));
    if (states.includes("unreachable")) throw new Error(LUNA_UNREACHABLE);
    if (states.includes("missing")) {
      throw new EuroOfficeUnavailableError(
        "EuroOffice's document converter is not installed on this Luna.",
      );
    }
    // A wedged worker is its own honest message — the file may simply be
    // very large, which "damaged or password-protected" would misstate.
    if (/took too long/i.test(String(err instanceof Error ? err.message : err))) throw err;
    // The worker reports bare "x2t exit N" codes — meaningless to anyone
    // reading the error screen. What it almost always means is that the
    // file is damaged, password-protected, or in a dialect the converter
    // can't read.
    throw new Error(
      "Luna couldn't convert this file for editing. It may be damaged or " +
        "password-protected. You can still download it.",
    );
  }
  await putBundle(key, "Editor.bin", conv.out);
  await putBundle(key, `origin.${session.file_type}`, src);
  for (const [name, bytes] of Object.entries(conv.media)) {
    await putBundle(key, `media/${name}`, bytes);
  }
  return { converted: true };
}

/**
 * Serialize the live editor to `Editor.bin`, convert to OOXML, and write both
 * the file and the refreshed bundle. Any connected client may call this —
 * the last write wins at the file layer; lunad advances the op-log base when
 * the new Editor.bin lands.
 *
 * @param {HTMLIFrameElement | null} iframe the DocsAPI frame (same-origin)
 * @param {string} driveId
 * @param {{ key: string, file_type: string }} session
 * @param {string} fileName original file name, for the overwrite upload
 * @param {string} folder drive-relative folder containing the file
 */
/**
 * Serialize the live document to its `Editor.bin` bytes via the editor's
 * native file API. Shared by the save and download paths.
 */
function nativeGetFileBytes(iframe) {
  const api = /** @type {any} */ (iframe?.contentWindow)?.Asc?.editor;
  if (!api) throw new Error("EuroOffice isn't ready yet. Try again in a moment.");
  let bin;
  if (typeof api.asc_nativeGetFile === "function") {
    bin = api.asc_nativeGetFile();
  } else if (typeof api.asc_nativeGetFile3 === "function") {
    const r = api.asc_nativeGetFile3();
    bin = r.header + r.data;
  } else {
    throw new Error("This EuroOffice build cannot save in the browser.");
  }
  const bytes =
    typeof bin === "string" ? new TextEncoder().encode(bin) : new Uint8Array(bin);
  // An empty serialize means asc_nativeGetFile failed — writing it would
  // replace the document with a corrupt file and still report "saved".
  if (bytes.length === 0) {
    throw new Error("EuroOffice returned an empty document. Try again.");
  }
  return bytes;
}

export async function saveEuroOfficeDocument(iframe, driveId, session, fileName, folder, coverage) {
  const bytes = nativeGetFileBytes(iframe);
  const ext = session.file_type;
  let conv;
  try {
    conv = await x2tConvert("Editor.bin", `out.${ext}`, bytes);
  } catch (err) {
    console.error("[eurooffice] save conversion failed:", err);
    throw new Error(
      `Luna couldn't write this document back to .${ext}. Your changes weren't saved.`,
    );
  }

  // 1) Write the user-facing file through the normal upload path (overwrite).
  const file = new File([/** @type {BlobPart} */ (conv.out)], fileName, {
    type: "application/octet-stream",
  });
  const form = new FormData();
  form.append("path", folder);
  form.append("file", file);
  // postForm throws ApiError on non-2xx.
  await postForm(
    `/api/v1/drives/${driveId}/files/upload?path=${encodeURIComponent(folder)}&overwrite=1`,
    form,
  );

  // 2) Refresh the bundle so joiners open the saved state; Editor.bin last so
  //    the base-advance only happens once every member is in place.
  for (const [name, b] of Object.entries(conv.media)) {
    await putBundle(session.key, `media/${name}`, b);
  }
  await putBundle(session.key, `origin.${ext}`, conv.out);
  await putBundle(session.key, "Editor.bin", bytes, coverage);
  return { bytes: conv.out.length };
}

// ---------- in-editor downloads (File → Download / Download As) ----------

/**
 * The editor's download menu calls `asc_DownloadAs`, whose stock path posts
 * the document to a Document Server `downloadas` endpoint — which does not
 * exist here. We patch it to run the same browser pipeline as saving:
 * nativeGetFile → x2t → blob download.
 *
 * Keys are `Asc.c_oAscFileType` values; only formats this x2t build can
 * actually write are listed — doc/xls/ppt, csv, html, epub, and md all fail
 * in this wasm build (verified in x2tFormats.test.js), and docm/xlsm/pptm/
 * ppsm would silently strip macros, so they fall through to the stock path
 * like the PDF entries (513/521; users can still use Print → Save as PDF,
 * which is fully client-side). A plain "Download" passes no options
 * (fileType 0) and falls back to the source format — but only when x2t can
 * actually write it; view-only sources (xlsm, fodt, …) defer to the stock
 * path rather than run a doomed conversion.
 */
const DOWNLOAD_AS_EXTS = {
  65: "docx", 67: "odt", 68: "rtf", 69: "txt", 76: "dotx",
  257: "xlsx", 259: "ods", 262: "xltx",
  129: "pptx", 131: "odp", 132: "ppsx",
};

const DOWNLOAD_AS_MIMES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  pdf: "application/pdf",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  rtf: "application/rtf",
  txt: "text/plain",
  csv: "text/csv",
  html: "text/html",
  epub: "application/epub+zip",
  md: "text/markdown",
};

/**
 * Serialize the live document, convert it to `outExt` via x2t, and trigger
 * a browser file download.
 */
export async function downloadEuroOfficeDocument(iframe, fileName, outExt) {
  const bytes = nativeGetFileBytes(iframe);
  const conv = await x2tConvert("Editor.bin", `download.${outExt}`, bytes);
  const base = fileName.replace(/\.[^.]+$/, "") || "document";
  const blob = new Blob([/** @type {BlobPart} */ (conv.out)], {
    type: DOWNLOAD_AS_MIMES[outExt] ?? "application/octet-stream",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${base}.${outExt}`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * Patch `asc_DownloadAs` on the live editor instance so its File → Download /
 * Download As menu entries produce real browser downloads. Unknown or absent
 * file types defer to the original implementation (which surfaces the
 * editor's own error). Installs once per editor instance.
 */
export function patchEuroOfficeDownloadAs(iframe, fileName) {
  const api = /** @type {any} */ (iframe?.contentWindow)?.Asc?.editor;
  if (!api || api.__lunaDownloadPatched || typeof api.asc_DownloadAs !== "function") return;
  const original = api.asc_DownloadAs.bind(api);
  const sourceExt = (fileName.split(".").pop() || "").toLowerCase();
  api.__lunaDownloadPatched = true;
  api.asc_DownloadAs = (options) => {
    const ft = Number(options?.fileType) || 0;
    const ext =
      DOWNLOAD_AS_EXTS[ft] ??
      (ft === 0 && OFFICE_SAVE_EXT.has(sourceExt) ? sourceExt : null);
    if (!ext) {
      original(options);
      return;
    }
    downloadEuroOfficeDocument(iframe, fileName, ext).catch((err) => {
      console.error("[eurooffice] download-as failed:", err);
      const asc = /** @type {any} */ (iframe?.contentWindow)?.Asc;
      api.sendEvent?.(
        "asc_onError",
        asc?.c_oAscError?.ID?.Unknown ?? 0,
        asc?.c_oAscError?.Level?.NoCritical ?? 0,
      );
    });
  };
}

/**
 * Keep the sdk's own save transaction from parking the saver's editor.
 *
 * The sdk was built for a Document Server that elects one client to
 * serialize+upload: `askSaveChanges` sends `isSaveLock` and moves `_state`
 * to `AskSaveChanges`, then the changes flush moves it to `SaveChanges`
 * until the `unSaveLock` reply lands. While `_state` sits in either save
 * state, every `askLock` — the range lock each cell edit takes — is pushed
 * onto `_lockBuffer` instead of the wire, and the pending lock holds
 * `m_bGlobalLock`, so the whole editor freezes for the transaction (or for
 * `errorTimeOutSave` = 60s, or until a disconnect, when the reply is lost).
 *
 * Luna elects savers with `lunaSaveLock` and saves via its own pipeline, so
 * the sdk election buys nothing here — it only costs the freeze. Two
 * changes, both applied to the live `DocsCoApi` instance:
 *
 * 1. `askSaveChanges` answers the callback itself ({saveLock:false}) — no
 *    `isSaveLock` frame, no `AskSaveChanges` window. The callback still
 *    runs `_onSaveChanges` → changes flush → `unSaveLock`, so co-editing
 *    traffic is unchanged.
 * 2. `askLock` never buffers for a save state: lunad's `get_lock` is
 *    save-state independent, so mid-flush lock requests go straight out —
 *    run the original grant path with `_state` momentarily reported as
 *    `Authorized` rather than queueing behind `unSaveLock`.
 *
 * Replies keep flowing because `check_state()` already accepts
 * Authorized|AskSaveChanges|SaveChanges.
 *
 * Installs once per editor instance.
 * @param {HTMLIFrameElement | null} iframe the DocsAPI frame (same-origin)
 */
export function patchEuroOfficeSaveState(iframe) {
  const w = /** @type {any} */ (iframe?.contentWindow);
  const co = w?.Asc?.editor?.CoAuthoringApi?._CoAuthoringApi;
  if (!co || co.__lunaSaveStatePatched) return;
  co.__lunaSaveStatePatched = true;
  const CS = w?.AscCommon?.ConnectionState || {};
  const AUTHORIZED = CS.Authorized ?? 2;
  const SAVE_STATES = new Set([CS.SaveChanges ?? 3, CS.AskSaveChanges ?? 11]);

  if (typeof co.askSaveChanges === "function" && !co.askSaveChanges.__lunaSaveState) {
    // The stock guard: one in-flight save callback at a time (its
    // _saveCallback tail check). We never populate _saveCallback — no
    // isSaveLock reply will arrive — so track it ourselves.
    let savePending = false;
    const wrapped = (callback) => {
      if (!callback || savePending) return;
      if (co._state === AUTHORIZED) {
        savePending = true;
        setTimeout(() => {
          savePending = false;
          try {
            callback({ saveLock: false });
          } catch {
            // the callback runs the changes flush; don't let it kill us
          }
        }, 0);
      } else {
        // Stock mirrors this error to callers when not Authorized.
        setTimeout(() => {
          try {
            callback({ error: "No connection" });
          } catch {
            // same as above
          }
        }, 100);
      }
    };
    wrapped.__lunaSaveState = true;
    co.askSaveChanges = wrapped;
  }

  if (typeof co.askLock === "function" && !co.askLock.__lunaSaveState) {
    const origAskLock = co.askLock.bind(co);
    const wrapped = (arrayBlockId, callback) => {
      if (SAVE_STATES.has(co._state)) {
        const st = co._state;
        co._state = AUTHORIZED;
        try {
          return origAskLock(arrayBlockId, callback);
        } finally {
          // The original never mutates _state itself — put the save state
          // back so the transaction bookkeeping stays honest.
          co._state = st;
        }
      }
      return origAskLock(arrayBlockId, callback);
    };
    wrapped.__lunaSaveState = true;
    co.askLock = wrapped;
  }
}

/**
 * Re-arm editing after a Luna save finishes.
 *
 * The editor app only restores input state from its window-focus handler —
 * which is why a wedged editor used to recover on tab blur→focus. A save
 * can leave four kinds of stale input state behind, all covered here:
 *
 * 1. A parked sdk save transaction (`_state` = SaveChanges/AskSaveChanges)
 *    whose reply never landed — lunad drops a foreign `saveChanges` when
 *    another participant holds `save_holder`, and the pending state buffers
 *    every `askLock`. `_onUnSaveLock`'s own recovery is just "Authorized +
 *    flush the lock buffer"; a late real reply then no-ops harmlessly.
 * 2. A `.asc-loadmask` with no matching `BlockInteraction` action on the
 *    app's stack — the mask swallows mouse input and `suspendEvents()` the
 *    shortcuts until a phantom `EndAction` arrives.
 * 3. `asc_enableKeyEvents(false)` left over — re-enabled unless a real
 *    modal is up (same guard the reconnect patch uses).
 * 4. The hidden keyboard sink (`TextBoxInput`, #area_id) losing DOM focus
 *    while `WordControl.IsFocus` stayed true — the case
 *    `asc_enableKeyEvents(true)` itself can't fix, since it only refocuses
 *    on a flag flip.
 *
 * Everything is best-effort and guarded: a genuine modal or a real
 * in-flight block action is left alone, and DOM focus is only pulled back
 * into the editor when the iframe already owns it (never steals from the
 * surrounding Luna UI).
 * @param {HTMLIFrameElement | null} iframe the DocsAPI frame (same-origin)
 */
export function restoreEuroOfficeEditing(iframe) {
  try {
    const w = /** @type {any} */ (iframe?.contentWindow);
    const api = w?.Asc?.editor;
    const doc = w?.document;
    if (!api || !doc) return;
    const modal = !!w.Common?.Utils?.ModalWindow?.isVisible?.();

    const co = api.CoAuthoringApi?._CoAuthoringApi;
    const CS = w.AscCommon?.ConnectionState ?? {};
    const SAVE_STATES = new Set([
      CS.SaveChanges ?? 3,
      CS.AskSaveChanges ?? 11,
    ]);
    if (co && SAVE_STATES.has(co._state)) {
      co._state = CS.Authorized ?? 2;
      co._sendBufferedLocks?.();
    }

    const app = w.DE || w.PE || w.SSE || w.PDFE || w.VE;
    const main = app?.getController?.("Main");
    const hasBlockAction = !!main?.stackLongActions?.get?.({
      type: w.Asc?.c_oAscAsyncActionType?.BlockInteraction,
    });
    if (!modal && !hasBlockAction) {
      if (main?.loadMask?.isVisible?.() || doc.querySelector?.(".asc-loadmask")) {
        main?.loadMask?.hide?.();
        doc
          .querySelectorAll?.(".asc-loadmask, .asc-loadmask-body")
          ?.forEach((el) => el.remove());
        w.Common?.util?.Shortcuts?.resumeEvents?.();
      }
    }

    if (!modal) api.asc_enableKeyEvents?.(true);

    const sink =
      api.WordControl?.TextBoxInput ?? doc.getElementById?.("area_id");
    if (
      sink &&
      !modal &&
      doc.hasFocus?.() === true &&
      doc.activeElement !== sink &&
      (!doc.activeElement ||
        doc.activeElement === doc.body ||
        doc.activeElement === doc.documentElement)
    ) {
      sink.focus?.();
    }
  } catch {
    // Never let focus/state restoration break the save path.
  }
}

/**
 * Focus watchdog for the editor frame.
 *
 * EuroOffice types through a hidden textarea sink (`#area_id`), and the
 * sdk's only refocus path is a document-capture `focus` listener inside
 * the frame. When DOM focus leaves the frame entirely — a rail click, a
 * Luna dialog — the browser resets the frame document's activeElement to
 * <body>. Clicking back in refocuses the *frame* but no element inside
 * (the sdk cancels the press's default action), so that listener never
 * runs and keystrokes land on <body> — dead until a window blur→focus.
 *
 * Rather than patching every theft path, the frame owns one invariant,
 * enforced on a timer and on the two moments it can break:
 *
 *   While the editor frame is the focused browsing context, and no real
 *   input inside it owns DOM focus, the keyboard sink holds DOM focus.
 *
 * Triggers:
 *
 * - window `focus` — the frame regained focus; enforce on the spot.
 * - capture `pointerdown` — when the press starts unfocused (some engines
 *   skip frame focus on a canceled mousedown), pull the frame in through
 *   window.focus() AND the sink element itself — whichever the engine
 *   honors — then enforce.
 * - interval — heals everything else: modal closes, focus-restore quirks,
 *   sdk internals that park activeElement on <body> with no event.
 *
 * Focus is never stolen: while the frame isn't focused, a real modal is
 * up, or a genuine input / plugin frame / sdk keyboard element inside
 * owns DOM focus, nothing happens.
 *
 * Returns an unsubscribe fn.
 * @param {HTMLIFrameElement | null} iframe the DocsAPI frame (same-origin)
 */
export function watchEuroOfficeFocus(iframe) {
  const w = /** @type {any} */ (iframe?.contentWindow);
  const doc = iframe?.contentDocument;
  if (!w || !doc) return () => {};

  const getSink = () =>
    /** @type {HTMLElement | null} */ (
      w.Asc?.editor?.WordControl?.TextBoxInput ??
      doc.getElementById?.("area_id") ??
      null
    );

  /**
   * A legitimate focus owner inside the editor — editable fields, plugin
   * frames, or elements the sdk flags to keep keyboard focus
   * (oo_editor_input / oo_editor_keyboard). Everything else is fair game
   * for the sink, matching the sdk's own capture-focus policy.
   */
  const ownsFocus = (el) => {
    const tag = el?.nodeName;
    return (
      tag === "INPUT" ||
      tag === "TEXTAREA" ||
      tag === "IFRAME" ||
      !!el?.isContentEditable ||
      !!el?.closest?.("[oo_editor_input],[oo_editor_keyboard]")
    );
  };

  const enforce = () => {
    try {
      const api = w.Asc?.editor;
      if (!api || !doc.hasFocus?.()) return;
      if (w.Common?.Utils?.ModalWindow?.isVisible?.()) return;
      const sink = getSink();
      if (!sink) return;
      const ae = doc.activeElement;
      if (ae === sink) {
        // Sink focused but the key pipeline may be disarmed — cheap no-ops
        // when already enabled.
        api.asc_enableKeyEvents?.(true);
        w.AscCommon?.g_inputContext?.setInterfaceEnableKeyEvents?.(true);
        return;
      }
      if (ae && ae !== doc.body && ae !== doc.documentElement && ownsFocus(ae)) {
        return;
      }
      api.asc_enableKeyEvents?.(true);
      w.AscCommon?.g_inputContext?.setInterfaceEnableKeyEvents?.(true);
      sink.focus?.();
    } catch {
      // A broken tick must not kill the watchdog — the next one heals.
    }
  };

  const onWindowFocus = () => setTimeout(enforce, 0);
  const onPress = () => {
    if (!doc.hasFocus()) {
      try {
        w.focus();
      } catch {
        // engines differ on iframe window.focus()
      }
      // Where window.focus() is ignored for frames, focusing the sink
      // element drags the whole focus chain into the frame — the same way
      // the sdk's own init focus works.
      try {
        getSink()?.focus?.();
      } catch {
        // ignore
      }
    }
    enforce();
  };

  const pressEvent =
    typeof w.PointerEvent === "function" ? "pointerdown" : "mousedown";
  w.addEventListener("focus", onWindowFocus);
  doc.addEventListener(pressEvent, onPress, true);
  const id = setInterval(enforce, 150);
  return () => {
    clearInterval(id);
    w.removeEventListener("focus", onWindowFocus);
    doc.removeEventListener(pressEvent, onPress, true);
  };
}

/**
 * Transparent reconnect for the docstorage socket.
 *
 * The pack cannot recover a raw transport close on its own:
 * `socket.on("disconnect")` → `co.onDisconnect()` → the api tears down
 * editing (view mode + a blocking "connection lost" dialog) and calls
 * `socketio.disconnect()`, which marks the manager skipReconnect — the
 * session is dead until a manual reload.
 *
 * `co.onDisconnect` is called WITHOUT a code for raw drops, but always WITH
 * a code for server-initiated disconnects (`disconnectReason`, `disconnect`
 * messages). So: no code → rebuild the socket through `_initSocksJs()`
 * before the teardown runs; the fresh manager re-auths (echoing the old
 * sessionId so lunad reclaims the zombie participant), queued ops flush,
 * and the editor never leaves edit mode. A real coded disconnect still
 * tears down honestly, as does a rebuild that keeps failing.
 *
 * Installs once per editor instance.
 */
/**
 * Announce on the docstorage socket that this client finished a real save
 * (serialize → x2t → upload). lunad relays `lunaSaved` to every peer so
 * their dirty flags and autosave timers reset — the saved marker is shared
 * state, not per-client.
 * @param {HTMLIFrameElement | null} iframe the DocsAPI frame (same-origin)
 * @param {number | null} snapshotIndex op index the serialized doc held
 */
export function emitEuroOfficeSaved(iframe, snapshotIndex = null) {
  const co = /** @type {any} */ (iframe?.contentWindow)?.Asc?.editor
    ?.CoAuthoringApi?._CoAuthoringApi;
  try {
    // _send buffers while disconnected and flushes on rejoin — a save that
    // landed during a socket blip still reaches peers, just late. The
    // changesIndex tells peers which op index made the snapshot so a peer
    // holding newer ops keeps its dirty flag instead of losing the tail.
    co?._send?.({ type: "lunaSaved", changesIndex: snapshotIndex });
  } catch {
    // best-effort notice; the save itself already happened
  }
}

/**
 * Ask lunad for the save election over the docstorage socket via Luna's own
 * `lunaSaveLock` frame — deliberately NOT the sdk's `isSaveLock`. The sdk's
 * pair drives its connection state machine: `_state` sits at AskSaveChanges
 * until an `unSaveLock` reply lands, and while it does every `askLock` (the
 * paragraph lock behind each edit) is buffered — holding it across a whole
 * serialize+upload froze the saver's own editor, and an unanswered
 * `unSaveLock` wedged it outright. This frame is inert to the sdk; only this
 * listener observes the reply.
 *
 * Resolves `true` when the election is ours. Fails open (`true`) when the
 * socket is dead — with no socket there is no room to clash with, and the
 * save must still be able to land.
 * @param {HTMLIFrameElement | null} iframe the DocsAPI frame (same-origin)
 * @param {number} timeoutMs max wait for the election reply
 */
export function requestEuroOfficeSaveLock(iframe, timeoutMs = 4_000) {
  return new Promise((resolve) => {
    const getCo = () =>
      /** @type {any} */ (iframe?.contentWindow)?.Asc?.editor
        ?.CoAuthoringApi?._CoAuthoringApi;
    /** @type {any} */ let socket = null;
    /** @type {any} */ let poll = null;
    let done = false;
    const finish = (granted) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (poll) clearInterval(poll);
      socket?.off?.("message", onMessage);
      resolve(granted);
    };
    const onMessage = (data) => {
      if (data?.type === "lunaSaveLock") finish(data.saveLock === false);
    };
    const timer = setTimeout(() => finish(true), timeoutMs);
    const trySend = () => {
      const co = getCo();
      const s = co?.socketio;
      if (!s) return false;
      socket = s;
      s.on?.("message", onMessage);
      try {
        co._send?.({ type: "lunaSaveLock" });
      } catch {
        // fall through — the timeout path resolves fail-open
      }
      return true;
    };
    // The socket may be briefly absent mid-reconnect — poll for it; a
    // permanently dead socket fails open at the timeout.
    if (!trySend()) {
      poll = setInterval(() => {
        if (trySend() && poll) clearInterval(poll);
      }, 200);
    }
  });
}

/**
 * Release the save election after a save attempt. Fire-and-forget — the
 * bundle PUT releases it server-side too, so a lost frame can't wedge the
 * room; this just frees peers' next election without waiting for the TTL.
 * @param {HTMLIFrameElement | null} iframe
 */
export function releaseEuroOfficeSaveLock(iframe) {
  const co = /** @type {any} */ (iframe?.contentWindow)?.Asc?.editor
    ?.CoAuthoringApi?._CoAuthoringApi;
  try {
    co?._send?.({ type: "lunaSaveEnd" });
  } catch {
    // best-effort release
  }
}

/**
 * Attach a `message` listener to the docstorage socket. The listener binds
 * to the *current* socket.io socket and re-attaches after every reconnect
 * rebuild (`__lunaRebuiltCbs`, fired by patchEuroOfficeReconnect's attempt
 * loop). Returns an unsubscribe fn.
 * @param {HTMLIFrameElement | null} iframe
 * @param {(data: any) => void} cb
 */
export function watchEuroOfficeSocket(iframe, cb) {
  const getCo = () =>
    /** @type {any} */ (iframe?.contentWindow)?.Asc?.editor
      ?.CoAuthoringApi?._CoAuthoringApi;
  /** @type {any} */
  let attached = null;
  const attach = () => {
    const co = getCo();
    const s = co?.socketio;
    if (s && s !== attached) {
      s.on?.("message", cb);
      attached = s;
    }
    if (co) (co.__lunaRebuiltCbs ??= new Set()).add(attach);
  };
  attach();
  // socketio/co may not exist yet (pre-connect) — keep retrying; the
  // rebuild hook then re-attaches after any later socket swap.
  const poll = setInterval(attach, 500);
  return () => {
    clearInterval(poll);
    getCo()?.__lunaRebuiltCbs?.delete(attach);
    attached?.off?.("message", cb);
  };
}

/**
 * Observe `lunaSaved` broadcasts from peers.
 * @param {HTMLIFrameElement | null} iframe
 * @param {(data: any) => void} cb
 */
export function watchEuroOfficeSaved(iframe, cb) {
  return watchEuroOfficeSocket(iframe, (data) => {
    if (data?.type === "lunaSaved") cb(data);
  });
}

/**
 * Observe foreign ops on the docstorage socket. `saveChanges`/`authChanges`
 * frames are always someone else's work (our own broadcast never echoes
 * back), so any of them means the shared live document is ahead of the file
 * on disk — every client should report unsaved state, not just the one
 * that typed.
 * @param {HTMLIFrameElement | null} iframe
 * @param {(data: any) => void} cb
 */
export function watchEuroOfficeChanges(iframe, cb) {
  return watchEuroOfficeSocket(iframe, (data) => {
    if (data?.type === "saveChanges" || data?.type === "authChanges") cb(data);
  });
}

/**
 * Diagnostic breadcrumb: collab state transitions land in
 * `iframe.contentWindow.__lunaCollabLog` (ring, last 100) and the debug
 * console. The editor's failure modes are silent otherwise — a parked view
 * mode looks identical to ten different causes.
 */
function collabLog(w, msg) {
  try {
    const log = (w.__lunaCollabLog ??= []);
    log.push({ t: Date.now(), msg });
    if (log.length > 100) log.shift();
    console.debug(`[luna-collab] ${msg}`);
  } catch {
    // logging must never break the patch
  }
}

export function patchEuroOfficeReconnect(iframe) {
  const w = /** @type {any} */ (iframe?.contentWindow);
  const api = w?.Asc?.editor;
  const co = api?.CoAuthoringApi?._CoAuthoringApi;
  if (!api || !co || typeof co._initSocksJs !== "function") return;
  // Each wrapper installs independently — call sites retry until every
  // marker sticks, since init/app boot may clobber or late-load them.
  // `co.__lunaRebuilding` is the shared flag: while set, every teardown
  // path a transient drop can reach is suspended.

  // Second teardown path: an EditingError (e.g. an op exceptioning on the
  // dead socket) calls `asc_coAuthoringDisconnect`, which kills the rebuilt
  // socket and flips `isCoAuthoringEnable`+view mode.
  if (typeof api.asc_coAuthoringDisconnect === "function" && !api.asc_coAuthoringDisconnect.__lunaReconnect) {
    const origCod = api.asc_coAuthoringDisconnect.bind(api);
    const wrappedCod = () => {
      if (co.__lunaRebuilding) return;
      origCod();
    };
    wrappedCod.__lunaReconnect = true;
    api.asc_coAuthoringDisconnect = wrappedCod;
  }
  // Third teardown path: `asc_onError` reaches the app's onError handler,
  // which shows a blocking alert whose OK callback runs
  // `disableEditing(true)` + `api:disconnect`. Errors surfaced mid-rebuild
  // are almost always fallout from the drop itself (editing ops hitting the
  // dead socket, session warnings) — swallow them all for the bounded
  // window; a genuine error resurfaces on the next op.
  if (typeof api.sendEvent === "function" && !api.sendEvent.__lunaReconnect) {
    const origSend = api.sendEvent.bind(api);
    const wrappedSend = (...args) => {
      if (co.__lunaRebuilding && args[0] === "asc_onError") return;
      return origSend(...args);
    };
    wrappedSend.__lunaReconnect = true;
    api.sendEvent = wrappedSend;
  }
  // Fourth: `Common.NotificationCenter.trigger("api:disconnect")` is the
  // app-level kill broadcast — every controller's onCoAuthoringDisconnect
  // hooks it (toolbar locks, left menu off, Viewport isDisconnected, the
  // whole cascade). onUsersChanged fires it when it thinks co-authoring is
  // unlicensed, which is exactly what a mid-rejoin participants list looks
  // like after a disconnect. Suppress it while rebuilding.
  const nc = w.Common?.NotificationCenter;
  if (typeof nc?.trigger === "function" && !nc.trigger.__lunaReconnect) {
    const origTrigger = nc.trigger.bind(nc);
    const wrappedTrigger = (name, ...rest) => {
      if (co.__lunaRebuilding && name === "api:disconnect") return;
      return origTrigger(name, ...rest);
    };
    wrappedTrigger.__lunaReconnect = true;
    nc.trigger = wrappedTrigger;
  }

  // Typing while the socket is down trips the api's own edit denial, which
  // flips view mode independently of the disconnect teardown. Once the
  // rebuilt socket re-auths, lift it back (plus the toolbar's lostConnect
  // lock) — but only for edit sessions.
  const restoreEditMode = () => {
    const w = /** @type {any} */ (iframe?.contentWindow);
    const api = w?.Asc?.editor;
    if (!api || co.get_state?.() !== 2) return;
    co.__lunaRebuilding = false;
    try {
      // Locks stranded by the drop never resolve on their own: _lockBuffer
      // entries only drain on unSaveLock, and a getLock sent on the dead
      // socket keeps its callback pending until errorTimeOut (10s) — the
      // whole time m_bGlobalLock stays set and editing is frozen. lunad
      // released the departed socket's locks on disconnect, so fail the
      // strays and re-ask the buffer against the live socket.
      for (const id of Object.keys(co._lockCallbacks || {})) {
        try {
          co._lockCallbacks[id]?.({ error: "reconnect" });
        } catch {
          // a callback that throws must not stall the rest of the drain
        }
        delete co._lockCallbacks[id];
        if (co._lockCallbacksErrorTimerId?.[id]) {
          clearTimeout(co._lockCallbacksErrorTimerId[id]);
          delete co._lockCallbacksErrorTimerId[id];
        }
      }
      for (const id of Object.keys(co._locks || {})) {
        if (co._locks[id]?.state === 1) co._locks[id].state = 0;
      }
      try {
        co._sendBufferedLocks?.();
      } catch {
        // best-effort — individual askLock failures self-resolve
      }
      if (co.mode === "edit") {
        api.isCoAuthoringEnable = true;
        if (api.getViewMode?.() === true) api.asc_setViewMode?.(false);
      }
      const app = w.DE || w.PE || w.SSE || w.PDFE || w.VE;
      const tb = app?.getController?.("Toolbar");
      tb?.lockToolbar?.(w.Common?.enumLock?.lostConnect, false);
      // editMode=false + DisableToolbar(true) ran on disconnect — re-enable.
      tb?.DisableToolbar?.(false, false);
      const main = app?.getController?.("Main");
      if (main?._state) main._state.isDisconnected = false;
      // A modal that still slipped through would leave key events off.
      if (!w.Common?.Utils?.ModalWindow?.isVisible?.()) {
        api.asc_enableKeyEvents?.(true);
      }
    } catch {
      // App internals may differ — the socket recovery is what matters.
    }
  };
  // After a rebuild, auth lands a beat behind the transport connect — poll
  // briefly for Authorized before restoring.
  const watchAuth = (n) => {
    if (co.get_state?.() === 2) {
      restoreEditMode();
      return;
    }
    if (n <= 0) {
      // Connected but never Authorized — the session is dead in a way the
      // rebuild path can't fix (e.g. auth result 0), so hand off to a
      // remount rather than sitting half-attached forever.
      co.__lunaRebuilding = false;
      co.__lunaConceded = true;
      collabLog(w, "auth never arrived after rebuild — conceding to remount");
      return;
    }
    // If the socket dies again mid-watch, onDisconnect re-arms the flag and
    // restarts the rebuild — don't race it here.
    if (co.socketio?.connected === true) setTimeout(() => watchAuth(n - 1), 500);
  };
  let tries = 0;
  let retryId;
  const attempt = () => {
    retryId = undefined;
    if (co.socketio?.connected === true) {
      tries = 0;
      // Keep __lunaRebuilding until Authorized — the dead-window ops get
      // replayed/acked during rejoin, and their errors must stay swallowed
      // or the app's alert would disable editing all over again.
      watchAuth(20);
      return;
    }
    // ~60s of retries before conceding — long enough to ride out a lunad
    // restart without giving up on a momentary blip.
    if (++tries > 30) {
      tries = 0;
      co.__lunaRebuilding = false;
      // The rebuild path is exhausted — flag it so the host remounts the
      // editor against a fresh session (new session endpoint = new token,
      // which also heals a refused-auth loop), then run the original
      // uncoded-drop handler so the app shows its honest disconnect state
      // while the remount spins up.
      co.__lunaConceded = true;
      collabLog(w, "reconnect budget exhausted — conceding to remount");
      co.__lunaOnDisconnect?.();
      return;
    }
    co.__lunaRebuilding = true;
    collabLog(w, `socket rebuild attempt ${tries}`);
    try {
      co.socketio?.disconnect?.();
    } catch {
      // already dead — the point was a fresh manager anyway
    }
    co.isCloseCoAuthoring = false;
    try {
      co._initSocksJs();
      // lunad only speaks the websocket transport; the pack's own
      // connect_error handler would otherwise flip retries to a
      // polling-first order we can't serve.
      const opts = co.socketio?.io?.opts;
      if (opts) opts.transports = ["websocket"];
      // Host listeners (e.g. lunaSaved) bound to the old socket — re-attach.
      co.__lunaRebuiltCbs?.forEach((/** @type {() => void} */ fn) => {
        try {
          fn();
        } catch {
          // one bad listener must not break the rebuild
        }
      });
    } catch {
      // retry below
    }
    retryId = setTimeout(attempt, 2_000);
  };
  // The entry point: `co.onDisconnect` is called WITHOUT a code for raw
  // transport drops, but always WITH a code for server-initiated
  // disconnects. No code → suppress the teardown and rebuild; coded →
  // honest teardown. The original handler is captured fresh each re-wrap
  // because CDocsCoApi.init can clobber ours — keep the latest non-wrapped
  // one on `co` so retries never chain wrappers.
  if (typeof co.onDisconnect === "function" && co.onDisconnect.__lunaReconnect !== true) {
    co.__lunaOnDisconnect = co.onDisconnect.bind(co);
  }
  if (co.onDisconnect?.__lunaReconnect !== true) {
    const wrapped = (reason, code) => {
      // "reconnect_failed" is a socket.io *manager* event — it never arrives
      // as a message frame, and its code isn't in the sdk's refreshable set,
      // so the stock path would park the editor in view mode for good. The
      // manager is dead but _initSocksJs builds a fresh one, so treat it
      // like a raw transport drop and rebuild.
      if (code != null && reason !== "reconnect_failed") {
        // Server-directed disconnect — real teardown, suppression off.
        co.__lunaRebuilding = false;
        collabLog(w, `coded drop: ${String(reason)} code=${String(code)}`);
        co.__lunaOnDisconnect?.(reason, code);
        return;
      }
      collabLog(w, `drop: ${String(reason)} code=${String(code)} — rebuilding`);
      // Do NOT reset `tries` here: a refused/flapping CONNECT lands back in
      // this wrapper via connect_error on every failed rebuild, and resetting
      // the budget each time meant the concede path below was unreachable —
      // the editor spun in a rebuild loop forever instead of remounting.
      co.__lunaRebuilding = true;
      if (retryId == null) retryId = setTimeout(attempt, 800);
    };
    wrapped.__lunaReconnect = true;
    co.onDisconnect = wrapped;
  }
}

/**
 * Extension → DocsAPI `documentType`. The table itself lives in
 * fileKinds.js — every entry there is verified by a real x2t conversion in
 * x2tFormats.test.js, so this is a straight lookup.
 * @param {string} pathOrName
 * @returns {"word"|"cell"|"slide"|null}
 */
export function euroOfficeDocumentType(pathOrName) {
  return OFFICE_FORMATS[fileExtension(pathOrName)] ?? null;
}

/**
 * True when this extension can round-trip through x2t (open + save). Other
 * office extensions may still open for viewing/conversion but must not
 * overwrite the original — macro-enabled formats would lose their VBA
 * project, and flat ODF / legacy xls/ppt have no writer in this build.
 * @param {string} ext
 */
export function canSaveOfficeExt(ext) {
  return OFFICE_SAVE_EXT.has(String(ext || "").toLowerCase().replace(/^\./, ""));
}
