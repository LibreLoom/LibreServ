// A format can be observed by both its card and its sheet. Announce it once.
const announced = new Set();

export function announceFormat(operation, addToast) {
  if (!operation || announced.has(operation.id)) return;
  announced.add(operation.id);
  if (operation.state === "succeeded") {
    addToast({ type: "success", message: "Drive formatted." });
  } else {
    addToast({ type: "error", message: operation.state === "interrupted" ? "Drive formatting was interrupted." : "Could not format this drive.", description: "Open Format for details and inspect the drive again." });
  }
}
