package handlers

import "gt.plainskill.net/LibreLoom/LibreServ/internal/network"

func (h *ACMEHandler) backendForApp(appID string) string {
	if appID == "" {
		return ""
	}
	if b, ok := h.appBackends[appID]; ok {
		return b
	}
	if h.appManager != nil {
		if b := h.appManager.GetBackendURL(appID); b != "" {
			return b
		}
	}
	return ""
}

// RegisterAppBackend allows wiring appID -> backend mapping for ACME issuance.
func (h *ACMEHandler) RegisterAppBackend(appID, backend string) {
	if appID == "" || backend == "" {
		return
	}
	h.appBackends[appID] = backend
	if h.appManager != nil {
		h.appManager.RegisterBackend(appID, backend)
	}
}

// resolveBackend determines backend from request/app/routes/defaults.
func (h *ACMEHandler) resolveBackend(req network.ACMERequest) string {
	if req.Backend != "" {
		return req.Backend
	}
	if req.AppID != "" {
		if req.BackendName != "" && h.appManager != nil {
			if b := h.appManager.GetBackendByName(req.AppID, req.BackendName); b != "" {
				return b
			}
		}
		if req.BackendIndex > 0 && h.appManager != nil {
			if b := h.appManager.GetBackendByIndex(req.AppID, req.BackendIndex); b != "" {
				return b
			}
		}
		if b := h.backendForApp(req.AppID); b != "" {
			return b
		}
		if h.caddyManager != nil {
			if r, err := h.caddyManager.GetRouteByApp(req.AppID); err == nil {
				return r.Backend
			}
		}
	}
	if h.caddyManager != nil {
		if r, ok := h.caddyManager.FindRouteByDomain(req.Domain); ok {
			return r.Backend
		}
	}
	return "http://127.0.0.1:8080"
}
