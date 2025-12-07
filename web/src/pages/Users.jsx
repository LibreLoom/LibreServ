import { useState, useEffect } from 'react';
import { UserPlus, Shield, ShieldOff, Trash2, Search, X } from 'lucide-react';
import { Card, Button, Input, Pill, StatusDot } from '../components/ui';

const Users = () => {
  const [users, setUsers] = useState([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [isAddingUser, setIsAddingUser] = useState(false);
  const [newUser, setNewUser] = useState({ username: '', email: '', password: '', role: 'user' });
  const [errors, setErrors] = useState({});

  // Load users on mount
  useEffect(() => {
    loadUsers();
  }, []);

  const loadUsers = async () => {
    setIsLoading(true);
    try {
      // TODO: Replace with actual API call
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Mock data
      setUsers([
        { id: '1', username: 'admin', email: 'admin@example.com', role: 'admin', lastActive: new Date().toISOString() },
        { id: '2', username: 'user1', email: 'user1@example.com', role: 'user', lastActive: new Date(Date.now() - 3600000).toISOString() },
        { id: '3', username: 'guest', email: null, role: 'viewer', lastActive: null },
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
    const newErrors = {};
    if (!newUser.username.trim()) newErrors.username = 'Username is required';
    if (!newUser.password || newUser.password.length < 8) {
      newErrors.password = 'Password must be at least 8 characters';
    }
    
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors);
      return;
    }

    try {
      // TODO: Replace with actual API call
      await new Promise(resolve => setTimeout(resolve, 500));
      
      setUsers(prev => [...prev, {
        id: Date.now().toString(),
        username: newUser.username,
        email: newUser.email || null,
        role: newUser.role,
        lastActive: null,
      }]);
      
      setIsAddingUser(false);
      setNewUser({ username: '', email: '', password: '', role: 'user' });
      setErrors({});
    } catch (error) {
      setErrors({ submit: 'Failed to create user' });
    }
  };

  const handleDeleteUser = async (userId, username) => {
    if (username === 'admin') {
      alert('Cannot delete the admin account');
      return;
    }
    
    if (!confirm(`Are you sure you want to delete user "${username}"?`)) {
      return;
    }

    try {
      // TODO: Replace with actual API call
      await new Promise(resolve => setTimeout(resolve, 500));
      setUsers(prev => prev.filter(u => u.id !== userId));
    } catch (error) {
      alert('Failed to delete user');
    }
  };

  const handleChangeRole = async (userId, newRole) => {
    try {
      // TODO: Replace with actual API call
      await new Promise(resolve => setTimeout(resolve, 500));
      setUsers(prev => prev.map(u => 
        u.id === userId ? { ...u, role: newRole } : u
      ));
    } catch (error) {
      alert('Failed to change role');
    }
  };

  const getRoleBadge = (role) => {
    const config = {
      admin: { color: 'success', label: 'Admin' },
      user: { color: 'info', label: 'User' },
      viewer: { color: 'warning', label: 'Viewer' },
    };
    const { color, label } = config[role] || config.user;
    return (
      <Pill size="sm">
        <StatusDot status={color} />
        {label}
      </Pill>
    );
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

  const filteredUsers = users.filter(user =>
    user.username.toLowerCase().includes(searchQuery.toLowerCase()) ||
    (user.email && user.email.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center">
          <div className="w-8 h-8 border-2 border-[var(--color-secondary)] border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="font-mono text-[var(--color-accent)]">Loading users...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-4xl mx-auto space-y-6 animate-fade-in">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-2xl mb-2">Users</h1>
          <p className="text-[var(--color-accent)]">Manage user accounts and permissions</p>
        </div>
        <Button onClick={() => setIsAddingUser(true)}>
          <UserPlus size={16} />
          Add User
        </Button>
      </div>

      {/* Search */}
      <div className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-accent)]" size={18} />
        <Input
          type="search"
          placeholder="Search users..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="pl-12"
        />
      </div>

      {/* Add User Modal */}
      {isAddingUser && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
          <Card className="w-full max-w-md animate-scale-in">
            <div className="flex items-center justify-between mb-6">
              <h2 className="font-mono text-xl">Add New User</h2>
              <button
                onClick={() => {
                  setIsAddingUser(false);
                  setErrors({});
                }}
                className="p-2 hover:bg-[var(--color-secondary)]/10 rounded-full"
              >
                <X size={20} />
              </button>
            </div>

            <form onSubmit={handleAddUser} className="space-y-4">
              <div>
                <label className="block font-mono text-sm mb-2">Username *</label>
                <Input
                  value={newUser.username}
                  onChange={(e) => setNewUser(prev => ({ ...prev, username: e.target.value }))}
                  placeholder="Enter username"
                />
                {errors.username && (
                  <p className="text-red-500 text-xs mt-1">{errors.username}</p>
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
                  placeholder="Enter password (min 8 characters)"
                />
                {errors.password && (
                  <p className="text-red-500 text-xs mt-1">{errors.password}</p>
                )}
              </div>

              <div>
                <label className="block font-mono text-sm mb-2">Role</label>
                <select
                  value={newUser.role}
                  onChange={(e) => setNewUser(prev => ({ ...prev, role: e.target.value }))}
                  className="w-full px-4 py-2 bg-transparent border-2 border-[var(--color-secondary)] rounded-full font-mono text-sm focus:outline-none"
                >
                  <option value="user">User</option>
                  <option value="admin">Admin</option>
                  <option value="viewer">Viewer</option>
                </select>
              </div>

              {errors.submit && (
                <p className="text-red-500 text-sm">{errors.submit}</p>
              )}

              <div className="flex gap-3 pt-4">
                <Button type="submit" className="flex-1">
                  Create User
                </Button>
                <Button 
                  type="button" 
                  variant="outline" 
                  onClick={() => {
                    setIsAddingUser(false);
                    setErrors({});
                  }}
                >
                  Cancel
                </Button>
              </div>
            </form>
          </Card>
        </div>
      )}

      {/* Users List */}
      <Card>
        <div className="divide-y divide-[var(--color-accent)]/20">
          {filteredUsers.map(user => (
            <div key={user.id} className="flex items-center justify-between py-4 first:pt-0 last:pb-0">
              <div className="flex items-center gap-4">
                <div className="w-10 h-10 rounded-full border-2 border-[var(--color-secondary)] flex items-center justify-center bg-[var(--color-secondary)]/10 font-mono">
                  {user.username.charAt(0).toUpperCase()}
                </div>
                <div>
                  <p className="font-mono">{user.username}</p>
                  <p className="text-[var(--color-accent)] text-sm">
                    {user.email || 'No email'}
                    <span className="mx-2">•</span>
                    {formatLastActive(user.lastActive)}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-3">
                {getRoleBadge(user.role)}

                {/* Role Toggle */}
                {user.username !== 'admin' && (
                  <button
                    onClick={() => handleChangeRole(
                      user.id, 
                      user.role === 'admin' ? 'user' : 'admin'
                    )}
                    className="p-2 hover:bg-[var(--color-secondary)]/10 rounded-full transition-colors"
                    title={user.role === 'admin' ? 'Demote to User' : 'Promote to Admin'}
                  >
                    {user.role === 'admin' ? (
                      <ShieldOff size={18} className="text-[var(--color-accent)]" />
                    ) : (
                      <Shield size={18} className="text-[var(--color-accent)]" />
                    )}
                  </button>
                )}

                {/* Delete Button */}
                {user.username !== 'admin' && (
                  <button
                    onClick={() => handleDeleteUser(user.id, user.username)}
                    className="p-2 hover:bg-red-500/10 rounded-full transition-colors text-red-500"
                    title="Delete User"
                  >
                    <Trash2 size={18} />
                  </button>
                )}
              </div>
            </div>
          ))}

          {filteredUsers.length === 0 && (
            <div className="text-center py-8">
              <p className="font-mono text-[var(--color-accent)]">
                {searchQuery ? `No users found matching "${searchQuery}"` : 'No users found'}
              </p>
            </div>
          )}
        </div>
      </Card>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-4">
        <Card className="text-center">
          <p className="font-mono text-2xl">{users.length}</p>
          <p className="text-[var(--color-accent)] text-sm">Total Users</p>
        </Card>
        <Card className="text-center">
          <p className="font-mono text-2xl">{users.filter(u => u.role === 'admin').length}</p>
          <p className="text-[var(--color-accent)] text-sm">Admins</p>
        </Card>
        <Card className="text-center">
          <p className="font-mono text-2xl">
            {users.filter(u => {
              if (!u.lastActive) return false;
              const hourAgo = Date.now() - 3600000;
              return new Date(u.lastActive).getTime() > hourAgo;
            }).length}
          </p>
          <p className="text-[var(--color-accent)] text-sm">Active (1h)</p>
        </Card>
      </div>
    </div>
  );
};

export default Users;
