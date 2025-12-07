import { useState } from 'react';
import { ChevronDown, ChevronUp, ExternalLink } from 'lucide-react';
import { Card, Button, StatusDot } from './ui';

const AppCard = ({ 
  app,
  onManage,
}) => {
  const [isExpanded, setIsExpanded] = useState(false);

  // Shape-based status (no semantic colors!)
  const statusMap = {
    running: { status: 'active', text: 'Running' },
    stopped: { status: 'inactive', text: 'Stopped' },
    error: { status: 'attention', text: 'Error' },
    starting: { status: 'attention', text: 'Starting' },
    stopping: { status: 'attention', text: 'Stopping' },
  };

  const { status: dotStatus, text: statusText } = statusMap[app.status] || statusMap.stopped;

  return (
    <Card className="h-full flex flex-col">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div>
          <h3 className="font-mono text-lg">{app.name}</h3>
          <div className="flex items-center gap-2 mt-1">
            <StatusDot status={dotStatus} />
            <span className="text-sm text-[var(--color-accent)]">{statusText}</span>
          </div>
        </div>
        {app.url && (
          <a 
            href={app.url} 
            target="_blank" 
            rel="noopener noreferrer"
            className="p-2 hover:bg-[var(--color-secondary)]/10 rounded-full transition-colors"
            title="Open in new tab"
          >
            <ExternalLink size={16} />
          </a>
        )}
      </div>

      {/* Resource Usage */}
      <div className="mb-4">
        <div className="flex items-center justify-between text-sm mb-1">
          <span className="text-[var(--color-accent)]">Resource Usage</span>
          <span className="font-mono">{app.resourceUsage || 0}%</span>
        </div>
        <div className="h-1.5 bg-[var(--color-secondary)]/20 rounded-full overflow-hidden">
          <div 
            className="h-full bg-[var(--color-secondary)] rounded-full transition-all duration-500"
            style={{ width: `${app.resourceUsage || 0}%` }}
          />
        </div>
      </div>

      {/* Breakdown Toggle */}
      {app.breakdown && (
        <>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1 font-mono text-xs text-[var(--color-accent)] hover:text-[var(--color-secondary)] transition-colors mb-4"
          >
            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {isExpanded ? 'Hide Breakdown' : 'Show Breakdown'}
          </button>
          
          {isExpanded && (
            <div className="mb-4 pt-3 border-t border-[var(--color-secondary)]/20 animate-slide-up">
              {app.breakdown.map((item, index) => (
                <div key={index} className="flex justify-between items-center py-1 text-sm">
                  <span className="text-[var(--color-accent)]">{item.label}</span>
                  <span className="font-mono">{item.value}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {/* Actions */}
      <div className="mt-auto pt-4 border-t border-[var(--color-secondary)]/20">
        <Button 
          className="w-full"
          onClick={() => onManage?.(app)}
        >
          Manage
        </Button>
      </div>
    </Card>
  );
};

export default AppCard;
