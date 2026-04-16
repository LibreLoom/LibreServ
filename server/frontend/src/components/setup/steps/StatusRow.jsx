import PropTypes from "prop-types";
import { Check, X, Loader2 } from "lucide-react";

export default function StatusRow({ label, done, failed, spinner, children }) {
  return (
    <div className="flex items-start gap-3 py-2 animate-in fade-in slide-in-from-bottom-1 duration-200">
      <div
        className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center mt-0.5 ${
          done    ? "bg-primary/15" :
          failed  ? "bg-error/20" :
                    "bg-primary/10"
        }`}
      >
        {done    ? <Check size={14} className="text-primary/70" /> :
         failed  ? <X size={14} className="text-error" /> :
         spinner ? <Loader2 size={14} className="text-primary/35 animate-spin" /> :
                   <div className="w-3 h-3 rounded-full border-2 border-primary/25" />}
      </div>
      <div className="flex-1">
        <span className={`text-sm ${
          done    ? "text-primary/70" :
          failed  ? "text-error" :
                    "text-primary/60"
        }`}>
          {label}
        </span>
        {children}
        {failed && (
          <p className="text-xs text-error/70 mt-0.5">Failed — check your credentials and try again.</p>
        )}
      </div>
    </div>
  );
}

StatusRow.propTypes = {
  label:   PropTypes.string.isRequired,
  done:    PropTypes.bool,
  failed:  PropTypes.bool,
  spinner: PropTypes.bool,
  children: PropTypes.node,
};
