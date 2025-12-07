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
    <Card className="h-full min-h-[320px] flex flex-col relative p-6">
      {/* Top Section */}
      <div className="space-y-4">
        {/* Header */}
        <h3 className="font-mono text-xl border-b-2 border-[var(--color-secondary)] pb-2 mb-4">
          {app.name}
        </h3>

        {/* Stats Grid */}
        <div className="space-y-3 font-mono text-sm">
          {/* Status */}
          <div>
            <p className="text-[var(--color-accent)] mb-1">Status</p>
            <div className="flex items-center gap-2">
              <StatusDot status={dotStatus} />
              <span>{statusText}</span>
            </div>
          </div>

          {/* Resource Usage */}
          <div>
            <p className="text-[var(--color-accent)] mb-1">Resource Usage</p>
            <div className="flex items-center gap-2">
              <StatusDot status={'active'} />
              <span>{app.resourceUsage || 0}%</span>
            </div>
          </div>
        </div>

        {/* Breakdown Toggle */}
        {app.breakdown && (
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-2 font-mono text-sm text-[var(--color-secondary)] hover:opacity-70 transition-opacity mt-2"
          >
            <span className="text-[var(--color-accent)]">▼</span>
            {isExpanded ? 'Hide Breakdown' : 'Show Breakdown'}
          </button>
        )}
        
        {isExpanded && app.breakdown && (
          <div className="pt-2 space-y-1 animate-slide-up">
            {app.breakdown.map((item, index) => (
              <div key={index} className="flex justify-between text-xs font-mono">
                <span className="text-[var(--color-accent)]">{item.label}</span>
                <span>{item.value}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Manage Button - Floating Pill at Bottom Center */}
      <div className="mt-auto pt-6 flex justify-center">
        <Button 
          variant="outline"
          className="px-8"
          onClick={() => onManage?.(app)}
        >
          Manage
        </Button>
      </div>
    </Card>
  );
};

export default AppCard;
