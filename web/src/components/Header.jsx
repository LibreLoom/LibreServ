import { Sun, Moon } from 'lucide-react';
import { useTheme } from '../context/ThemeContext';

export default function Header({ title, subtitle, systemStatus = 'operational' }) {
  const { isDark, toggleMode, haptic } = useTheme();

  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good Morning';
    if (hour < 17) return 'Good Afternoon';
    return 'Good Evening';
  };

  const getStatusText = () => {
    switch (systemStatus) {
      case 'operational':
        return 'All Systems Operational';
      case 'degraded':
        return 'Some Systems Degraded';
      case 'outage':
        return 'System Outage';
      default:
        return 'Status Unknown';
    }
  };

  return (
    <header className="flex items-center justify-between mb-8 animate-slide-down">
      {/* Left: Greeting or Title */}
      <div className="
        inline-flex items-center gap-2
        px-5 py-2
        bg-[var(--color-primary)]
        border-2 border-[var(--color-secondary)]
        rounded-full
        font-mono text-sm
      ">
        {title || `${getGreeting()}`}
        {subtitle && (
          <span className="text-[var(--color-accent)]">{subtitle}</span>
        )}
      </div>

      {/* Right: Status + Theme Toggle */}
      <div className="flex items-center gap-3">
        {/* System Status */}
        <div className="
          hidden sm:inline-flex items-center gap-2
          px-4 py-2
          bg-[var(--color-primary)]
          border-2 border-[var(--color-secondary)]
          rounded-full
          font-mono text-sm
        ">
          <span className={`
            w-2 h-2 rounded-full
            ${systemStatus === 'operational' 
              ? 'bg-[var(--color-secondary)]' 
              : 'bg-[var(--color-accent)] animate-pulse'
            }
          `} />
          {getStatusText()}
        </div>

        {/* Theme Toggle */}
        <button
          onClick={() => {
            toggleMode();
            haptic('medium');
          }}
          className="
            p-3
            bg-[var(--color-primary)]
            border-2 border-[var(--color-secondary)]
            rounded-full
            transition-all duration-300
            hover:bg-[var(--color-secondary)] hover:text-[var(--color-primary)]
            active:scale-95
          "
          aria-label={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
        >
          {isDark ? <Sun size={18} /> : <Moon size={18} />}
        </button>
      </div>
    </header>
  );
}
