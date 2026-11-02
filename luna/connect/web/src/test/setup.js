// Node 22+ exposes an experimental global localStorage that is undefined
// unless --localstorage-file is set, which hides jsdom's own. Put jsdom's back.
if (typeof globalThis.localStorage === "undefined" || !globalThis.localStorage?.getItem) {
  const real = globalThis.jsdom?.window?.localStorage;
  if (real) Object.defineProperty(globalThis, "localStorage", { configurable: true, value: real });
}
