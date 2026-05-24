import { useNavigate } from "react-router-dom";
import { Clock, Shield } from "lucide-react";
import PropTypes from "prop-types";
import ModalCard from "../cards/ModalCard";
import { useAuth } from "../../hooks/useAuth";

export default function SessionExpiredModal({ isOpen, onClose }) {
  const navigate = useNavigate();
  const { me } = useAuth();

  function handleLogin() {
    navigate("/");
    onClose?.();
  }

  if (!isOpen || !me) return null;

  if (!isOpen) return null;

  return (
    <ModalCard 
      title="Session Expired" 
      onClose={onClose}
      className="max-w-md"
    >
      <div className="space-y-6">
        <div className="flex justify-center">
          <div className="w-16 h-16 rounded-full bg-info/10 border border-info/20 flex items-center justify-center">
            <Clock className="w-8 h-8 text-info" strokeWidth={2} />
          </div>
        </div>

        <div className="text-center space-y-2">
          <p className="text-primary font-sans text-base">
            For your security, your session has timed out.
          </p>
          <p className="text-primary/60 text-sm">
            This happens when you've been inactive for a while, or when logging in from a new device.
          </p>
        </div>

        <div className="bg-info/5 border border-info/20 rounded-large-element p-4">
          <div className="flex items-start gap-3">
            <Shield className="w-5 h-5 text-info flex-shrink-0 mt-0.5" strokeWidth={2} />
            <div className="space-y-1">
              <p className="text-primary text-sm font-medium">Why this happens</p>
              <p className="text-primary/60 text-xs leading-relaxed">
                Session timeouts protect your account from unauthorized access. Your data is safe - you'll just need to verify your identity again.
              </p>
            </div>
          </div>
        </div>

        <div className="pt-2">
          <button
            onClick={handleLogin}
            className="w-full px-4 py-2 rounded-pill bg-primary text-secondary hover:bg-secondary hover:text-primary hover:ring-2 hover:ring-primary transition-all font-mono text-sm"
          >
            Log In Again
          </button>
        </div>

        <p className="text-center text-xs text-primary/40">
          You'll be redirected to the login screen
        </p>
      </div>
    </ModalCard>
  );
}

SessionExpiredModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func,
};
