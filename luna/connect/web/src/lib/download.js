/** Save a Blob as a file download. @param {Blob} blob @param {string} filename */
export function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename || "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Some browsers cancel the download if the URL is revoked before it starts, so keep it for a minute.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}
