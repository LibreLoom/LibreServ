export default function LoadingFast({ label = "Loading..." }) {
  return (
    <div className="fixed inset-0 overflow-hidden bg-primary text-secondary">
      <div className="relative z-10 flex h-full w-full items-center justify-center px-6">
        <div
          className="w-full max-w-md text-left"
          role="status"
          aria-live="polite"
        >
          <div className="rounded-[28px] border border-accent/20 bg-accent/10 p-6 sm:p-8 load-card">
            <div className="text-xs uppercase tracking-[0.35em] text-secondary/60">
              LibreLoom
            </div>
            <h1 className="mt-3 text-3xl font-semibold sm:text-4xl">
              Warming up LibreServ
            </h1>
            <p className="mt-3 text-sm text-secondary/70 sm:text-base">
              {label}
            </p>
            <div className="mt-6 h-2 w-full overflow-hidden rounded-full bg-secondary/10">
              <div
                className="h-full rounded-full"
                style={{
                  width: "55%",
                  background:
                    "linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--color-accent) 85%, transparent) 45%, color-mix(in srgb, var(--color-accent) 25%, transparent) 100%)",
                  animation: "loadbar 1.5s ease-in-out infinite",
                }}
              />
            </div>
          </div>
        </div>
      </div>
      <style>{`
        .load-card {
          animation: card-in 260ms ease-out both;
          transform-origin: center;
        }
        @keyframes loadbar {
          0% { transform: translateX(-65%); opacity: 0.4; }
          50% { transform: translateX(10%); opacity: 0.9; }
          100% { transform: translateX(65%); opacity: 0.4; }
        }
        @keyframes card-in {
          0% { transform: scale(0.96); opacity: 0; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  );
}
