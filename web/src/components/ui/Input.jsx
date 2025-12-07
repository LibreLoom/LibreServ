import { forwardRef } from 'react';

const Input = forwardRef(({ 
  className = '',
  type = 'text',
  error = false,
  ...props 
}, ref) => {
  return (
    <input
      ref={ref}
      type={type}
      className={`
        w-full
        px-4 py-3
        font-sans text-base
        border-2 border-[var(--color-secondary)]
        rounded-2xl
        bg-[var(--color-primary)]
        text-[var(--color-secondary)]
        placeholder:text-[var(--color-accent)]
        outline-none
        transition-colors duration-[var(--transition-fast)]
        focus:border-[var(--color-accent)]
        disabled:opacity-50 disabled:cursor-not-allowed
        ${error ? 'border-[var(--color-error)]' : ''}
        ${className}
      `}
      {...props}
    />
  );
});

Input.displayName = 'Input';

export default Input;
