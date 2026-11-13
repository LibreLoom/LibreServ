/**
 * The text editor (CodeMirror, Yjs and the Markdown preview) is a separate
 * chunk. Loading it on the click put that work in the middle of the file
 * viewer's opening animation, which read as a stutter. Warm it while the
 * folder is settling and when the pointer reaches a file that will use it;
 * the module system caches the result, so the click only mounts it.
 */
let warming = null;

export function warmTextEditor() {
  if (!warming) {
    warming = import("./TextFileEditor.jsx").catch(() => {
      // A failed warm-up is harmless: the real open will try again.
      warming = null;
    });
  }
  return warming;
}
