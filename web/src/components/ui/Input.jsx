import { forwardRef } from 'react';

const Input = forwardRef(({ 
  type = 'text',
  size = 'md', // 'sm' | 'md' | 'lg'
  error = false,
  className = '',
  ...props 
}, ref) => {
  const baseStyles = `
    w-full
    font-sans
    bg-transparent
    border-2 border-[var(--color-secondary)]
    rounded-full
    text-[var(--color-secondary)]
    placeholder:text-[var(--color-accent)]
    outline-none
    transition-all duration-200
    focus:border-[var(--color-accent)]
    disabled:opacity-50 disabled:cursor-not-allowed
  `;

  const sizes = {
    sm: 'px-3 py-1.5 text-sm',
    md: 'px-4 py-2.5 text-base',
    lg: 'px-5 py-3 text-lg',
  };

  const errorStyles = error ? 'border-dashed animate-pulse' : '';

  return (
    <input
      ref={ref}
      type={type}
      className={`
        ${baseStyles}
        ${sizes[size]}
        ${errorStyles}
        ${className}
      `}
      {...props}
    />
  );
});

Input.displayName = 'Input';

export default Input;
