export default function StatusCol({ label, status }) {
  const isOk = status === "Operational";

  return (
    <div className="bg-primary text-secondary rounded-large-element px-4 py-3 flex flex-col items-start gap-1 w-full">
      {/* Status indicator */}
      <span
        className={`h-2.5 w-2.5 rounded-full ${
          isOk ? "bg-green-400" : "bg-yellow-400"
        }`}
      />

      {/* Text */}
      <div className="flex flex-col leading-tight">
        <span className="text-sm font-medium">{label}</span>
        <span className="text-xs opacity-70">{status}</span>
      </div>
    </div>
  );
}
