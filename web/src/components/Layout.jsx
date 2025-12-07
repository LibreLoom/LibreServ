import { Outlet } from 'react-router-dom';
import Navbar from './Navbar';
import Header from './Header';
import { useAuth } from '../context/AuthContext';

export default function Layout({ systemStatus = 'operational' }) {
  const { user } = useAuth();

  return (
    <div className="min-h-screen bg-[var(--color-primary)] text-[var(--color-secondary)]">
      {/* Main Content */}
      <main className="
        max-w-[var(--content-max-width)] 
        mx-auto 
        px-4 sm:px-6 lg:px-8
        py-6
        pb-28
      ">
        <Header 
          subtitle={user?.username}
          systemStatus={systemStatus}
        />
        
        <div className="animate-fade-in">
          <Outlet />
        </div>
      </main>

      {/* Floating Navbar */}
      <Navbar user={user} />
    </div>
  );
}
