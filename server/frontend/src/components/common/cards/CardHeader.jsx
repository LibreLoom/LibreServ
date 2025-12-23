export default function CardHeader({ title, action }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h2 className="text-lg font-medium">{title}</h2>
      {action && (
        <button className="text-sm opacity-70 hover:opacity-100">
          {action}
        </button>
      )}
    </div>
  );
}
