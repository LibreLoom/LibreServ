import { forwardRef } from 'react';
import { useTheme } from '../../context/ThemeContext';

const Button = forwardRef(({ 
  children, 
  variant = 'filled', // 'filled' | 'outline' | 'ghost'
  size = 'md', // 'sm' | 'md' | 'lg'
  disabled = false,
  loading = false,
  className = '',
  onClick,
  ...props 
}, ref) => {
  const { haptic } = useTheme();

  const baseStyles = `
    inline-flex items-center justify-center gap-2
    font-mono font-normal
    border-2 border-[var(--color-secondary)]
    rounded-full
    transition-all duration-200
    cursor-pointer
    disabled:opacity-50 disabled:cursor-not-allowed
    active:scale-95
  `;

  const variants = {
    filled: `
      bg-[var(--color-secondary)] text-[var(--color-primary)]
      hover:bg-transparent hover:text-[var(--color-secondary)]
    `,
    outline: `
      bg-transparent text-[var(--color-secondary)]
      hover:bg-[var(--color-secondary)] hover:text-[var(--color-primary)]
    `,
    ghost: `
      bg-transparent text-[var(--color-secondary)]
      border-transparent
      hover:bg-[var(--color-secondary)]/10
    `,
  };

  const sizes = {
    sm: 'px-3 py-1.5 text-xs',
    md: 'px-5 py-2.5 text-sm',
    lg: 'px-7 py-3 text-base',
  };

  const handleClick = (e) => {
    if (disabled || loading) return;
    haptic('light');
    onClick?.(e);
  };

  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      onClick={handleClick}
      className={`
        ${baseStyles}
        ${variants[variant]}
        ${sizes[size]}
        ${className}
      `}
      {...props}
    >
      {loading ? (
        <>
          <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
          <span>Loading...</span>
        </>
      ) : (
        children
      )}
    </button>
  );
});

Button.displayName = 'Button';

export default Button;
