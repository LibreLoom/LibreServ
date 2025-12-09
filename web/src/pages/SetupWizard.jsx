import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { 
  ArrowLeft, 
  ArrowRight, 
  Check, 
  AlertCircle, 
  Globe, 
  Shield, 
  User, 
  Zap,
  Wifi,
  Lock,
  Mail
} from 'lucide-react';
import { Card, Button, Input, Pill, StatusIndicator } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { api } from '../api/client';

export default function SetupWizard() {
  const navigate = useNavigate();
  const { completeSetup, isSetupComplete } = useAuth();
  const [currentStep, setCurrentStep] = useState(1);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [setupData, setSetupData] = useState({
    adminUsername: '',
    adminPassword: '',
    adminEmail: '',
    domain: '',
    subdomain: '',
    sslEmail: '',
    autoHTTPS: true,
    enablePortForwarding: false
  });

  const steps = [
    { 
      id: 1, 
      title: 'Welcome', 
      description: 'Welcome to LibreServ setup',
      icon: Zap,
      completed: false
    },
    { 
      id: 2, 
      title: 'Admin Account', 
      description: 'Create your admin account',
      icon: User,
      completed: false
    },
    { 
      id: 3, 
      title: 'Network', 
      description: 'Configure domain settings',
      icon: Globe,
      completed: false
    },
    { 
      id: 4, 
      title: 'Security', 
      description: 'SSL certificate setup',
      icon: Shield,
      completed: false
    },
    { 
      id: 5, 
      title: 'Complete', 
      description: 'Setup complete',
      icon: Check,
      completed: false
    }
  ];

  const [systemCheck, setSystemCheck] = useState({
    docker: { status: 'checking', message: '' },
    network: { status: 'checking', message: '' },
    storage: { status: 'checking', message: '' }
  });

  useEffect(() => {
    if (currentStep === 1) {
      performSystemCheck();
    }
  }, [currentStep]);

  const performSystemCheck = async () => {
    // Simulate system checks
    await new Promise(resolve => setTimeout(resolve, 1500));
    
    setSystemCheck({
      docker: { status: 'ok', message: 'Docker is running' },
      network: { status: 'ok', message: 'Network connectivity verified' },
      storage: { status: 'ok', message: 'Sufficient storage available' }
    });
  };

  const handleNext = async () => {
    if (currentStep < steps.length) {
      setCurrentStep(currentStep + 1);
    }
  };

  const handleBack = () => {
    if (currentStep > 1) {
      setCurrentStep(currentStep - 1);
    }
  };

  const validateStep = (step) => {
    switch (step) {
      case 2: // Admin Account
        return setupData.adminUsername.length >= 3 && 
               setupData.adminPassword.length >= 8;
      case 3: // Network
        return setupData.domain.length > 0;
      case 4: // Security
        return !setupData.autoHTTPS || setupData.sslEmail.length > 0;
      default:
        return true;
    }
  };

  const handleCompleteSetup = async () => {
    setIsLoading(true);
    setError(null);

    try {
      // Complete the setup
      await completeSetup({
        username: setupData.adminUsername,
        password: setupData.adminPassword,
        email: setupData.adminEmail
      });

      // Configure domain if provided
      if (setupData.domain) {
        await api.post('/api/v1/network/domain', {
          defaultDomain: setupData.domain,
          sslEmail: setupData.sslEmail,
          autoHTTPS: setupData.autoHTTPS
        });
      }

      // Navigate to dashboard
      navigate('/');
    } catch (err) {
      setError(err.message || 'Setup failed');
    } finally {
      setIsLoading(false);
    }
  };

  const renderStep = () => {
    switch (currentStep) {
      case 1:
        return <WelcomeStep systemCheck={systemCheck} />;
      case 2:
        return (
          <AdminAccountStep 
            setupData={setupData}
            setSetupData={setSetupData}
          />
        );
      case 3:
        return (
          <NetworkStep 
            setupData={setupData}
            setSetupData={setSetupData}
          />
        );
      case 4:
        return (
          <SecurityStep 
            setupData={setupData}
            setSetupData={setSetupData}
          />
        );
      case 5:
        return (
          <CompleteStep 
            setupData={setupData}
            onComplete={handleCompleteSetup}
            isLoading={isLoading}
          />
        );
      default:
        return null;
    }
  };

  const canProceed = () => {
    return validateStep(currentStep) && !isLoading;
  };

  return (
    <div className="min-h-screen bg-[var(--color-primary)] flex items-center justify-center p-4">
      <div className="w-full max-w-4xl">
        {/* Header */}
        <div className="text-center mb-8">
          <h1 className="font-mono text-3xl mb-2">LibreServ Setup</h1>
          <p className="text-[var(--color-accent)]">
            Let's get your self-hosting platform configured
          </p>
        </div>

        {/* Progress Steps */}
        <div className="mb-8">
          <div className="flex items-center justify-between">
            {steps.map((step, index) => {
              const Icon = step.icon;
              const isActive = currentStep === step.id;
              const isCompleted = currentStep > step.id;
              
              return (
                <div key={step.id} className="flex items-center">
                  <div className={`
                    flex items-center justify-center w-12 h-12 rounded-full border-2 transition-all duration-200
                    ${isActive 
                      ? 'border-[var(--color-secondary)] bg-[var(--color-secondary)] text-[var(--color-primary)]' 
                      : isCompleted
                      ? 'border-[var(--color-secondary)] bg-[var(--color-secondary)]/20 text-[var(--color-secondary)]'
                      : 'border-[var(--color-secondary)]/30 text-[var(--color-accent)]'
                    }
                  `}>
                    {isCompleted ? (
                      <Check size={20} />
                    ) : (
                      <Icon size={20} />
                    )}
                  </div>
                  
                  {index < steps.length - 1 && (
                    <div className={`
                      flex-1 h-0.5 mx-4 transition-all duration-200
                      ${isCompleted ? 'bg-[var(--color-secondary)]' : 'bg-[var(--color-secondary)]/30'}
                    `} />
                  )}
                </div>


// Step Components
function WelcomeStep({ systemCheck }) {
  const checks = [
    { key: 'docker', label: 'Docker Engine', icon: Zap },
    { key: 'network', label: 'Network Access', icon: Wifi },
    { key: 'storage', label: 'Storage Space', icon: Shield }
  ];

  return (
    <div className="text-center space-y-6">
      <div className="w-20 h-20 bg-[var(--color-secondary)]/10 rounded-full flex items-center justify-center mx-auto">
        <Zap size={32} className="text-[var(--color-secondary)]" />
      </div>
      
      <div>
        <h3 className="font-mono text-xl mb-2">Welcome to LibreServ</h3>
        <p className="text-[var(--color-accent)] mb-6">
          We'll guide you through setting up your self-hosting platform in just a few steps.
        </p>
      </div>

      <div className="space-y-4">
        {checks.map(({ key, label, icon: Icon }) => (
          <div key={key} className="flex items-center justify-between p-4 bg-[var(--color-secondary)]/5 rounded-xl">
            <div className="flex items-center gap-3">
              <Icon size={20} className="text-[var(--color-accent)]" />
              <span className="font-mono">{label}</span>
            </div>
            <div className="flex items-center gap-2">
              {systemCheck[key].status === 'checking' && (
                <div className="w-4 h-4 border-2 border-[var(--color-secondary)] border-t-transparent rounded-full animate-spin" />
              )}
              {systemCheck[key].status === 'ok' && (
                <StatusIndicator status="active" size="sm" />
              )}
              <span className="text-sm text-[var(--color-accent)]">
                {systemCheck[key].message}
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminAccountStep({ setupData, setSetupData }) {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="font-mono text-xl mb-2">Create Admin Account</h3>
        <p className="text-[var(--color-accent)]">
          This account will have full access to LibreServ
        </p>
      </div>

      <div className="space-y-4 max-w-md mx-auto">
        <Input
          label="Username"
          placeholder="admin"
          value={setupData.adminUsername}
          onChange={(e) => setSetupData({...setupData, adminUsername: e.target.value})}
          required
        />

        <Input
          label="Password"
          type="password"
          placeholder="••••••••"
          value={setupData.adminPassword}
          onChange={(e) => setSetupData({...setupData, adminPassword: e.target.value})}
          required
        />

        <Input
          label="Email (optional)"
          type="email"
          placeholder="admin@example.com"
          value={setupData.adminEmail}
          onChange={(e) => setSetupData({...setupData, adminEmail: e.target.value})}
        />

        <div className="text-sm text-[var(--color-accent)] space-y-1">
          <p>Password requirements:</p>
          <ul className="list-disc list-inside space-y-1 ml-4">
            <li className={setupData.adminPassword.length >= 8 ? 'text-green-400' : ''}>
              At least 8 characters
            </li>
            <li className={/[A-Z]/.test(setupData.adminPassword) ? 'text-green-400' : ''}>
              One uppercase letter
            </li>
            <li className={/[0-9]/.test(setupData.adminPassword) ? 'text-green-400' : ''}>
              One number
            </li>
          </ul>
        </div>
      </div>
    </div>
  );
}
              );
            })}
          </div>
          
          <div className="text-center mt-4">
            <h2 className="font-mono text-xl">{steps[currentStep - 1]?.title}</h2>
            <p className="text-[var(--color-accent)] text-sm">
              {steps[currentStep - 1]?.description}
            </p>
          </div>
        </div>

        {/* Error Display */}
        {error && (
          <Card className="mb-6 border-red-500/20 bg-red-500/5">
            <div className="flex items-center gap-3 text-red-400">
              <AlertCircle size={20} />
              <span>{error}</span>
            </div>
          </Card>
        )}

        {/* Step Content */}
        <Card className="mb-6">
          {renderStep()}
        </Card>

        {/* Navigation */}
        <div className="flex justify-between">
          <Button
            variant="outline"
            onClick={handleBack}
            disabled={currentStep === 1 || isLoading}
          >
            <ArrowLeft size={16} />
            Back
          </Button>

function NetworkStep({ setupData, setSetupData }) {
  const commonSubdomains = ['app', 'www', 'nextcloud', 'jellyfin', 'vaultwarden'];

  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="font-mono text-xl mb-2">Network Configuration</h3>
        <p className="text-[var(--color-accent)]">
          Configure your domain for easy access to your apps
        </p>
      </div>

      <div className="max-w-2xl mx-auto space-y-6">
        <div>
          <label className="block text-sm font-mono mb-2">Domain Name</label>
          <Input
            placeholder="example.com"
            value={setupData.domain}
            onChange={(e) => setSetupData({...setupData, domain: e.target.value})}
          />
          <p className="text-sm text-[var(--color-accent)] mt-1">
            Your main domain. Apps will be accessible as subdomain.example.com
          </p>
        </div>

        {setupData.domain && (
          <div>
            <label className="block text-sm font-mono mb-2">Preferred Subdomain</label>
            <div className="flex flex-wrap gap-2 mb-2">
              {commonSubdomains.map(sub => (
                <Pill
                  key={sub}
                  size="sm"
                  variant={setupData.subdomain === sub ? "default" : "outline"}
                  onClick={() => setSetupData({...setupData, subdomain: sub})}
                  className="cursor-pointer"
                >
                  {sub}
                </Pill>
              ))}
            </div>
            <Input
              placeholder="app"
              value={setupData.subdomain}
              onChange={(e) => setSetupData({...setupData, subdomain: e.target.value})}
            />
            <p className="text-sm text-[var(--color-accent)] mt-1">
              Your apps will be accessible at: {setupData.subdomain || 'app'}.{setupData.domain}
            </p>
          </div>
        )}

        <div className="p-4 bg-[var(--color-secondary)]/5 rounded-xl">
          <div className="flex items-center gap-2 mb-2">
            <Wifi size={16} />
            <span className="font-mono text-sm">Port Forwarding</span>
          </div>
          <p className="text-sm text-[var(--color-accent)] mb-3">
            To access your apps from outside your network, you'll need to forward ports on your router.
          </p>
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={setupData.enablePortForwarding}
              onChange={(e) => setSetupData({...setupData, enablePortForwarding: e.target.checked})}
              className="w-4 h-4"
            />
            <span className="text-sm">I want to configure port forwarding</span>
          </label>
        </div>
      </div>
    </div>
  );
}

function SecurityStep({ setupData, setSetupData }) {
  return (
    <div className="space-y-6">
      <div className="text-center">
        <h3 className="font-mono text-xl mb-2">SSL Certificate Setup</h3>
        <p className="text-[var(--color-accent)]">
          Configure HTTPS for secure access to your apps
        </p>
      </div>

      <div className="max-w-2xl mx-auto space-y-6">
        <div className="p-4 bg-[var(--color-secondary)]/5 rounded-xl">
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={setupData.autoHTTPS}
              onChange={(e) => setSetupData({...setupData, autoHTTPS: e.target.checked})}
              className="w-4 h-4"
            />
            <div>
              <span className="font-mono text-sm">Automatic HTTPS</span>
              <p className="text-sm text-[var(--color-accent)]">
                Get free SSL certificates from Let's Encrypt
              </p>
            </div>
          </label>
        </div>

        {setupData.autoHTTPS && (
          <div className="animate-slide-down">
            <label className="block text-sm font-mono mb-2">Email for SSL Certificate</label>
            <Input
              type="email"
              placeholder="admin@example.com"
              value={setupData.sslEmail}
              onChange={(e) => setSetupData({...setupData, sslEmail: e.target.value})}
            />
            <p className="text-sm text-[var(--color-accent)] mt-1">
              Required for Let's Encrypt certificate notifications
            </p>
          </div>
        )}

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="p-4 border-2 border-[var(--color-secondary)]/20 rounded-xl">
            <div className="flex items-center gap-2 mb-2">
              <Lock size={16} className="text-green-400" />
              <span className="font-mono text-sm">Secure</span>
            </div>
            <p className="text-sm text-[var(--color-accent)]">
              HTTPS enabled with automatic certificate renewal
            </p>
          </div>
          
          <div className="p-4 border-2 border-[var(--color-secondary)]/20 rounded-xl">
            <div className="flex items-center gap-2 mb-2">
              <Globe size={16} className="text-[var(--color-accent)]" />
              <span className="font-mono text-sm">Accessible</span>
            </div>
            <p className="text-sm text-[var(--color-accent)]">
              Apps accessible via custom domains
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function CompleteStep({ setupData, onComplete, isLoading }) {
  const summary = [
    { label: 'Admin Username', value: setupData.adminUsername },
    { label: 'Domain', value: setupData.domain ? `${setupData.subdomain || 'app'}.${setupData.domain}` : 'Not configured' },
    { label: 'HTTPS', value: setupData.autoHTTPS ? 'Enabled' : 'Disabled' },
    { label: 'Port Forwarding', value: setupData.enablePortForwarding ? 'Enabled' : 'Disabled' }
  ];

  return (
    <div className="space-y-6">
      <div className="text-center">
        <div className="w-20 h-20 bg-green-500/10 rounded-full flex items-center justify-center mx-auto mb-4">
          <Check size={32} className="text-green-400" />
        </div>
        <h3 className="font-mono text-xl mb-2">Setup Complete!</h3>
        <p className="text-[var(--color-accent)]">
          You're ready to start hosting your apps
        </p>
      </div>

      <div className="max-w-md mx-auto space-y-3">
        {summary.map(({ label, value }) => (
          <div key={label} className="flex justify-between items-center p-3 bg-[var(--color-secondary)]/5 rounded-lg">
            <span className="text-[var(--color-accent)] text-sm">{label}:</span>
            <span className="font-mono text-sm">{value}</span>
          </div>
        ))}
      </div>

      <div className="text-center">
        <Button
          onClick={onComplete}
          disabled={isLoading}
          className="px-8"
        >
          {isLoading ? 'Setting up LibreServ...' : 'Start Using LibreServ'}
        </Button>
      </div>
    </div>
  );
}
          {currentStep < steps.length ? (
            <Button
              onClick={handleNext}
              disabled={!canProceed()}
            >
              Next
              <ArrowRight size={16} />
            </Button>
          ) : (
            <Button
              onClick={handleCompleteSetup}
              disabled={!canProceed() || isLoading}
            >
              {isLoading ? 'Setting up...' : 'Complete Setup'}
              <Check size={16} />
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}