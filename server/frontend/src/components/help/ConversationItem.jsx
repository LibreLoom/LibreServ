import { cn } from "@/lib/utils";
import PropTypes from "prop-types";
import Pill from "../common/Pill.jsx";

const STATUS_VARIANT = {
  active: "success",
  pending: "warning",
  resolved: "muted",
  cancelled: "error",
};

function ConversationItem({ title, date, status, isActive, onClick }) {
  const variant = STATUS_VARIANT[status] || "muted";

  return (
    <button
      type="button"
      onClick={onClick}
      className={cn("w-full text-left px-3 py-2 rounded-large-element text-sm font-mono motion-safe:transition-colors cursor-pointer focus-visible:ring-2 focus-visible:ring-accent no-focus-outline", isActive ? "bg-primary text-secondary" : "hover:bg-primary/5 text-primary/70")}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="truncate">{title}</span>
        <Pill variant={variant}>{status}</Pill>
      </div>
      <div className={cn("text-xs mt-0.5", isActive ? "text-accent" : "text-primary/40")}>{date}</div>
    </button>
  );
}

ConversationItem.propTypes = {
  title: PropTypes.string.isRequired,
  date: PropTypes.string,
  status: PropTypes.string,
  isActive: PropTypes.bool,
  onClick: PropTypes.func,
};

export default ConversationItem;
