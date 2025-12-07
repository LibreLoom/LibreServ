import { forwardRef } from 'react';

const Button = forwardRef(({ 
  children, 
  variant = 'outline', // 'outline' | 'filled'
  size = 'md', // 'sm' | 'md' | 'lg'
  className = '',
  disabled = false,
  ...props 
}, ref) => {
  const baseStyles = `
    inline-flex items-center justify-center gap-2
    font-mono text-sm
    border-2 border-[var(--color-secondary)]
    rounded-full
    cursor-pointer
    transition-all duration-[var(--transition-normal)]
    disabled:opacity-50 disabled:cursor-not-allowed
  `;

  const variants = {
    outline: `
      bg-transparent text-[var(--color-secondary)]
      hover:bg-[var(--color-secondary)] hover:text-[var(--color-primary)]
    `,
    filled: `
      bg-[var(--color-secondary)] text-[var(--color-primary)]
      hover:bg-transparent hover:text-[var(--color-secondary)]
    `,
  };

  const sizes = {
    sm: 'px-3 py-1 text-xs',
    md: 'px-4 py-2 text-sm',
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
