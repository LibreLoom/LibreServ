import { Pill, StatusDot } from '../ui';

const Header = ({ 
  greeting = 'Good Afternoon',
  userName = 'User',
  systemStatus = 'operational', // 'operational' | 'degraded' | 'down'
}) => {
  const statusConfig = {
    operational: { text: 'All Systems Operational', status: 'success' },
    degraded: { text: 'Some Systems Degraded', status: 'warning' },
    down: { text: 'Systems Down', status: 'error' },
  };

  const { text, status } = statusConfig[systemStatus] || statusConfig.operational;

  return (
    <header className="flex items-center justify-between px-6 py-4">
      <Pill>
        {greeting}, {userName}
      </Pill>
      
      <Pill>
        <StatusDot status={status} />
        {text}
      </Pill>
    </header>
  );
};

export default Header;
