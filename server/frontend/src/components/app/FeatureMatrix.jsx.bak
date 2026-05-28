import { memo } from "react";
import {
  Users,
  UserCircle,
  Globe,
  ExternalLink,
  Lock,
  Database,
  LayoutTemplate,
  RefreshCw,
  Clock,
  RotateCcw,
  Server,
  Zap,
  ShieldCheck,
  AlertTriangle,
  ShieldX,
  Cpu,
  Check,
  X,
} from "lucide-react";

const ACCESS_MODELS = {
  shared_account: {
    icon: Users,
    label: "Shared Account",
    desc: "All users share one login",
    tone: "warning",
  },
  integrated_users: {
    icon: UserCircle,
    label: "LibreServ Accounts",
    desc: "Uses LibreServ user management",
    tone: "success",
  },
  external_auth: {
    icon: ExternalLink,
    label: "Separate Accounts",
    desc: "Manages its own users internally",
    tone: "neutral",
  },
  public: {
    icon: Globe,
    label: "Public Access",
    desc: "No authentication required",
    tone: "info",
  },
};

function getToneStyles(onPrimary) {
  const text = onPrimary ? "text-secondary" : "text-primary";
  const neutralBg = onPrimary ? "bg-secondary/10" : "bg-primary/10";
  const neutralBorder = onPrimary ? "border-secondary/20" : "border-primary/20";
  return {
    success: { text, bg: "bg-success/20", border: "border-success/30" },
    warning: { text, bg: "bg-warning/20", border: "border-warning/30" },
    error: { text, bg: "bg-error/20", border: "border-error/30" },
    info: { text, bg: "bg-info/20", border: "border-info/30" },
    neutral: { text, bg: neutralBg, border: neutralBorder },
  };
}

function AccessModel({ model, compact, onPrimary = false }) {
  const tone = getToneStyles(onPrimary);
  const info = ACCESS_MODELS[model] || ACCESS_MODELS.integrated_users;
  const Icon = info.icon;
  const style = tone[info.tone];
  const labelDim = onPrimary ? "text-secondary/70" : "text-primary/50";
  const labelMuted = onPrimary ? "text-secondary" : "text-primary/70";
  const labelDesc = onPrimary ? "text-secondary/80" : "text-primary/60";

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <div className={`p-1.5 rounded-full ${style.bg}`}>
          <Icon size={12} className={style.text} />
        </div>
        <div>
          <p className={`text-xs font-mono ${labelDim}`}>Access</p>
          <p className={`text-sm font-medium ${style.text}`}>{info.label}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`p-4 rounded-large-element ${style.bg} border ${style.border}`}>
      <div className="flex items-start gap-3">
        <div className={`p-2 rounded-full ${style.bg}`}>
          <Icon size={18} className={style.text} />
        </div>
        <div className="flex-1">
          <p className={`text-xs font-mono uppercase tracking-wide ${labelMuted} mb-1`}>Access Model</p>
          <p className={`text-base font-medium ${style.text}`}>{info.label}</p>
          <p className={`text-sm ${labelDesc} mt-1`}>{info.desc}</p>
        </div>
      </div>
    </div>
  );
}

function BooleanFeature({ icon: Icon, label, value, compact, onPrimary = false }) {
  const tone = getToneStyles(onPrimary);
  const isActive = Boolean(value);
  const style = isActive ? tone.success : tone.neutral;
  const DisplayIcon = isActive ? Check : X;
  const labelMuted = onPrimary ? "text-secondary" : "text-primary/70";
  const labelDim = onPrimary ? "text-secondary/70" : "text-primary/50";

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <div className={`p-1.5 rounded-full ${style.bg}`}>
          <DisplayIcon size={12} className={style.text} />
        </div>
        <div>
          <p className={`text-xs font-mono ${labelMuted}`}>{label}</p>
          <p className={`text-sm font-medium ${style.text}`}>{isActive ? "Yes" : "No"}</p>
        </div>
      </div>
    );
  }

  return (
    <div className={`flex items-center gap-3 p-3 rounded-large-element ${style.bg}`}>
      <div className={`p-2 rounded-full ${style.bg}`}>
        <Icon size={16} className={style.text} />
      </div>
      <div className="flex-1">
        <p className={`text-xs font-mono ${labelDim}`}>{label}</p>
        <p className={`text-sm font-medium ${style.text}`}>{isActive ? "Supported" : "Not supported"}</p>
      </div>
    </div>
  );
}

function UpdateBehavior({ behavior, compact, onPrimary = false }) {
  const tone = getToneStyles(onPrimary);
  const labelDim = onPrimary ? "text-secondary/50" : "text-primary/50";
  if (!behavior) return null;

  const { automatic, requires_downtime, supports_rollback } = behavior;

  if (compact) {
    return (
      <div className="flex items-center gap-2">
        <div className={`p-1.5 rounded-full ${automatic ? tone.info.bg : tone.neutral.bg}`}>
          <RefreshCw size={12} className={automatic ? tone.info.text : tone.neutral.text} />
        </div>
        <div>
          <p className={`text-xs font-mono ${labelDim}`}>Updates</p>
          <p className={`text-sm font-medium ${automatic ? tone.info.text : tone.neutral.text}`}>
            {automatic ? "Automatic" : "Manual"}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <p className={`text-xs font-mono uppercase tracking-wide ${labelDim}`}>Updates</p>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
        <div className={`flex items-center gap-2 p-2 rounded-large-element ${automatic ? tone.info.bg : tone.neutral.bg}`}>
          <RefreshCw size={14} className={automatic ? tone.info.text : tone.neutral.text} />
          <span className={`text-sm ${automatic ? tone.info.text : tone.neutral.text}`}>
            {automatic ? "Automatic" : "Manual"}
          </span>
        </div>
        <div className={`flex items-center gap-2 p-2 rounded-large-element ${requires_downtime ? tone.warning.bg : tone.success.bg}`}>
          <Clock size={14} className={requires_downtime ? tone.warning.text : tone.success.text} />
          <span className={`text-sm ${requires_downtime ? tone.warning.text : tone.success.text}`}>
            {requires_downtime ? "Downtime required" : "Zero downtime"}
          </span>
        </div>
        <div className={`flex items-center gap-2 p-2 rounded-large-element ${supports_rollback ? tone.success.bg : tone.neutral.bg}`}>
          <RotateCcw size={14} className={supports_rollback ? tone.success.text : tone.neutral.text} />
          <span className={`text-sm ${supports_rollback ? tone.success.text : tone.neutral.text}`}>
            {supports_rollback ? "Rollback supported" : "No rollback"}
          </span>
        </div>
      </div>
    </div>
  );
}

function ResourceHints({ hints, compact, onPrimary = false }) {
  const tone = getToneStyles(onPrimary);
  const labelDim = onPrimary ? "text-secondary/50" : "text-primary/50";
  if (!hints || (!hints.single_instance && !hints.privileged_required)) return null;

  if (compact) {
    const items = [];
    if (hints.single_instance) items.push({ icon: Server, label: "Single instance", tone: "warning" });
    if (hints.privileged_required) items.push({ icon: Zap, label: "Privileged", tone: "warning" });

    return (
      <div className="flex flex-wrap gap-2">
        {items.map((item, i) => (
          <span key={i} className={`inline-flex items-center gap-1 px-2 py-1 rounded-pill text-xs font-mono ${tone[item.tone].bg} ${tone[item.tone].text}`}>
            <item.icon size={10} />
            {item.label}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div>
      <p className={`text-xs font-mono uppercase tracking-wide ${labelDim} mb-2`}>Resources</p>
      <div className="flex flex-wrap gap-2">
        {hints.single_instance && (
          <span className={`inline-flex items-center gap-2 px-3 py-2 rounded-large-element ${tone.warning.bg}`}>
            <Server size={14} className={tone.warning.text} />
            <span className={`text-sm ${tone.warning.text}`}>Single instance only</span>
          </span>
        )}
        {hints.privileged_required && (
          <span className={`inline-flex items-center gap-2 px-3 py-2 rounded-large-element ${tone.warning.bg}`}>
            <Zap size={14} className={tone.warning.text} />
            <span className={`text-sm ${tone.warning.text}`}>Privileged mode required</span>
          </span>
        )}
      </div>
    </div>
  );
}

function Flags({ features, compact, onPrimary = false }) {
  const tone = getToneStyles(onPrimary);
  const labelDim = onPrimary ? "text-secondary/50" : "text-primary/50";
  const activeFlags = [];
  if (features.read_only) activeFlags.push({ icon: ShieldCheck, label: "Read-only", tone: "info" });
  if (features.experimental) activeFlags.push({ icon: AlertTriangle, label: "Experimental", tone: "warning" });
  if (features.requires_root) activeFlags.push({ icon: ShieldX, label: "Requires root", tone: "error" });
  if (features.requires_gpu) activeFlags.push({ icon: Cpu, label: "GPU required", tone: "info" });

  if (activeFlags.length === 0) return null;

  if (compact) {
    return (
      <div className="flex flex-wrap gap-2">
        {activeFlags.map((flag, i) => (
          <span key={i} className={`inline-flex items-center gap-1 px-2 py-1 rounded-pill text-xs font-mono ${tone[flag.tone].bg} ${tone[flag.tone].text}`}>
            <flag.icon size={10} />
            {flag.label}
          </span>
        ))}
      </div>
    );
  }

  return (
    <div>
      <p className={`text-xs font-mono uppercase tracking-wide ${labelDim} mb-2`}>Flags</p>
      <div className="flex flex-wrap gap-2">
        {activeFlags.map((flag, i) => (
          <span key={i} className={`inline-flex items-center gap-2 px-3 py-2 rounded-large-element ${tone[flag.tone].bg}`}>
            <flag.icon size={14} className={tone[flag.tone].text} />
            <span className={`text-sm ${tone[flag.tone].text}`}>{flag.label}</span>
          </span>
        ))}
      </div>
    </div>
  );
}

function Requirements({ features, compact, onPrimary = false }) {
  const tone = getToneStyles(onPrimary);
  const labelMuted = onPrimary ? "text-secondary/70" : "text-primary/70";
  const hasMinRam = features.min_ram;
  const hasMinCpu = features.min_cpu;

  if (!hasMinRam && !hasMinCpu) return null;

  if (compact) {
    return (
      <div className="flex flex-wrap gap-2">
        {hasMinRam && (
          <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-pill text-xs font-mono ${tone.neutral.bg} ${tone.neutral.text}`}>
            <Database size={10} />
            {features.min_ram}
          </span>
        )}
        {hasMinCpu && (
          <span className={`inline-flex items-center gap-1 px-2 py-1 rounded-pill text-xs font-mono ${tone.neutral.bg} ${tone.neutral.text}`}>
            <Cpu size={10} />
            {features.min_cpu} CPU
          </span>
        )}
      </div>
    );
  }

  return (
    <div>
      <p className={`text-xs font-mono uppercase tracking-wide ${labelMuted} mb-2`}>Requirements</p>
      <div className="flex flex-wrap gap-2">
        {hasMinRam && (
          <span className={`inline-flex items-center gap-2 px-3 py-2 rounded-large-element ${tone.neutral.bg}`}>
            <Database size={14} className={tone.neutral.text} />
            <span className={`text-sm ${tone.neutral.text}`}>{features.min_ram} RAM</span>
          </span>
        )}
        {hasMinCpu && (
          <span className={`inline-flex items-center gap-2 px-3 py-2 rounded-large-element ${tone.neutral.bg}`}>
            <Cpu size={14} className={tone.neutral.text} />
            <span className={`text-sm ${tone.neutral.text}`}>{features.min_cpu} CPU cores</span>
          </span>
        )}
      </div>
    </div>
  );
}

function FeatureMatrix({ features, compact = false, className = "", onPrimary = false }) {
  if (!features) {
    return (
      <div className={`text-sm italic ${className} ${onPrimary ? "text-secondary/50" : "text-primary/50"}`}>
        No capability information available for this app.
      </div>
    );
  }

  if (compact) {
    return (
      <div className={className}>
        <div className="grid grid-cols-2 gap-y-3 gap-x-4">
          <AccessModel model={features.access_model || "integrated_users"} compact onPrimary={onPrimary} />
          <BooleanFeature
            icon={Lock}
            label="SSO"
            value={features.sso}
            compact
            onPrimary={onPrimary}
          />
          <BooleanFeature
            icon={Database}
            label="Backup"
            value={features.backup === "supported"}
            compact
            onPrimary={onPrimary}
          />
          <BooleanFeature
            icon={LayoutTemplate}
            label="Custom Domains"
            value={features.custom_domains}
            compact
            onPrimary={onPrimary}
          />
        </div>
      </div>
    );
  }

  return (
    <div className={`space-y-4 ${className}`}>
      <AccessModel model={features.access_model || "integrated_users"} onPrimary={onPrimary} />

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <BooleanFeature
          icon={Lock}
          label="Single Sign-On"
          value={features.sso}
          onPrimary={onPrimary}
        />
        <BooleanFeature
          icon={Database}
          label="Backup Support"
          value={features.backup === "supported"}
          onPrimary={onPrimary}
        />
        <BooleanFeature
          icon={LayoutTemplate}
          label="Custom Domains"
          value={features.custom_domains}
          onPrimary={onPrimary}
        />
      </div>

      <UpdateBehavior behavior={features.update_behavior} onPrimary={onPrimary} />

      <ResourceHints hints={features.resource_hints} onPrimary={onPrimary} />

      <Flags features={features} onPrimary={onPrimary} />

      <Requirements features={features} onPrimary={onPrimary} />
    </div>
  );
}

export default memo(FeatureMatrix);
