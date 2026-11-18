// lunad's photo thumbnails come in two sizes: the regular one (640 px long
// edge) and a grid-sized one (`&size=s`, 360 px). See lunad's
// api/photos/small_thumb.rs.

const LUNAD_THUMB = "/api/v1/photos/thumb?";

/**
 * True for a lunad thumbnail URL, which has the small variant.
 * @param {string | undefined} thumb
 */
export function isLunadThumb(thumb) {
  return typeof thumb === "string" && thumb.startsWith(LUNAD_THUMB);
}

/**
 * `srcset` for a grid cell: the small thumbnail and the regular one. Widths
 * name the short edge of a 4:3 photo, since the cell is a square crop, so
 * the browser takes the small one only when it still covers the cell at
 * this screen's pixel density.
 * @param {string} thumb
 */
export function gridThumbSrcSet(thumb) {
  return `${thumb}&size=s 270w, ${thumb} 480w`;
}

/**
 * `srcset` for the viewer's stand-in while the photo loads: the same size the
 * grid picked on a typical screen (small at 1x, regular above), so it comes
 * from the browser cache instead of a second download.
 * @param {string} thumb
 */
export function stageThumbSrcSet(thumb) {
  return `${thumb}&size=s 1x, ${thumb} 2x`;
}
