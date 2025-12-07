import { Pill, StatusDot } from '../ui';

const Header = ({ 
  greeting = 'Good Afternoon',
  userName = 'User',
  systemStatus = 'operational', // 'operational' | 'degraded' | 'down'
}) => {
  const statusConfig = {
    operational: { text: 'All Systems Operational', status: 'active' },
    degraded: { text: 'Some Systems Degraded', status: 'attention' },
    down: { text: 'Systems Down', status: 'attention' },
  };

  const { text, status } = statusConfig[systemStatus] || statusConfig.operational;

  return (
    <header className="flex items-center justify-between px-6 md:px-12 py-8">
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
