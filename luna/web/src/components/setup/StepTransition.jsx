import { useMemo } from "react";
import PropTypes from "prop-types";
import { StepTransitionContext } from "./StepTransitionContext";

// Provider wrapper used by SetupPage around the rendered step. `stepKey`
// changes each step → consumers re-render with a fresh key so the keyed inner
// div in SetupCard remounts and the slide animates. See StepTransitionContext.js
// for the full design notes.
// (Copied from LibreServ's setup UI so both wizards transition identically.)
export function StepTransitionProvider({ stepKey, direction, children }) {
  const value = useMemo(() => ({ key: stepKey, direction }), [stepKey, direction]);
  return <StepTransitionContext.Provider value={value}>{children}</StepTransitionContext.Provider>;
}

StepTransitionProvider.propTypes = {
  stepKey: PropTypes.string.isRequired,
  direction: PropTypes.oneOf(["right", "left"]),
  children: PropTypes.node.isRequired,
};
