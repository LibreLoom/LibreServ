// x2t.wasm worker: OOXML <-> Editor.bin conversion, off the main thread.
//
// This file is served from inside the pack at /eurooffice/x2t/ — the x2t
// build's own locateFile resolves "x2t.wasm" relative to the worker script's
// directory, so keeping them side-by-side is what makes the wasm load work.
// x2t.js is a classic (non-modularized) emscripten build: it populates a
// global `Module` object, which must exist before importScripts runs.
/* global importScripts */

const PACK = "/eurooffice";

self.Module = {
  onRuntimeInitialized: () => {},
};
const readyP = new Promise((resolve) => {
  self.Module.onRuntimeInitialized = resolve;
});
importScripts("x2t.js");
const x2t = self.Module;

function ensureDirs() {
  for (const d of ["/working", "/working/media", "/working/fonts", "/working/themes"]) {
    try {
      x2t.FS.mkdir(d);
    } catch {
      /* exists */
    }
  }
}

let fontsLoaded = false;
async function loadFonts() {
  if (fontsLoaded) return;
  // The install script writes fonts-manifest.json next to the pack: a list of
  // TTF paths relative to /eurooffice/. Missing manifest → conversion still
  // works for simple docx, so tolerate 404s.
  let list = [];
  try {
    const res = await fetch(`${PACK}/fonts-manifest.json`, { credentials: "same-origin" });
    if (res.ok) list = await res.json();
  } catch {
    list = [];
  }
  for (const rel of list) {
    try {
      const buf = new Uint8Array(
        await (await fetch(`${PACK}/${rel}`, { credentials: "same-origin" })).arrayBuffer(),
      );
      x2t.FS.writeFile(`/working/fonts/${rel.split("/").pop()}`, buf);
    } catch {
      /* skip unreadable font */
    }
  }
  fontsLoaded = true;
}

function cleanWork() {
  const wipe = (dir) => {
    for (const f of x2t.FS.readdir(dir)) {
      if (f === "." || f === "..") continue;
      const p = `${dir}/${f}`;
      try {
        x2t.FS.unlink(p);
      } catch {
        try {
          x2t.FS.rmdir(p);
        } catch {
          /* keep */
        }
      }
    }
  };
  wipe("/working");
  ensureDirs();
}

function convert(inputBytes, inName, outName) {
  cleanWork();
  const params =
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<TaskQueueDataConvert xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
    "<m_sFontDir>/working/fonts/</m_sFontDir>" +
    "<m_sThemeDir>/working/themes</m_sThemeDir>" +
    `<m_sFileFrom>/working/${inName}</m_sFileFrom>` +
    `<m_sFileTo>/working/${outName}</m_sFileTo>` +
    "<m_bIsNoBase64>false</m_bIsNoBase64>" +
    "<m_nCsvTxtEncoding>46</m_nCsvTxtEncoding>" +
    "<m_nCsvDelimiter>4</m_nCsvDelimiter>" +
    "</TaskQueueDataConvert>";
  try {
    x2t.FS.writeFile("/working/params.xml", params);
    x2t.FS.writeFile(`/working/${inName}`, inputBytes);
  } catch (e) {
    throw new Error(`fs-write ${e && e.errno}: ${e && e.message}`);
  }
  const code = x2t.ccall("main1", "number", ["string"], ["/working/params.xml"]);
  if (code !== 0) throw new Error(`x2t exit ${code}`);
  const out = x2t.FS.readFile(`/working/${outName}`);
  const media = {};
  try {
    for (const f of x2t.FS.readdir("/working/media")) {
      if (f === "." || f === "..") continue;
      media[f] = x2t.FS.readFile(`/working/media/${f}`);
    }
  } catch {
    /* no media */
  }
  return { out, media };
}

self.onmessage = async (e) => {
  const { id, op, inName, outName, input } = e.data || {};
  try {
    await readyP;
    ensureDirs();
    if (op !== "convert") throw new Error("bad op");
    await loadFonts();
    const { out, media } = convert(new Uint8Array(input), inName, outName);
    const transfer = [out.buffer, ...Object.values(media).map((m) => m.buffer)];
    self.postMessage({ id, ok: true, out, media }, transfer);
  } catch (err) {
    const detail =
      err && err.message
        ? err.message
        : typeof err === "object"
          ? JSON.stringify(err).slice(0, 500)
          : String(err);
    self.postMessage({ id, ok: false, error: detail });
  }
};
