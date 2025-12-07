import { Outlet } from 'react-router-dom';
import Header from './Header';
import BottomNav from './BottomNav';

const MainLayout = ({ user, systemStatus = 'operational' }) => {
  // Determine greeting based on time of day
  const getGreeting = () => {
    const hour = new Date().getHours();
    if (hour < 12) return 'Good Morning';
    if (hour < 18) return 'Good Afternoon';
    return 'Good Evening';
  };

  return (
    <div className="min-h-screen flex flex-col pb-24">
      <Header 
        greeting={getGreeting()} 
        userName={user?.username || 'User'} 
        systemStatus={systemStatus}
      />
      
      <main className="flex-1 px-4 md:px-6">
        <Outlet />
      </main>
      
      <BottomNav user={user} />
    </div>
  );
};

export default MainLayout;
