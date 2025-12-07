import { useState } from 'react';
import { Search } from 'lucide-react';
import { Sidebar } from '../components/layout';
import { Input } from '../components/ui';
import AppCard from '../components/AppCard';

const Dashboard = () => {
  const [searchQuery, setSearchQuery] = useState('');

  // Mock data - will be replaced with API calls
  const stats = {
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

  const apps = [
    {
      id: 'nextcloud',
      name: 'Nextcloud',
      status: 'running',
      resourceUsage: 35,
      url: 'https://cloud.example.com',
      breakdown: [
        { label: 'CPU', value: '15%' },
        { label: 'RAM', value: '45%' },
        { label: 'Disk', value: '28%' },
      ],
    },
    {
      id: 'convertx',
      name: 'ConvertX',
      status: 'running',
      resourceUsage: 12,
      url: null,
      breakdown: [
        { label: 'CPU', value: '8%' },
        { label: 'RAM', value: '12%' },
        { label: 'Disk', value: '5%' },
      ],
    },
    {
      id: 'searxng',
      name: 'SearXNG',
      status: 'running',
      resourceUsage: 8,
      url: 'https://search.example.com',
      breakdown: [
        { label: 'CPU', value: '5%' },
        { label: 'RAM', value: '10%' },
        { label: 'Disk', value: '2%' },
      ],
    },
  ];

  const filteredApps = apps.filter(app => 
    app.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleManageApp = (app) => {
    console.log('Managing app:', app);
    // TODO: Navigate to app management page
  };

  return (
    <div className="flex flex-col lg:flex-row gap-6">
      {/* Sidebar with Stats */}
      <Sidebar stats={stats} />

      {/* Main Content */}
      <div className="flex-1">
        {/* Search Bar */}
        <div className="relative mb-6">
          <Search 
            className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-accent)]" 
            size={18} 
          />
          <Input
            type="search"
            placeholder="Search apps..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-12"
          />
        </div>

        {/* App Grid */}
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {filteredApps.map(app => (
            <AppCard 
              key={app.id} 
              app={app} 
              onManage={handleManageApp}
            />
          ))}
        </div>

        {filteredApps.length === 0 && (
          <div className="text-center py-12">
            <p className="font-mono text-[var(--color-accent)]">
              No apps found matching "{searchQuery}"
            </p>
          </div>
        )}
      </div>
    </div>
  );
};

export default Dashboard;
