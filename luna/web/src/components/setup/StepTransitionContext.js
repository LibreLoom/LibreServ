import { createContext } from "react";

// Step transition context, kept in its own non-component module so the
// companion .jsx file can export only the Provider component (Fast Refresh
// requires component files to export only components).
//
// SetupPage provides { key, direction } via this context. SetupCard consumes
// it and slides its INNER content in from the right (advancing) or left (going
// back), keyed so React remounts the content subtree and the slide replays. The
// card shell stays in place and smoothly resizes — only the content slides.
// Mirrors the app install wizard's slide-in-from-right-pop / -left-pop keyframes.
// (Copied from LibreServ's setup UI so both wizards transition identically.)
export const StepTransitionContext = createContext({ key: null, direction: "right" });
