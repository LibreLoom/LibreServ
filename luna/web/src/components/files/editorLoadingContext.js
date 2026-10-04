import { createContext } from "react";

/**
 * Lets an editor ask the fullscreen frame to show its loading screen.
 *
 * The frame draws one dot-matrix loader for the whole open — through the
 * code download and the editor's own startup — so the animation never
 * restarts when one component hands off to the next.
 *
 * @type {import("react").Context<null | {
 *   setLoader: (id: string, label: string | null) => void,
 *   markMounted: () => void,
 * }>}
 */
export const EditorLoadingContext = createContext(null);
