/**
 * `.drawio` file helpers — the on-disk format is diagrams.net XML. The
 * `.drawio.svg` / `.drawio.png` variants carry the same diagram embedded in
 * an image container, so saving those writes an image file back, not XML.
 */

/** A new blank diagram, matching what draw.io writes for an empty file. */
export const BLANK_DRAWIO_XML = `<mxfile host="Luna" type="device">
  <diagram name="Page-1" id="luna-blank-diagram">
    <mxGraphModel dx="1422" dy="762" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="850" pageHeight="1100" math="0" shadow="0">
      <root>
        <mxCell id="0" />
        <mxCell id="1" parent="0" />
      </root>
    </mxGraphModel>
  </diagram>
</mxfile>
`;

/**
 * The container the file lives in. `"xml"` is a plain `.drawio` document;
 * `"svg"`/`"png"` are the embedded-preview variants that save back through
 * the editor's export path (xmlsvg/xmlpng) instead of a raw XML write.
 *
 * @param {string} name
 * @returns {"xml" | "svg" | "png"}
 */
export function diagramContainer(name) {
  const base = (String(name || "").split("/").pop() || "").toLowerCase();
  if (base.endsWith(".drawio.svg")) return "svg";
  if (base.endsWith(".drawio.png")) return "png";
  return "xml";
}

/** draw.io embed export format for a container — fed to `{action:"export"}`. */
export const DIAGRAM_EXPORT_FORMAT = {
  xml: "xml",
  svg: "xmlsvg",
  png: "xmlpng",
};

/** MIME type for the bytes written back to the drive. */
export const DIAGRAM_MIME = {
  xml: "application/vnd.jgraph.mxfile",
  svg: "image/svg+xml",
  png: "image/png",
};
