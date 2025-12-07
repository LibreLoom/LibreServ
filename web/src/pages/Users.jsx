import { useState, useEffect } from 'react';
import { 
  Search, 
  Plus, 
  UserPlus,
  Shield,
  ShieldOff,
  Trash2,
  Edit,
  X,
  Check,
  ChevronDown,
  ChevronUp
} from 'lucide-react';
import { Card, Button, Input, StatusIndicator, Pill, Modal } from '../components/ui';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';

// Permission levels for apps
const PERMISSION_LEVELS = {
  none: { label: 'No Access', description: 'Cannot view or manage this app' },
  view: { label: 'View Only', description: 'Can view app status and logs' },
  manage: { label: 'Manage', description: 'Can start, stop, and restart the app' },
  admin: { label: 'Full Control', description: 'Full control including updates and deletion' },
};

export default function Users() {
  const { haptic } = useTheme();
  const { user: currentUser, hasPermission } = useAuth();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [users, setUsers] = useState([]);
  const [apps, setApps] = useState([]);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showPermissionsModal, setShowPermissionsModal] = useState(false);
  const [selectedUser, setSelectedUser] = useState(null);
  const [expandedUser, setExpandedUser] = useState(null);
  
  // New user form
  const [newUser, setNewUser] = useState({
    username: '',
    email: '',
    password: '',
    role: 'user',
  });
  const [formErrors, setFormErrors] = useState({});

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setIsLoading(true);
    try {
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Mock users with per-app permissions
      setUsers([
        {
          id: '1',
          username: 'admin',
          email: 'admin@example.com',
          role: 'admin',
          lastActive: new Date().toISOString(),
          permissions: { '*': 'admin' }, // Admin has full access to everything
        },
        {
          id: '2',
          username: 'john',
          email: 'john@example.com',
          role: 'user',
          lastActive: new Date(Date.now() - 3600000).toISOString(),
          permissions: {
            'nextcloud': 'admin',
            'jellyfin': 'manage',
            'searxng': 'view',
          },
        },
        {
          id: '3',
          username: 'sarah',
          email: 'sarah@example.com',
          role: 'user',
          lastActive: new Date(Date.now() - 86400000).toISOString(),
          permissions: {
            'jellyfin': 'admin',
            'convertx': 'manage',
          },
        },
        {
          id: '4',
          username: 'guest',
          email: null,
          role: 'viewer',
          lastActive: null,
          permissions: {
            'searxng': 'view',
          },
        },
      ]);

      // Mock apps for permission assignment
      setApps([
        { id: 'nextcloud', name: 'Nextcloud' },
        { id: 'convertx', name: 'ConvertX' },
        { id: 'searxng', name: 'SearXNG' },
        { id: 'vaultwarden', name: 'Vaultwarden' },
        { id: 'jellyfin', name: 'Jellyfin' },
      ]);
    } catch (error) {
      console.error('Failed to load users:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAddUser = async (e) => {
    e.preventDefault();
    
    // Validation
    const errors = {};
    if (!newUser.username.trim()) errors.username = 'Username is required';
    if (newUser.password.length < 8) errors.password = 'Password must be at least 8 characters';
    if (users.some(u => u.username === newUser.username)) errors.username = 'Username already exists';
    
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }
    
    haptic('medium');
    
    // Add user
    const createdUser = {
      id: Date.now().toString(),
      username: newUser.username,
      email: newUser.email || null,
      role: newUser.role,
      lastActive: null,
      permissions: {},
    };
    
    setUsers(prev => [...prev, createdUser]);
    setShowAddModal(false);
    setNewUser({ username: '', email: '', password: '', role: 'user' });
    setFormErrors({});
  };

  const handleDeleteUser = async (userId, username) => {
    if (username === 'admin') {
      alert('Cannot delete the admin account');
      return;
    }
    
    if (!confirm(`Are you sure you want to delete user "${username}"?`)) {
      return;
    }
    
    haptic('medium');
    setUsers(prev => prev.filter(u => u.id !== userId));
  };

  const handleUpdatePermission = (userId, appId, level) => {
    haptic('light');
    setUsers(prev => prev.map(user => {
      if (user.id !== userId) return user;
      
      const newPermissions = { ...user.permissions };
      if (level === 'none') {
        delete newPermissions[appId];
      } else {
        newPermissions[appId] = level;
      }
      
      return { ...user, permissions: newPermissions };
    }));
  };

  const handleToggleRole = (userId, currentRole) => {
    const newRole = currentRole === 'admin' ? 'user' : 'admin';
    haptic('medium');
    
    setUsers(prev => prev.map(user => {
      if (user.id !== userId) return user;
      
      if (newRole === 'admin') {
        return { ...user, role: 'admin', permissions: { '*': 'admin' } };
      } else {
        // Remove wildcard permission when demoting
        const { '*': _, ...appPermissions } = user.permissions;
        return { ...user, role: 'user', permissions: appPermissions };
      }
    }));
  };

  const formatLastActive = (date) => {
    if (!date) return 'Never';
    
    const now = new Date();
    const lastActive = new Date(date);
    const diffMs = now - lastActive;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return lastActive.toLocaleDateString();
  };

  const getPermissionCount = (permissions) => {
    if (permissions['*']) return 'All apps';
    const count = Object.keys(permissions).length;
    return count === 0 ? 'No access' : `${count} app${count > 1 ? 's' : ''}`;
  };

  const filteredUsers = users.filter(user =>
    user.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (user.email && user.email.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center animate-pulse">
          <div className="w-10 h-10 border-2 border-[var(--color-secondary)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="font-mono text-[var(--color-accent)]">Loading users...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-2xl">Users</h1>
          <p className="text-[var(--color-accent)] mt-1">
            {users.length} users, {users.filter(u => u.role === 'admin').length} admins
          </p>
        </div>
        
        <Button onClick={() => {
          haptic('light');
          setShowAddModal(true);
        }}>
          <UserPlus size={16} />
          Add User
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search 
          className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-accent)]" 
          size={18} 
        />
        <Input
          type="search"
          placeholder="Search users..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-12"
        />
      </div>

      {/* Users List */}
      <Card padding="none">
        <div className="divide-y-2 divide-[var(--color-secondary)]/10">
          {filteredUsers.map((user, index) => (
            <div 
              key={user.id}
              className={`animate-slide-up stagger-${Math.min(index + 1, 5)}`}
            >
              {/* User Row */}
              <div className="flex items-center justify-between p-4">
                <div className="flex items-center gap-4">
                  {/* Avatar */}
                  <div className="w-12 h-12 rounded-full border-2 border-[var(--color-secondary)] flex items-center justify-center font-mono text-lg">
                    {user.username.charAt(0).toUpperCase()}
                  </div>
                  
                  {/* Info */}
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-mono">{user.username}</span>
                      {user.role === 'admin' && (
                        <Pill size="sm" variant="filled">
                          <Shield size={12} />
                          Admin
                        </Pill>
                      )}
                    </div>
                    <p className="text-[var(--color-accent)] text-sm">
                      {user.email || 'No email'}
                      <span className="mx-2">•</span>
                      {formatLastActive(user.lastActive)}
                    </p>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2">
                  <Pill size="sm">
                    {getPermissionCount(user.permissions)}
                  </Pill>
                  
                  {/* Expand/Collapse */}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setExpandedUser(expandedUser === user.id ? null : user.id)}
                  >
                    {expandedUser === user.id ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                  </Button>

                  {/* Toggle Admin */}
                  {user.username !== 'admin' && currentUser?.role === 'admin' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleToggleRole(user.id, user.role)}
                      title={user.role === 'admin' ? 'Demote to User' : 'Promote to Admin'}
                    >
                      {user.role === 'admin' ? <ShieldOff size={16} /> : <Shield size={16} />}
                    </Button>
                  )}
                  
                  {/* Delete */}
                  {user.username !== 'admin' && currentUser?.role === 'admin' && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleDeleteUser(user.id, user.username)}
                    >
                      <Trash2 size={16} />
                    </Button>
                  )}
                </div>
              </div>

              {/* Expanded: Per-App Permissions */}
              {expandedUser === user.id && (
                <div className="px-4 pb-4 animate-slide-down">
                  <div className="ml-16 p-4 bg-[var(--color-secondary)]/5 rounded-2xl">
                    <h4 className="font-mono text-sm mb-3">App Permissions</h4>
                    
                    {user.permissions['*'] ? (
                      <p className="text-[var(--color-accent)] text-sm">
                        This user has full admin access to all apps.
                      </p>
                    ) : (
                      <div className="space-y-4">
                        {apps.map(app => {
                          const currentLevel = user.permissions[app.id] || 'none';
                          
                          return (
                            <div key={app.id} className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2">
                              <span className="font-mono text-sm">{app.name}</span>
                              
                              <div className="flex flex-wrap items-center gap-1">
                                {Object.entries(PERMISSION_LEVELS).map(([level, { label }]) => (
                                  <button
                                    key={level}
                                    onClick={() => handleUpdatePermission(user.id, app.id, level)}
                                    className={`
                                      px-2 sm:px-3 py-1 text-xs font-mono rounded-full
                                      border-2 border-[var(--color-secondary)]
                                      transition-all duration-200
                                      ${currentLevel === level 
                                        ? 'bg-[var(--color-secondary)] text-[var(--color-primary)]' 
                                        : 'hover:bg-[var(--color-secondary)]/10'
                                      }
                                    `}
                                  >
                                    {label}
                                  </button>
                                ))}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {filteredUsers.length === 0 && (
        <div className="text-center py-12">
          <p className="font-mono text-[var(--color-accent)]">
            {searchQuery ? `No users found matching "${searchQuery}"` : 'No users found'}
          </p>
        </div>
      )}

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <Card padding="md" className="text-center">
          <p className="font-mono text-2xl">{users.length}</p>
          <p className="text-[var(--color-accent)] text-sm">Total Users</p>
        </Card>
        <Card padding="md" className="text-center">
          <p className="font-mono text-2xl">{users.filter(u => u.role === 'admin').length}</p>
          <p className="text-[var(--color-accent)] text-sm">Admins</p>
        </Card>
        <Card padding="md" className="text-center">
          <p className="font-mono text-2xl">
            {users.filter(u => {
              if (!u.lastActive) return false;
              return Date.now() - new Date(u.lastActive).getTime() < 3600000;
            }).length}
          </p>
          <p className="text-[var(--color-accent)] text-sm">Active (1h)</p>
        </Card>
      </div>

      {/* Add User Modal */}
      <Modal
        isOpen={showAddModal}
        onClose={() => {
          setShowAddModal(false);
          setNewUser({ username: '', email: '', password: '', role: 'user' });
          setFormErrors({});
        }}
        title="Add New User"
      >
        <form onSubmit={handleAddUser} className="space-y-4">
          <div>
            <label className="block font-mono text-sm mb-2">Username *</label>
            <Input
              value={newUser.username}
              onChange={(e) => setNewUser(prev => ({ ...prev, username: e.target.value }))}
              placeholder="Enter username"
              error={!!formErrors.username}
            />
            {formErrors.username && (
              <p className="text-[var(--color-accent)] text-xs mt-1 animate-pulse">
                ⚠ {formErrors.username}
              </p>
            )}
          </div>

          <div>
            <label className="block font-mono text-sm mb-2">Email</label>
            <Input
              type="email"
              value={newUser.email}
              onChange={(e) => setNewUser(prev => ({ ...prev, email: e.target.value }))}
              placeholder="Enter email (optional)"
            />
          </div>

          <div>
            <label className="block font-mono text-sm mb-2">Password *</label>
            <Input
              type="password"
              value={newUser.password}
              onChange={(e) => setNewUser(prev => ({ ...prev, password: e.target.value }))}
              placeholder="Min 8 characters"
              error={!!formErrors.password}
            />
            {formErrors.password && (
              <p className="text-[var(--color-accent)] text-xs mt-1 animate-pulse">
                ⚠ {formErrors.password}
              </p>
            )}
          </div>

          <div>
            <label className="block font-mono text-sm mb-2">Role</label>
            <div className="flex gap-2">
              {['user', 'admin', 'viewer'].map(role => (
                <button
                  key={role}
                  type="button"
                  onClick={() => setNewUser(prev => ({ ...prev, role }))}
                  className={`
                    px-4 py-2 rounded-full font-mono text-sm capitalize
                    border-2 border-[var(--color-secondary)]
                    transition-all duration-200
                    ${newUser.role === role 
                      ? 'bg-[var(--color-secondary)] text-[var(--color-primary)]' 
                      : 'hover:bg-[var(--color-secondary)]/10'
                    }
                  `}
                >
                  {role}
                </button>
              ))}
            </div>
          </div>

          <div className="flex gap-3 pt-4">
            <Button type="submit" className="flex-1">
              Create User
            </Button>
            <Button 
              type="button" 
              variant="outline"
              onClick={() => {
                setShowAddModal(false);
                setNewUser({ username: '', email: '', password: '', role: 'user' });
                setFormErrors({});
              }}
            >
              Cancel
            </Button>
          </div>
        </form>
      </Modal>
    </div>
  );
}
