export default function FormButtonGroup({
  submitLabel = "Submit",
  cancelLabel = "Cancel",
  onCancel,
  loading = false,
  submitDisabled = false,
  className = "",
}) {
  return (
    <div className={`flex gap-3 ${className}`}>
      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          disabled={loading}
          className="flex-1 px-4 py-2 bg-primary text-secondary rounded-pill hover:bg-secondary hover:text-primary hover:ring-2 hover:ring-accent focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {cancelLabel}
        </button>
      )}
      <button
        type="submit"
        disabled={loading || submitDisabled}
        className="flex-1 px-4 py-2 bg-accent text-primary rounded-pill hover:ring-2 hover:ring-primary focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed"
      >
        {loading ? "Saving..." : submitLabel}
      </button>
    </div>
  );
}
