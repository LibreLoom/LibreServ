import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';

export default function Modal({ 
  isOpen, 
  onClose, 
  title,
  children,
  size = 'md', // 'sm' | 'md' | 'lg' | 'full'
}) {
  const { haptic } = useTheme();
  const modalRef = useRef(null);

  // Close on escape
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    
    window.addEventListener('keydown', handleEscape);
    return () => window.removeEventListener('keydown', handleEscape);
  }, [isOpen, onClose]);

  // Lock body scroll when open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = '';
    }
    
    return () => {
      document.body.style.overflow = '';
    };
  }, [isOpen]);

  if (!isOpen) return null;

  const sizes = {
    sm: 'max-w-sm',
    md: 'max-w-lg',
    lg: 'max-w-2xl',
    full: 'max-w-4xl',
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      {/* Backdrop */}
      <div 
        className="absolute inset-0 bg-[var(--color-secondary)]/30 animate-fade-in"
        onClick={() => {
          haptic('light');
          onClose();
        }}
      />
      
      {/* Modal */}
      <div 
        ref={modalRef}
        className={`
          relative w-full ${sizes[size]}
          bg-[var(--color-primary)]
          border-2 border-[var(--color-secondary)]
          rounded-3xl
          p-6
          animate-pop-in
          max-h-[90vh] overflow-auto
        `}
      >
        {/* Header */}
        {title && (
          <div className="flex items-center justify-between mb-6">
            <h2 className="font-mono text-xl">{title}</h2>
            <button
              onClick={() => {
                haptic('light');
                onClose();
              }}
              className="
                p-2 rounded-full
                hover:bg-[var(--color-secondary)]/10
                transition-colors duration-200
                active:scale-95
              "
              aria-label="Close modal"
            >
              <X size={20} />
            </button>
          </div>
        )}
        
        {/* Content */}
        {children}
      </div>
    </div>
  );
}
