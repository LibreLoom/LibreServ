/**
 * foliate-js ships plain ESM without type declarations. The reader treats its
 * surface (book objects, <foliate-view>) as untyped — see lib/epubReader.js
 * for the JSDoc'd wrapper layer.
 */
declare module "foliate-js/*" {
  const anyExport: any;
  export = anyExport;
}
