export default function LoadingFast({ label = "Loading..." }) {
  return (
    <div className="fixed inset-0 overflow-hidden bg-primary text-secondary">
      <div
        className="absolute inset-0"
        style={{
          background:
            "linear-gradient(130deg, var(--color-primary) 0%, color-mix(in srgb, var(--color-secondary) 8%, transparent) 40%, color-mix(in srgb, var(--color-secondary) 2%, transparent) 100%)",
          backgroundSize: "120% 120%",
          animation:
            "bgshift-quick 0.3s ease-out 0s 1, bgshift 18s ease-in-out 0.3s infinite",
        }}
      />
      <div
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            "radial-gradient(circle at 20% 20%, color-mix(in srgb, var(--color-secondary) 18%, transparent), transparent 45%), radial-gradient(circle at 80% 10%, color-mix(in srgb, var(--color-secondary) 14%, transparent), transparent 40%), radial-gradient(circle at 60% 80%, color-mix(in srgb, var(--color-secondary) 12%, transparent), transparent 42%)",
        }}
      />
      <div
        className="absolute inset-0 opacity-20"
        style={{
          backgroundImage:
            "repeating-linear-gradient(120deg, color-mix(in srgb, var(--color-secondary) 8%, transparent) 0, color-mix(in srgb, var(--color-secondary) 8%, transparent) 1px, transparent 1px, transparent 18px)",
        }}
      />
      <div
        className="absolute -right-28 top-[-10%] h-72 w-72 rounded-full blur-3xl"
        style={{
          background: "color-mix(in srgb, var(--color-secondary) 25%, transparent)",
          animation: "float 16s ease-in-out infinite",
        }}
      />
      <div
        className="absolute -left-20 bottom-[-15%] h-80 w-80 rounded-full blur-3xl"
        style={{
          background: "color-mix(in srgb, var(--color-secondary) 20%, transparent)",
          animation: "float 18s ease-in-out infinite reverse",
        }}
      />
      <div className="relative z-10 flex h-full w-full items-center justify-center px-6">
        <div
          className="w-full max-w-md text-left"
          role="status"
          aria-live="polite"
        >
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
                  "linear-gradient(90deg, transparent 0%, color-mix(in srgb, var(--color-secondary) 80%, transparent) 45%, color-mix(in srgb, var(--color-secondary) 20%, transparent) 100%)",
                animation: "loadbar 1.5s ease-in-out infinite",
              }}
            />
          </div>
        </div>
      </div>
      <style>{`
        @keyframes loadbar {
          0% { transform: translateX(-65%); opacity: 0.4; }
          50% { transform: translateX(10%); opacity: 0.9; }
          100% { transform: translateX(65%); opacity: 0.4; }
        }
        @keyframes bgshift {
          0% { background-position: 0% 0%; }
          50% { background-position: 100% 70%; }
          100% { background-position: 0% 0%; }
        }
        @keyframes bgshift-quick {
          0% { background-position: 100% 70%; }
          100% { background-position: 0% 0%; }
        }
        @keyframes float {
          0% { transform: translate3d(0, 0, 0); }
          50% { transform: translate3d(0, 30px, 0); }
          100% { transform: translate3d(0, 0, 0); }
        }
      `}</style>
    </div>
  );
}
