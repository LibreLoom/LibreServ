package handlers

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/api/middleware"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/auth/webauthn"
)

// These handlers cover WebAuthn (passkey + security key) ENROLLMENT only:
//   POST /api/v1/auth/mfa/webauthn/register/begin  {label?, type}
//   POST /api/v1/auth/mfa/webauthn/register/finish {credential}
// They are session-authed + CSRF-protected (applied by the mfa route group in
// router.go) and call auth.Service, which delegates to the injected WebAuthn
// verifier. The login-flow WebAuthn verify is NOT here: the public
// /auth/mfa/challenge and /auth/mfa/verify endpoints in mfa.go handle every
// MFA type, and for webauthn types the service dispatches through the verifier.
//
// All byte fields in the request/response bodies are base64url with no padding
// (the go-webauthn URLEncodedBase64 convention). The begin response wraps the
// PublicKeyCredentialCreationOptions under "options" so the frontend's
// webauthn helpers can read begin (create) and challenge (get) flows
// uniformly via response.options.publicKey.

// WebAuthnRegisterBegin handles POST /api/v1/auth/mfa/webauthn/register/begin
// {label?, type}. type is "passkey" (this device: phone/laptop biometrics) or
// "security_key" (a USB/NFC hardware key). Returns {options} — the data the
// browser passes to navigator.credentials.create.
func (h *MFAHandler) WebAuthnRegisterBegin(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to add a passkey or security key.")
		return
	}
	var req struct {
		Label string `json:"label"`
		Type  string `json:"type"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't read that request. Please try again.")
		return
	}
	mfaType := strings.TrimSpace(req.Type)
	if mfaType != auth.MFATypePasskey && mfaType != auth.MFATypeSecurityKey {
		JSONError(w, http.StatusBadRequest, "Choose a device type: a passkey (this device) or a security key (USB/NFC key).")
		return
	}
	label := strings.TrimSpace(req.Label)
	if label == "" {
		if mfaType == auth.MFATypePasskey {
			label = "Passkey"
		} else {
			label = "Security key"
		}
	}
	options, err := h.authService.BeginWebAuthnRegistration(r.Context(), userID, mfaType, label)
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrMFAVerifierUnavailable):
			JSONError(w, http.StatusServiceUnavailable, "Passkeys and security keys aren't set up on this device yet. Ask your administrator to enable them.")
		default:
			JSONError(w, http.StatusInternalServerError, "We couldn't start setup. Please try again.")
		}
		return
	}
	JSON(w, http.StatusOK, map[string]interface{}{"options": json.RawMessage(options)})
}

// WebAuthnRegisterFinish handles POST /api/v1/auth/mfa/webauthn/register/finish
// {credential}. credential is the navigator.credentials.create result
// ({id, rawId, type, response:{attestationObject, clientDataJSON, transports}}).
// On success the credential is saved as an enabled MFA method and the new method
// is returned.
func (h *MFAHandler) WebAuthnRegisterFinish(w http.ResponseWriter, r *http.Request) {
	userID, ok := middleware.GetUserID(r.Context())
	if !ok {
		JSONError(w, http.StatusUnauthorized, "Please log in to finish adding your device.")
		return
	}
	var req struct {
		Credential json.RawMessage `json:"credential"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || len(req.Credential) == 0 {
		JSONError(w, http.StatusBadRequest, "We didn't receive the device details. Please try the setup again.")
		return
	}
	method, err := h.authService.CompleteWebAuthnRegistration(r.Context(), userID, req.Credential)
	if err != nil {
		switch {
		case errors.Is(err, auth.ErrMFAVerifierUnavailable):
			JSONError(w, http.StatusServiceUnavailable, "Passkeys and security keys aren't set up on this device yet. Ask your administrator to enable them.")
		case errors.Is(err, webauthn.ErrSessionExpired):
			JSONError(w, http.StatusBadRequest, "Your setup timed out. Please start again.")
		case errors.Is(err, webauthn.ErrInvalidAssertion):
			JSONError(w, http.StatusBadRequest, "We couldn't verify that device. Make sure you complete the prompt on the same device, then try again.")
		default:
			JSONError(w, http.StatusInternalServerError, "We couldn't add that device. Please try again.")
		}
		return
	}
	JSON(w, http.StatusOK, map[string]interface{}{
		"method":  method,
		"message": "Device added. You can now use it to sign in.",
	})
}
