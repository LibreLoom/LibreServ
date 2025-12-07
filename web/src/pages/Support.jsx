import { useState } from 'react';
import { 
  HelpCircle,
  Book,
  MessageCircle,
  Github,
  ExternalLink,
  ChevronDown,
  ChevronUp,
  Search,
  Send
} from 'lucide-react';
import { Card, Button, Input } from '../components/ui';
import { useTheme } from '../context/ThemeContext';

// FAQ items
const FAQ_ITEMS = [
  {
    question: 'How do I add a new application?',
    answer: 'Navigate to the Apps page and click the "Install App" button. You can browse the catalog or search for specific apps. Select an app and configure its settings before installing.',
  },
  {
    question: 'How do I backup my data?',
    answer: 'LibreServ automatically creates daily backups of all app data. You can also manually trigger a backup from Settings > Backups. Backups can be stored locally or synced to external storage.',
  },
  {
    question: 'Can I access my apps from outside my network?',
    answer: 'Yes! You can configure external access through Settings > Network. LibreServ supports reverse proxy configuration, SSL certificates, and domain management for secure external access.',
  },
  {
    question: 'How do I update an application?',
    answer: 'Go to the app detail page and click "Update" if a new version is available. You can also enable automatic updates for specific apps in their settings.',
  },
  {
    question: 'What happens if an app crashes?',
    answer: 'LibreServ monitors all apps and will automatically attempt to restart crashed containers. Check the logs for error details. If issues persist, try stopping and starting the app manually.',
  },
  {
    question: 'How do I manage user permissions?',
    answer: 'Navigate to Users and select a user to manage their permissions. You can grant different access levels per app: View Only, Manage, or Full Control.',
  },
];

// Resources
const RESOURCES = [
  {
    title: 'Documentation',
    description: 'Comprehensive guides and API reference',
    icon: Book,
    url: 'https://docs.libreserv.local',
  },
  {
    title: 'GitHub',
    description: 'Source code and issue tracker',
    icon: Github,
    url: 'https://github.com/libreserv/libreserv',
  },
  {
    title: 'Community Forum',
    description: 'Ask questions and share knowledge',
    icon: MessageCircle,
    url: 'https://forum.libreserv.local',
  },
];

export default function Support() {
  const { haptic } = useTheme();
  
  const [searchQuery, setSearchQuery] = useState('');
  const [expandedFaq, setExpandedFaq] = useState(null);
  const [contactForm, setContactForm] = useState({
    subject: '',
    message: '',
  });
  const [messageSent, setMessageSent] = useState(false);

  const filteredFaq = FAQ_ITEMS.filter(item =>
    item.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
    item.answer.toLowerCase().includes(searchQuery.toLowerCase())
  );

  const handleContactSubmit = async (e) => {
    e.preventDefault();
    
    if (!contactForm.subject.trim() || !contactForm.message.trim()) return;
    
    haptic('medium');
    
    // Simulate sending
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    setContactForm({ subject: '', message: '' });
    setMessageSent(true);
    setTimeout(() => setMessageSent(false), 5000);
  };

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <h1 className="font-mono text-2xl flex items-center gap-2">
          <HelpCircle size={24} />
          Support
        </h1>
        <p className="text-[var(--color-accent)] mt-1">
          Get help and find answers to common questions
        </p>
      </div>

      {/* Quick Links */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {RESOURCES.map((resource, i) => (
          <Card 
            key={i} 
            className="hover:bg-[var(--color-secondary)]/5 transition-colors cursor-pointer"
            onClick={() => {
              haptic('light');
              window.open(resource.url, '_blank');
            }}
          >
            <div className="flex items-start gap-4">
              <div className="p-3 bg-[var(--color-secondary)]/10 rounded-full">
                <resource.icon size={20} />
              </div>
              <div className="flex-1">
                <h3 className="font-mono flex items-center gap-2">
                  {resource.title}
                  <ExternalLink size={14} className="text-[var(--color-accent)]" />
                </h3>
                <p className="text-[var(--color-accent)] text-sm mt-1">
                  {resource.description}
                </p>
              </div>
            </div>
          </Card>
        ))}
      </div>

      {/* FAQ */}
      <Card>
        <h2 className="font-mono text-lg mb-4">Frequently Asked Questions</h2>
        
        {/* Search */}
        <div className="relative mb-4">
          <Search 
            className="absolute left-4 top-1/2 -translate-y-1/2 text-[var(--color-accent)]" 
            size={18} 
          />
          <Input
            type="search"
            placeholder="Search FAQs..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-12"
          />
        </div>

        {/* FAQ List */}
        <div className="space-y-2">
          {filteredFaq.map((item, i) => (
            <div 
              key={i}
              className="border-2 border-[var(--color-secondary)]/20 rounded-2xl overflow-hidden"
            >
              <button
                onClick={() => {
                  haptic('light');
                  setExpandedFaq(expandedFaq === i ? null : i);
                }}
                className="w-full flex items-center justify-between p-4 text-left hover:bg-[var(--color-secondary)]/5 transition-colors"
              >
                <span className="font-mono text-sm">{item.question}</span>
                {expandedFaq === i ? (
                  <ChevronUp size={18} className="text-[var(--color-accent)]" />
                ) : (
                  <ChevronDown size={18} className="text-[var(--color-accent)]" />
                )}
              </button>
              
              {expandedFaq === i && (
                <div className="px-4 pb-4 animate-slide-down">
                  <p className="text-[var(--color-accent)] text-sm leading-relaxed">
                    {item.answer}
                  </p>
                </div>
              )}
            </div>
          ))}
          
          {filteredFaq.length === 0 && (
            <p className="text-center text-[var(--color-accent)] py-8">
              No FAQs found matching "{searchQuery}"
            </p>
          )}
        </div>
      </Card>

      {/* Contact Form */}
      <Card>
        <h2 className="font-mono text-lg mb-4 flex items-center gap-2">
          <MessageCircle size={20} />
          Contact Support
        </h2>
        
        {messageSent ? (
          <div className="text-center py-8 animate-slide-up">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full border-2 border-[var(--color-secondary)] flex items-center justify-center">
              <span className="text-2xl">●</span>
            </div>
            <h3 className="font-mono text-lg mb-2">Message Sent</h3>
            <p className="text-[var(--color-accent)]">
              We'll get back to you as soon as possible.
            </p>
          </div>
        ) : (
          <form onSubmit={handleContactSubmit} className="space-y-4">
            <div>
              <label className="block font-mono text-sm mb-2">Subject</label>
              <Input
                value={contactForm.subject}
                onChange={(e) => setContactForm(prev => ({ ...prev, subject: e.target.value }))}
                placeholder="What's this about?"
              />
            </div>

            <div>
              <label className="block font-mono text-sm mb-2">Message</label>
              <textarea
                value={contactForm.message}
                onChange={(e) => setContactForm(prev => ({ ...prev, message: e.target.value }))}
                placeholder="Describe your issue or question..."
                rows={5}
                className="
                  w-full px-4 py-3
                  bg-[var(--color-primary)] text-[var(--color-secondary)]
                  border-2 border-[var(--color-secondary)]
                  rounded-2xl
                  placeholder:text-[var(--color-accent)]
                  focus:outline-none focus:border-[var(--color-accent)]
                  transition-colors duration-200
                  resize-none
                "
              />
            </div>

            <Button 
              type="submit"
              disabled={!contactForm.subject.trim() || !contactForm.message.trim()}
            >
              <Send size={16} />
              Send Message
            </Button>
          </form>
        )}
      </Card>

      {/* System Info */}
      <Card>
        <h2 className="font-mono text-lg mb-4">System Information</h2>
        
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div className="p-3 bg-[var(--color-secondary)]/5 rounded-2xl">
            <p className="text-[var(--color-accent)]">LibreServ Version</p>
            <p className="font-mono">1.0.0-beta</p>
          </div>
          <div className="p-3 bg-[var(--color-secondary)]/5 rounded-2xl">
            <p className="text-[var(--color-accent)]">Docker Version</p>
            <p className="font-mono">24.0.7</p>
          </div>
          <div className="p-3 bg-[var(--color-secondary)]/5 rounded-2xl">
            <p className="text-[var(--color-accent)]">Operating System</p>
            <p className="font-mono">Debian 12</p>
          </div>
          <div className="p-3 bg-[var(--color-secondary)]/5 rounded-2xl">
            <p className="text-[var(--color-accent)]">Last Update Check</p>
            <p className="font-mono">Today at 3:00 AM</p>
          </div>
        </div>
      </Card>
    </div>
  );
}
