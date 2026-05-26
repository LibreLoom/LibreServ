package handlers

import (
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

type ConnectivityHandler struct {
	ddnsService *network.DDNSService
	appManager  *apps.Manager
	caddyMgr    *network.CaddyManager
}

func NewConnectivityHandler(ddnsService *network.DDNSService, upnpService *network.UPnPService, appManager *apps.Manager, caddyMgr *network.CaddyManager) *ConnectivityHandler {
	return &ConnectivityHandler{
		ddnsService: ddnsService,
		appManager:  appManager,
		caddyMgr:    caddyMgr,
	}
}

func (h *ConnectivityHandler) GetStatus(w http.ResponseWriter, r *http.Request) {
	status := map[string]interface{}{
		"caddy_available": h.caddyMgr != nil,
		"ddns_running":    false,
	}

	if h.ddnsService != nil {
		status["ddns_running"] = h.ddnsService.IsRunning()
	}

	JSON(w, http.StatusOK, status)
}
