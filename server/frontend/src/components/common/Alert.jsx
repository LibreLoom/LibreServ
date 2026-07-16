import PropTypes from "prop-types";
import Callout from "./Callout";

/** @param {{ variant?: "error"|"success"|"warning"|"info", message: string, className?: string, rounded?: "pill"|"large-element" }} props */
export default function Alert({ variant = "info", message, className = "", rounded = "pill" }) {
  const tone = variant === "success" ? "success" : variant === "warning" ? "warning" : variant === "error" ? "error" : "info";
  return (
    <Callout tone={tone} rounded={rounded} className={className}>
      {message}
    </Callout>
  );
}

Alert.propTypes = {
  variant: PropTypes.oneOf(["error", "success", "warning", "info"]),
  message: PropTypes.string.isRequired,
  className: PropTypes.string,
  rounded: PropTypes.oneOf(["pill", "large-element"]),
};