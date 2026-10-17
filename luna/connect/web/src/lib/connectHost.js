/** The only site where people should type a recovery phrase. Fixed in the build, never read from the page's own address, so a copy of this page on another site can't show its own name. */
export const CONNECT_HOST = "connect.luna.libreloom.org";
export const PHISHING_LINE = `Only type your recovery phrase on ${CONNECT_HOST}.`;
