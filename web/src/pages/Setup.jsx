import { useState } from 'react';
import { Eye, EyeOff, CheckCircle, ArrowRight } from 'lucide-react';
import { Card, Button, Input } from '../components/ui';

const Setup = ({ onComplete }) => {
  const [step, setStep] = useState(1);
  const [formData, setFormData] = useState({
    username: '',
    password: '',
    confirmPassword: '',
    email: '',
  });
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const updateField = (field, value) => {
    setFormData(prev => ({ ...prev, [field]: value }));
    setError('');
  };

  const validateStep1 = () => {
    if (!formData.username || formData.username.length < 3) {
      setError('Username must be at least 3 characters');
      return false;
    }
    if (!formData.password || formData.password.length < 8) {
      setError('Password must be at least 8 characters');
      return false;
    }
    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match');
      return false;
    }
    return true;
  };

  const handleNext = () => {
    if (step === 1 && validateStep1()) {
      setStep(2);
    }
  };

  const handleComplete = async () => {
    setIsLoading(true);
    setError('');

    try {
      await onComplete({
        username: formData.username,
        password: formData.password,
        email: formData.email || undefined,
      });
    } catch (err) {
      setError(err.message || 'Setup failed. Please try again.');
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-lg animate-scale-in">
        {/* Logo/Brand */}
        <div className="text-center mb-8">
          <h1 className="font-mono text-3xl mb-2">LibreServ</h1>
          <p className="text-[var(--color-accent)]">Initial Setup</p>
        </div>

        {/* Progress */}
        <div className="flex items-center justify-center gap-2 mb-8">
          <div className={`w-3 h-3 rounded-full border-2 ${step >= 1 ? 'bg-[var(--color-secondary)] border-[var(--color-secondary)]' : 'border-[var(--color-accent)]'}`} />
          <div className={`w-16 h-0.5 ${step >= 2 ? 'bg-[var(--color-secondary)]' : 'bg-[var(--color-accent)]'}`} />
          <div className={`w-3 h-3 rounded-full border-2 ${step >= 2 ? 'bg-[var(--color-secondary)] border-[var(--color-secondary)]' : 'border-[var(--color-accent)]'}`} />
        </div>

        <Card padding="lg">
          {step === 1 && (
            <>
              <h2 className="font-mono text-xl mb-2 text-center">Create Admin Account</h2>
              <p className="text-sm text-[var(--color-accent)] text-center mb-6">
                Set up your administrator credentials
              </p>

              {error && (
                <div className="mb-4 p-3 bg-red-500/10 border-2 border-red-500 rounded-xl text-red-500 text-sm text-center">
                  {error}
                </div>
              )}

              <div className="space-y-4">
                <div>
                  <label className="block font-mono text-sm mb-2">Username</label>
                  <Input
                    type="text"
                    placeholder="Choose a username"
                    value={formData.username}
                    onChange={(e) => updateField('username', e.target.value)}
                    autoComplete="username"
                  />
                </div>

                <div>
                  <label className="block font-mono text-sm mb-2">Password</label>
                  <div className="relative">
                    <Input
                      type={showPassword ? 'text' : 'password'}
                      placeholder="Choose a strong password"
                      value={formData.password}
                      onChange={(e) => updateField('password', e.target.value)}
                      autoComplete="new-password"
                      className="pr-12"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword(!showPassword)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[var(--color-accent)] hover:text-[var(--color-secondary)] transition-colors"
                    >
                      {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                    </button>
                  </div>
                </div>

                <div>
                  <label className="block font-mono text-sm mb-2">Confirm Password</label>
                  <Input
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Confirm your password"
                    value={formData.confirmPassword}
                    onChange={(e) => updateField('confirmPassword', e.target.value)}
                    autoComplete="new-password"
                  />
                </div>

                <div>
                  <label className="block font-mono text-sm mb-2">
                    Email <span className="text-[var(--color-accent)]">(optional)</span>
                  </label>
                  <Input
                    type="email"
                    placeholder="your@email.com"
                    value={formData.email}
                    onChange={(e) => updateField('email', e.target.value)}
                    autoComplete="email"
                  />
                </div>
              </div>

              <Button
                variant="filled"
                className="w-full mt-6"
                onClick={handleNext}
              >
                Continue
                <ArrowRight size={18} />
              </Button>
            </>
          )}

          {step === 2 && (
            <>
              <div className="text-center">
                <CheckCircle className="w-16 h-16 mx-auto mb-4 text-green-500" />
                <h2 className="font-mono text-xl mb-2">Ready to Go!</h2>
                <p className="text-sm text-[var(--color-accent)] mb-6">
                  Your LibreServ instance is configured and ready to use.
                </p>
              </div>

              <div className="bg-[var(--color-secondary)]/5 rounded-xl p-4 mb-6">
                <h3 className="font-mono text-sm mb-3">Summary</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex justify-between">
                    <span className="text-[var(--color-accent)]">Username:</span>
                    <span className="font-mono">{formData.username}</span>
                  </div>
                  {formData.email && (
                    <div className="flex justify-between">
                      <span className="text-[var(--color-accent)]">Email:</span>
                      <span className="font-mono">{formData.email}</span>
                    </div>
                  )}
                </div>
              </div>

              {error && (
                <div className="mb-4 p-3 bg-red-500/10 border-2 border-red-500 rounded-xl text-red-500 text-sm text-center">
                  {error}
                </div>
              )}

              <div className="flex gap-3">
                <Button
                  variant="outline"
                  className="flex-1"
                  onClick={() => setStep(1)}
                  disabled={isLoading}
                >
                  Back
                </Button>
                <Button
                  variant="filled"
                  className="flex-1"
                  onClick={handleComplete}
                  disabled={isLoading}
                >
                  {isLoading ? (
                    <span className="flex items-center gap-2">
                      <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                      Setting up...
                    </span>
                  ) : (
                    'Complete Setup'
                  )}
                </Button>
              </div>
            </>
          )}
        </Card>

        <p className="text-center text-sm text-[var(--color-accent)] mt-6">
          Powered by LibreLoom
        </p>
      </div>
    </div>
  );
};

export default Setup;
