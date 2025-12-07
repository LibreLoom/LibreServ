import { forwardRef } from 'react';

const Button = forwardRef(({ 
  children, 
  variant = 'filled', // 'filled' | 'outline'
  size = 'md', // 'sm' | 'md' | 'lg'
  className = '',
  disabled = false,
  ...props 
}, ref) => {
  const baseStyles = `
    inline-flex items-center justify-center gap-2
    font-mono
    border-2 border-[var(--color-secondary)]
    rounded-full
    cursor-pointer
    transition-all duration-[var(--transition-normal)]
    disabled:opacity-50 disabled:cursor-not-allowed
    active:scale-[0.98]
  `;

  const variants = {
    filled: `
      bg-[var(--color-secondary)] text-[var(--color-primary)]
      hover:bg-[var(--color-primary)] hover:text-[var(--color-secondary)]
    `,
    outline: `
      bg-[var(--color-primary)] text-[var(--color-secondary)]
      hover:bg-[var(--color-secondary)] hover:text-[var(--color-primary)]
    `,
  };

  const sizes = {
    sm: 'px-4 py-1.5 text-xs',
    md: 'px-5 py-2 text-sm',
    lg: 'px-6 py-3 text-base',
  };

  return (
    <button
      ref={ref}
      className={`${baseStyles} ${variants[variant]} ${sizes[size]} ${className}`}
      disabled={disabled}
      {...props}
    >
      {children}
    </button>
  );
});

Button.displayName = 'Button';

export default Button;
