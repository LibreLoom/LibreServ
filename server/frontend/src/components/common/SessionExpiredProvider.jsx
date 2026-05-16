import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import SessionExpiredModal from "./SessionExpiredModal";

export function SessionExpiredProvider({ children }) {
  const [showModal, setShowModal] = useState(false);
  const [pendingCount, setPendingCount] = useState(0);

  const handleShow = useCallback(() => {
    setPendingCount((prev) => prev + 1);
    setShowModal(true);
  }, []);

  const handleClose = useCallback(() => {
    setShowModal(false);
    setPendingCount(0);
  }, []);

  useEffect(() => {
    window.__triggerSessionExpired = handleShow;
    
    return () => {
      window.__triggerSessionExpired = null;
    };
  }, [handleShow]);

  useEffect(() => {
    if (pendingCount > 0 && showModal) {
      const timer = setTimeout(() => {
        setPendingCount(0);
      }, 30000);
      
      return () => clearTimeout(timer);
    }
  }, [pendingCount, showModal]);

  return (
    <>
      {children}
      <SessionExpiredModal 
        isOpen={showModal} 
        onClose={handleClose}
      />
    </>
  );
}

export default SessionExpiredProvider;

SessionExpiredProvider.propTypes = {
  children: PropTypes.node,
};
