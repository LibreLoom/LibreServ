import { useState } from 'react';
import { 
  User, 
  Mail, 
  Key, 
  Shield,
  Save,
  LogOut,
  Trash2,
  AlertCircle
} from 'lucide-react';
import { Card, Button, Input, Pill, Modal } from '../components/ui';
import { useTheme } from '../context/ThemeContext';
import { useAuth } from '../context/AuthContext';

export default function Profile() {
  const { haptic } = useTheme();
  const { user, logout } = useAuth();
  
  // Profile form
  const [profile, setProfile] = useState({
    username: user?.username || 'admin',
    email: user?.email || 'admin@example.com',
    displayName: user?.displayName || 'Admin User',
  });
  const [profileSaved, setProfileSaved] = useState(false);
  
  // Password form
  const [passwords, setPasswords] = useState({
    current: '',
    new: '',
    confirm: '',
  });
  const [passwordErrors, setPasswordErrors] = useState({});
  const [passwordChanged, setPasswordChanged] = useState(false);
  
  // Modals
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deleteConfirmText, setDeleteConfirmText] = useState('');

  const handleProfileSave = async () => {
    haptic('medium');
    
    // Simulate API call
    await new Promise(resolve => setTimeout(resolve, 500));
    
    setProfileSaved(true);
    setTimeout(() => setProfileSaved(false), 3000);
  };

  const handlePasswordChange = async (e) => {
    e.preventDefault();
    
    // Validation
    const errors = {};
    if (!passwords.current) errors.current = 'Current password is required';
    if (passwords.new.length < 8) errors.new = 'New password must be at least 8 characters';
    if (passwords.new !== passwords.confirm) errors.confirm = 'Passwords do not match';
    
    if (Object.keys(errors).length > 0) {
      setPasswordErrors(errors);
      haptic('error');
      return;
    }
    
    haptic('medium');
    
    // Simulate API call
    await new Promise(resolve => setTimeout(resolve, 500));
    
    setPasswords({ current: '', new: '', confirm: '' });
    setPasswordErrors({});
    setPasswordChanged(true);
    setTimeout(() => setPasswordChanged(false), 3000);
  };

  const handleLogout = () => {
    haptic('medium');
    logout();
    setShowLogoutModal(false);
  };

  const handleDeleteAccount = () => {
    if (deleteConfirmText !== 'DELETE') return;
    
    haptic('heavy');
    // Would delete account here
    logout();
  };

  const getInitials = (name) => {
    return name
      .split(' ')
      .map(n => n[0])
      .join('')
      .toUpperCase()
      .slice(0, 2);
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center gap-6">
        {/* Avatar */}
        <div className="w-20 h-20 rounded-full border-2 border-[var(--color-secondary)] flex items-center justify-center font-mono text-2xl">
          {getInitials(profile.displayName)}
        </div>
        
        <div>
          <h1 className="font-mono text-2xl">{profile.displayName}</h1>
          <div className="flex items-center gap-2 mt-1">
            <Pill size="sm" variant="filled">
              <Shield size={12} />
              {user?.role || 'Admin'}
            </Pill>
            <span className="text-[var(--color-accent)]">
              @{profile.username}
            </span>
          </div>
        </div>
      </div>

      {/* Account Details */}
      <Card>
        <h2 className="font-mono text-lg mb-4 flex items-center gap-2">
          <User size={20} />
          Account Details
        </h2>

        <div className="space-y-4">
          <div>
            <label className="block font-mono text-sm mb-2">Display Name</label>
            <Input
              value={profile.displayName}
              onChange={(e) => setProfile(prev => ({ ...prev, displayName: e.target.value }))}
              placeholder="Your display name"
            />
          </div>

          <div>
            <label className="block font-mono text-sm mb-2">Username</label>
            <Input
              value={profile.username}
              onChange={(e) => setProfile(prev => ({ ...prev, username: e.target.value }))}
              placeholder="Your username"
            />
            <p className="text-[var(--color-accent)] text-xs mt-1">
              Used for login and @mentions
            </p>
          </div>

          <div>
            <label className="block font-mono text-sm mb-2">Email</label>
            <Input
              type="email"
              value={profile.email}
              onChange={(e) => setProfile(prev => ({ ...prev, email: e.target.value }))}
              placeholder="your@email.com"
            />
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Button onClick={handleProfileSave}>
              <Save size={16} />
              Save Changes
            </Button>
            {profileSaved && (
              <span className="text-[var(--color-accent)] text-sm animate-slide-up">
                Changes saved
              </span>
            )}
          </div>
        </div>
      </Card>

      {/* Change Password */}
      <Card>
        <h2 className="font-mono text-lg mb-4 flex items-center gap-2">
          <Key size={20} />
          Change Password
        </h2>

        <form onSubmit={handlePasswordChange} className="space-y-4">
          <div>
            <label className="block font-mono text-sm mb-2">Current Password</label>
            <Input
              type="password"
              value={passwords.current}
              onChange={(e) => setPasswords(prev => ({ ...prev, current: e.target.value }))}
              placeholder="Enter current password"
              error={!!passwordErrors.current}
            />
            {passwordErrors.current && (
              <p className="text-[var(--color-accent)] text-xs mt-1 animate-pulse">
                {passwordErrors.current}
              </p>
            )}
          </div>

          <div>
            <label className="block font-mono text-sm mb-2">New Password</label>
            <Input
              type="password"
              value={passwords.new}
              onChange={(e) => setPasswords(prev => ({ ...prev, new: e.target.value }))}
              placeholder="Min 8 characters"
              error={!!passwordErrors.new}
            />
            {passwordErrors.new && (
              <p className="text-[var(--color-accent)] text-xs mt-1 animate-pulse">
                {passwordErrors.new}
              </p>
            )}
          </div>

          <div>
            <label className="block font-mono text-sm mb-2">Confirm New Password</label>
            <Input
              type="password"
              value={passwords.confirm}
              onChange={(e) => setPasswords(prev => ({ ...prev, confirm: e.target.value }))}
              placeholder="Confirm new password"
              error={!!passwordErrors.confirm}
            />
            {passwordErrors.confirm && (
              <p className="text-[var(--color-accent)] text-xs mt-1 animate-pulse">
                {passwordErrors.confirm}
              </p>
            )}
          </div>

          <div className="flex items-center gap-3 pt-2">
            <Button type="submit">
              <Key size={16} />
              Update Password
            </Button>
            {passwordChanged && (
              <span className="text-[var(--color-accent)] text-sm animate-slide-up">
                Password updated
              </span>
            )}
          </div>
        </form>
      </Card>

      {/* Sessions */}
      <Card>
        <h2 className="font-mono text-lg mb-4 flex items-center gap-2">
          <Shield size={20} />
          Active Sessions
        </h2>

        <div className="space-y-3">
          <div className="flex items-center justify-between p-3 bg-[var(--color-secondary)]/5 rounded-2xl">
            <div>
              <p className="font-mono text-sm">Current Session</p>
              <p className="text-[var(--color-accent)] text-xs">
                Chrome on Linux • Active now
              </p>
            </div>
            <Pill size="sm" variant="filled">Current</Pill>
          </div>

          <div className="flex items-center justify-between p-3 bg-[var(--color-secondary)]/5 rounded-2xl">
            <div>
              <p className="font-mono text-sm">Mobile App</p>
              <p className="text-[var(--color-accent)] text-xs">
                iOS 17 • Last active 2h ago
              </p>
            </div>
            <Button variant="ghost" size="sm">
              Revoke
            </Button>
          </div>
        </div>

        <Button 
          variant="outline" 
          className="mt-4 w-full"
          onClick={() => {
            haptic('light');
            setShowLogoutModal(true);
          }}
        >
          <LogOut size={16} />
          Sign Out
        </Button>
      </Card>

      {/* Danger Zone */}
      <Card className="border-dashed">
        <h2 className="font-mono text-lg mb-2 flex items-center gap-2">
          <AlertCircle size={20} />
          Danger Zone
        </h2>
        <p className="text-[var(--color-accent)] text-sm mb-4">
          Irreversible actions that affect your account
        </p>

        <Button 
          variant="outline"
          onClick={() => {
            haptic('medium');
            setShowDeleteModal(true);
          }}
        >
          <Trash2 size={16} />
          Delete Account
        </Button>
      </Card>

      {/* Logout Modal */}
      <Modal
        isOpen={showLogoutModal}
        onClose={() => setShowLogoutModal(false)}
        title="Sign Out"
      >
        <p className="text-[var(--color-accent)] mb-6">
          Are you sure you want to sign out? You'll need to log in again to access LibreServ.
        </p>
        <div className="flex gap-3">
          <Button onClick={handleLogout} className="flex-1">
            <LogOut size={16} />
            Sign Out
          </Button>
          <Button variant="outline" onClick={() => setShowLogoutModal(false)}>
            Cancel
          </Button>
        </div>
      </Modal>

      {/* Delete Account Modal */}
      <Modal
        isOpen={showDeleteModal}
        onClose={() => {
          setShowDeleteModal(false);
          setDeleteConfirmText('');
        }}
        title="Delete Account"
      >
        <div className="space-y-4">
          <div className="p-4 border-2 border-dashed border-[var(--color-secondary)] rounded-2xl animate-pulse-slow">
            <p className="font-mono text-sm mb-2">Warning</p>
            <p className="text-[var(--color-accent)] text-sm">
              This action cannot be undone. All your data, including settings, 
              permissions, and session history will be permanently deleted.
            </p>
          </div>

          <div>
            <label className="block font-mono text-sm mb-2">
              Type DELETE to confirm
            </label>
            <Input
              value={deleteConfirmText}
              onChange={(e) => setDeleteConfirmText(e.target.value)}
              placeholder="DELETE"
              className="font-mono"
            />
          </div>

          <div className="flex gap-3">
            <Button 
              onClick={handleDeleteAccount}
              disabled={deleteConfirmText !== 'DELETE'}
              className="flex-1"
            >
              <Trash2 size={16} />
              Delete Account
            </Button>
            <Button 
              variant="outline" 
              onClick={() => {
                setShowDeleteModal(false);
                setDeleteConfirmText('');
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
