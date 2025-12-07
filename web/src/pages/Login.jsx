import { useState } from 'react';
import { Eye, EyeOff, LogIn } from 'lucide-react';
import { Card, Button, Input } from '../components/ui';

const Login = ({ onLogin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    
    if (!username || !password) {
      setError('Please enter username and password');
      return;
    }

    setIsLoading(true);

    try {
      await onLogin(username, password);
    } catch (err) {
      setError(err.message || 'Login failed. Please try again.');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className="w-full max-w-md animate-scale-in">
        {/* Logo/Brand */}
        <div className="text-center mb-8">
          <h1 className="font-mono text-3xl mb-2">LibreServ</h1>
          <p className="text-[var(--color-accent)]">Self-hosting made simple</p>
        </div>

        <Card padding="lg">
          <form onSubmit={handleSubmit}>
            <h2 className="font-mono text-xl mb-6 text-center">Sign In</h2>

            {/* Error - dashed border + pulse instead of red */}
            {error && (
              <div className="mb-4 p-3 border-2 border-dashed border-[var(--color-secondary)] rounded-xl text-[var(--color-secondary)] text-sm text-center animate-pulse">
                {error}
              </div>
            )}

            <div className="space-y-4">
              <div>
                <label htmlFor="username" className="block font-mono text-sm mb-2">
                  Username
                </label>
                <Input
                  id="username"
                  type="text"
                  placeholder="Enter username"
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  autoComplete="username"
                  required
                  disabled={isLoading}
                />
              </div>

              <div>
                <label htmlFor="password" className="block font-mono text-sm mb-2">
                  Password
                </label>
                <div className="relative">
                  <Input
                    id="password"
                    type={showPassword ? 'text' : 'password'}
                    placeholder="Enter password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                    className="pr-12"
                    disabled={isLoading}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 p-1 text-[var(--color-accent)] hover:text-[var(--color-secondary)] transition-colors"
                    disabled={isLoading}
                  >
                    {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                  </button>
                </div>
              </div>
            </div>

            <Button
              type="submit"
              variant="filled"
              size="lg"
              className="w-full mt-6"
              disabled={isLoading}
            >
              {isLoading ? (
                <span className="flex items-center gap-2">
                  <span className="w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                  Signing in...
                </span>
              ) : (
                <>
                  <LogIn size={18} />
                  Sign In
                </>
              )}
            </Button>
          </form>
        </Card>

        <p className="text-center text-sm text-[var(--color-accent)] mt-6">
          Powered by LibreLoom
        </p>
      </div>
    </div>
  );
};

export default Login;
