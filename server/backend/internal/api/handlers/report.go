package handlers

import (
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

// ReportHandler serves the cached NetworkReport.
type ReportHandler struct {
	service *network.ReportService
}

func NewReportHandler(service *network.ReportService) *ReportHandler {
	return &ReportHandler{service: service}
}

// GetReport returns the latest network report (or 503 before the first tick).
func (h *ReportHandler) GetReport(w http.ResponseWriter, r *http.Request) {
	if h.service == nil {
		JSONError(w, http.StatusServiceUnavailable, "Network reporting is not available.")
		return
	}
	report := h.service.Report()
	if report == nil {
		// Report generation is async; if it failed, say why rather than 404.
		if err := h.service.LastError(); err != nil {
			JSONError(w, http.StatusServiceUnavailable, "We couldn't check your network right now. Please try again.")
			return
		}
		JSONError(w, http.StatusServiceUnavailable, "Network status is still being checked. Please try again.")
		return
	}
	JSON(w, http.StatusOK, report)
}