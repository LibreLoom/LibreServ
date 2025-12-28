export default function MiniStatCard({ icon: Icon, label, value }) {
  return (
    <div className="motion-safe:transition hover:scale-[1.02] bg-primary text-secondary rounded-pill p-3 flex items-center gap-3">
      <div className="h-8 w-8 rounded-pill bg-secondary text-primary flex items-center justify-center">
        <Icon size={16} aria-hidden="true" />
      </div>
      <div>
        <div className="text-xs text-accent text-left">{label}</div>
        <div className="text-sm font-semibold text-left">{value}</div>
      </div>
    </div>
  );
}
