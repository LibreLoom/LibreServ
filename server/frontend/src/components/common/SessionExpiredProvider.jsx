import { useState, useEffect, useCallback } from "react";
import PropTypes from "prop-types";
import { useAuth } from "../../hooks/useAuth";
import SessionExpiredModal from "./SessionExpiredModal";

export function SessionExpiredProvider({ children }) {
  const [showModal, setShowModal] = useState(false);
  const { me } = useAuth();

  const handleClose = useCallback(() => {
    setShowModal(false);
  }, []);

  useEffect(() => {
    const onSessionExpired = () => {
      setShowModal(true);
    };
    document.addEventListener("libreserv:session-expired", onSessionExpired);

    return () => {
      document.removeEventListener("libreserv:session-expired", onSessionExpired);
    };
  }, []);

  return (
    <>
      {children}
      <SessionExpiredModal 
        isOpen={showModal && !me} 
        onClose={handleClose}
      />
    </>
  );
}

export default SessionExpiredProvider;

SessionExpiredProvider.propTypes = {
  children: PropTypes.node,
};
