import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Card, StatusDot } from '../ui';

const StatCard = ({ title, value, subtitle, showBreakdown, breakdown }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <Card className="mb-4">
      <h3 className="font-mono text-sm text-[var(--color-accent)] mb-1">{title}</h3>
      <p className="font-mono text-2xl mb-1">{value}</p>
      {subtitle && (
        <p className="text-sm text-[var(--color-accent)]">{subtitle}</p>
      )}
      
      {showBreakdown && breakdown && (
        <>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-1 mt-3 font-mono text-xs text-[var(--color-accent)] hover:text-[var(--color-secondary)] transition-colors"
          >
            {isExpanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {isExpanded ? 'Hide Breakdown' : 'Show Breakdown'}
          </button>
          
          {isExpanded && (
            <div className="mt-3 pt-3 border-t border-[var(--color-secondary)]/20 animate-slide-up">
              {breakdown.map((item, index) => (
                <div key={index} className="flex justify-between items-center py-1 text-sm">
                  <span className="text-[var(--color-accent)]">{item.label}</span>
                  <span className="font-mono">{item.value}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
};

const Sidebar = ({ stats }) => {
  const defaultStats = {
    uptime: { days: 41, hours: 15 },
    storage: { used: 128, total: 512 },
    resources: {
      overall: 41,
      breakdown: [
        { label: 'CPU', value: '23%' },
        { label: 'RAM', value: '48%' },
        { label: 'Disk I/O', value: '12%' },
        { label: 'Network', value: '5%' },
      ],
    },
  };

  const data = stats || defaultStats;

  const storagePercent = Math.round((data.storage.used / data.storage.total) * 100);

  return (
    <aside className="w-full lg:w-72 flex-shrink-0 p-4">
      <StatCard
        title="Uptime"
        value={`${data.uptime.days} days, ${data.uptime.hours} hours`}
      />
      
      <StatCard
        title="Storage Usage"
        value={
          <span className="flex items-center gap-2">
            <StatusDot 
              status={storagePercent > 90 ? 'attention' : storagePercent > 75 ? 'neutral' : 'active'} 
            />
            {data.storage.used}/{data.storage.total}GB
          </span>
        }
        subtitle={`${storagePercent}% used`}
      />
      
      <StatCard
        title="Overall Resource Usage"
        value={`${data.resources.overall}%`}
        showBreakdown
        breakdown={data.resources.breakdown}
      />
    </aside>
  );
};

export default Sidebar;
