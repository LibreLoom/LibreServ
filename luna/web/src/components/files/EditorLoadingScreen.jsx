import { useContext, useEffect, useId, useLayoutEffect } from "react";
import PropTypes from "prop-types";
import { EditorLoadingContext } from "./editorLoadingContext.js";
import DocumentLoadingScreen from "./DocumentLoadingScreen.jsx";

const useIsomorphicLayoutEffect =
  typeof window !== "undefined" ? useLayoutEffect : useEffect;

/**
 * Render where an editor would show its loading screen. Inside a
 * `FullscreenEditorFrame` it hands the label to the frame's loader and
 * renders nothing; elsewhere it draws the loading screen itself.
 *
 * @param {{ label?: string, className?: string }} props
 */
export default function EditorLoadingScreen({ label = "Opening…", className = "" }) {
  const frame = useContext(EditorLoadingContext);
  const id = useId();
  const setLoader = frame?.setLoader;

  useIsomorphicLayoutEffect(() => {
    if (!setLoader) return undefined;
    setLoader(id, label);
    return () => setLoader(id, null);
  }, [setLoader, id, label]);

  if (frame) return null;
  return <DocumentLoadingScreen label={label} className={className} />;
}

EditorLoadingScreen.propTypes = {
  label: PropTypes.string,
  className: PropTypes.string,
};

/**
 * Render inside the editor's `Suspense` boundary. It only commits once the
 * lazy editor has loaded, which tells the frame the download is over.
 */
export function EditorMountedSignal() {
  const frame = useContext(EditorLoadingContext);
  const markMounted = frame?.markMounted;
  useIsomorphicLayoutEffect(() => {
    markMounted?.();
  }, [markMounted]);
  return null;
}
