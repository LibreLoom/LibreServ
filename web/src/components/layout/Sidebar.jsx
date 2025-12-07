import { useState } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import { Card, StatusDot } from '../ui';

const StatCard = ({ title, value, subtitle, showBreakdown, breakdown }) => {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <Card className="p-6">
      <h3 className="font-mono text-sm text-[var(--color-accent)] mb-3">{title}</h3>
      <div className="font-mono text-2xl">
        {value}
      </div>
      {subtitle && (
        <p className="font-mono text-lg mt-1">{subtitle}</p>
      )}
      
      {showBreakdown && breakdown && (
        <>
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="flex items-center gap-2 mt-4 font-mono text-sm text-[var(--color-secondary)] hover:opacity-70 transition-opacity"
          >
            <span className="text-[var(--color-accent)]">▼</span>
            {isExpanded ? 'Hide Breakdown' : 'Show Breakdown'}
          </button>
          
          {isExpanded && (
            <div className="mt-3 pt-2 space-y-1 animate-slide-up">
              {breakdown.map((item, index) => (
                <div key={index} className="flex justify-between items-center text-xs font-mono">
                  <span className="text-[var(--color-accent)]">{item.label}</span>
                  <span>{item.value}</span>
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
    <aside className="w-full lg:w-80 flex-shrink-0 space-y-6">
      <StatCard
        title="Uptime"
        value={`${data.uptime.days} days, ${data.uptime.hours} hours`}
      />
      
      <StatCard
        title="Storage Usage"
        value={
          <span className="flex items-center gap-3">
            <StatusDot 
              status={storagePercent > 90 ? 'attention' : storagePercent > 75 ? 'neutral' : 'active'} 
            />
            <span>{data.storage.used}/{data.storage.total}GB ({storagePercent}%)</span>
          </span>
        }
      />
      
      <StatCard
        title="Overall Resource Usage"
        value={
          <span className="flex items-center gap-3">
            <StatusDot status="active" />
            <span>{data.resources.overall}%</span>
          </span>
        }
        showBreakdown
        breakdown={data.resources.breakdown}
      />
    </aside>
  );
};

export default Sidebar;
