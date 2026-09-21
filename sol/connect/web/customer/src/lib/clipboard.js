/**
 * Write text to the clipboard with a legacy fallback for insecure contexts
 * (plain HTTP on a LAN IP), where the Clipboard API isn't exposed.
 * @param {string} text
 * @returns {Promise<boolean>} true if copied successfully
 */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      await legacyWriteText(text);
    }
    return true;
  } catch {
    return false;
  }
}

function legacyWriteText(text) {
  return new Promise((resolve, reject) => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "");
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.select();
    try {
      if (document.execCommand("copy")) {
        resolve();
      } else {
        reject(new Error("execCommand('copy') returned false"));
      }
    } catch (err) {
      reject(err);
    } finally {
      document.body.removeChild(textarea);
    }
  });
}
