/**
 * Action errors shared between a page and its modals should render in the
 * modal while it is open, not on the page behind it.
 *
 * @param {string|null|undefined} error
 * @param {boolean} modalOpen
 */
export function showPageLevelError(error, modalOpen) {
  return Boolean(error) && !modalOpen;
}
