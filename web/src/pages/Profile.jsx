import { useState } from 'react';
import { User, Mail, Key, Shield, Save, Eye, EyeOff } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { Card, Button, Input } from '../components/ui';

const Profile = () => {
  const { user } = useAuth();
  const [isEditing, setIsEditing] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [formData, setFormData] = useState({
    username: user?.username || '',
    email: user?.email || '',
    currentPassword: '',
    newPassword: '',
    confirmPassword: '',
  });
  const [errors, setErrors] = useState({});
  const [isSaving, setIsSaving] = useState(false);
  const [successMessage, setSuccessMessage] = useState('');

  const handleInputChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
    // Clear error when user starts typing
    if (errors[name]) {
      setErrors(prev => ({ ...prev, [name]: '' }));
    }
  };

  const validateForm = () => {
    const newErrors = {};

    if (!formData.username.trim()) {
      newErrors.username = 'Username is required';
    }

    if (formData.newPassword) {
      if (formData.newPassword.length < 8) {
        newErrors.newPassword = 'Password must be at least 8 characters';
      }
      if (formData.newPassword !== formData.confirmPassword) {
        newErrors.confirmPassword = 'Passwords do not match';
      }
      if (!formData.currentPassword) {
        newErrors.currentPassword = 'Current password is required to change password';
      }
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    
    if (!validateForm()) return;

    setIsSaving(true);
    setSuccessMessage('');

    try {
      // TODO: Call API to update profile
      await new Promise(resolve => setTimeout(resolve, 1000)); // Simulated API call
      
      setSuccessMessage('Profile updated successfully!');
      setIsEditing(false);
      setFormData(prev => ({
        ...prev,
        currentPassword: '',
        newPassword: '',
        confirmPassword: '',
      }));
    } catch (error) {
      setErrors({ submit: 'Failed to update profile. Please try again.' });
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setIsEditing(false);
    setFormData({
      username: user?.username || '',
      email: user?.email || '',
      currentPassword: '',
      newPassword: '',
      confirmPassword: '',
    });
    setErrors({});
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6 animate-fade-in">
      <div>
        <h1 className="font-mono text-2xl mb-2">Profile</h1>
        <p className="text-[var(--color-accent)]">Manage your account settings</p>
      </div>

      {/* Profile Avatar & Basic Info */}
      <Card>
        <div className="flex items-center gap-6">
          <div className="w-20 h-20 rounded-full border-2 border-[var(--color-secondary)] flex items-center justify-center bg-[var(--color-secondary)]/10">
            <User size={40} />
          </div>
          <div>
            <h2 className="font-mono text-xl">{user?.username || 'User'}</h2>
            <p className="text-[var(--color-accent)] text-sm flex items-center gap-2">
              <Shield size={14} />
              {user?.role || 'Administrator'}
            </p>
          </div>
        </div>
      </Card>

      {/* Success Message */}
      {successMessage && (
        <div className="p-4 bg-[var(--color-success)]/10 border-2 border-[var(--color-success)] rounded-xl text-[var(--color-success)] text-center">
          {successMessage}
        </div>
      )}

      {/* Error Message */}
      {errors.submit && (
        <div className="p-4 bg-red-500/10 border-2 border-red-500 rounded-xl text-red-500 text-center">
          {errors.submit}
        </div>
      )}

      {/* Profile Form */}
      <form onSubmit={handleSubmit}>
        <Card>
          <div className="flex items-center justify-between mb-6">
            <h2 className="font-mono text-lg">Account Details</h2>
            {!isEditing && (
              <Button type="button" variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                Edit
              </Button>
            )}
          </div>

          <div className="space-y-4">
            {/* Username */}
            <div>
              <label className="block font-mono text-sm mb-2">
                <User size={14} className="inline mr-2" />
                Username
              </label>
              {isEditing ? (
                <>
                  <Input
                    name="username"
                    value={formData.username}
                    onChange={handleInputChange}
                    placeholder="Enter username"
                  />
                  {errors.username && (
                    <p className="text-red-500 text-xs mt-1">{errors.username}</p>
                  )}
                </>
              ) : (
                <p className="py-2 px-4 bg-[var(--color-secondary)]/5 rounded-full">
                  {user?.username || 'Not set'}
                </p>
              )}
            </div>

            {/* Email */}
            <div>
              <label className="block font-mono text-sm mb-2">
                <Mail size={14} className="inline mr-2" />
                Email
              </label>
              {isEditing ? (
                <Input
                  name="email"
                  type="email"
                  value={formData.email}
                  onChange={handleInputChange}
                  placeholder="Enter email (optional)"
                />
              ) : (
                <p className="py-2 px-4 bg-[var(--color-secondary)]/5 rounded-full">
                  {user?.email || 'Not set'}
                </p>
              )}
            </div>
          </div>
        </Card>

        {/* Password Change Section */}
        {isEditing && (
          <Card className="mt-6">
            <h2 className="font-mono text-lg mb-6">Change Password</h2>
            <p className="text-[var(--color-accent)] text-sm mb-4">
              Leave blank to keep your current password
            </p>

            <div className="space-y-4">
              {/* Current Password */}
              <div>
                <label className="block font-mono text-sm mb-2">
                  <Key size={14} className="inline mr-2" />
                  Current Password
                </label>
                <div className="relative">
                  <Input
                    name="currentPassword"
                    type={showPassword ? 'text' : 'password'}
                    value={formData.currentPassword}
                    onChange={handleInputChange}
                    placeholder="Enter current password"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-4 top-1/2 -translate-y-1/2 text-[var(--color-accent)] hover:text-[var(--color-secondary)]"
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
                {errors.currentPassword && (
                  <p className="text-red-500 text-xs mt-1">{errors.currentPassword}</p>
                )}
              </div>

              {/* New Password */}
              <div>
                <label className="block font-mono text-sm mb-2">
                  <Key size={14} className="inline mr-2" />
                  New Password
                </label>
                <Input
                  name="newPassword"
                  type={showPassword ? 'text' : 'password'}
                  value={formData.newPassword}
                  onChange={handleInputChange}
                  placeholder="Enter new password"
                />
                {errors.newPassword && (
                  <p className="text-red-500 text-xs mt-1">{errors.newPassword}</p>
                )}
              </div>

              {/* Confirm New Password */}
              <div>
                <label className="block font-mono text-sm mb-2">
                  <Key size={14} className="inline mr-2" />
                  Confirm New Password
                </label>
                <Input
                  name="confirmPassword"
                  type={showPassword ? 'text' : 'password'}
                  value={formData.confirmPassword}
                  onChange={handleInputChange}
                  placeholder="Confirm new password"
                />
                {errors.confirmPassword && (
                  <p className="text-red-500 text-xs mt-1">{errors.confirmPassword}</p>
                )}
              </div>
            </div>
          </Card>
        )}

        {/* Action Buttons */}
        {isEditing && (
          <div className="flex gap-3 mt-6">
            <Button type="submit" className="flex-1" disabled={isSaving}>
              <Save size={16} />
              {isSaving ? 'Saving...' : 'Save Changes'}
            </Button>
            <Button type="button" variant="outline" onClick={handleCancel}>
              Cancel
            </Button>
          </div>
        )}
      </form>

      {/* Danger Zone */}
      <Card className="border-red-500/50">
        <h2 className="font-mono text-lg mb-4 text-red-500">Danger Zone</h2>
        <p className="text-[var(--color-accent)] text-sm mb-4">
          These actions are irreversible. Please proceed with caution.
        </p>
        <Button 
          variant="outline" 
          className="border-red-500 text-red-500 hover:bg-red-500 hover:text-white"
          onClick={() => {
            if (confirm('Are you sure you want to delete your account? This action cannot be undone.')) {
              // TODO: Handle account deletion
            }
          }}
        >
          Delete Account
        </Button>
      </Card>
    </div>
  );
};

export default Profile;
