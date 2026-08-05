package handlers

import (
	"net/http"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/network"
)

// PlansHandler computes per-app exposure plans from the latest report.
type PlansHandler struct {
	report *network.ReportService
	apps   *apps.Manager
	upnp   *network.UPnPClient
	state  *network.PathStateStore
	engine *network.Engine
}

func NewPlansHandler(
	report *network.ReportService,
	apps *apps.Manager,
	state *network.PathStateStore,
) *PlansHandler {
	h := &PlansHandler{
		report: report,
		apps:   apps,
		state:  state,
		upnp:   network.NewUPnPClient(nil),
	}
	h.engine = network.NewEngine(h.upnp)
	return h
}

// planResult is the per-app plan serialized for the UI.
type planResult struct {
	AppID       string                             `json:"app_id"`
	AppName     string                             `json:"app_name"`
	Path        network.Path                       `json:"path"`
	Message     string                             `json:"message"`
	Steps       []string                           `json:"steps,omitempty"`
	CoverageV4  bool                               `json:"coverage_v4"`
	CoverageV6  bool                               `json:"coverage_v6"`
	AddonNeeded bool                               `json:"addon_needed"`
	Ports       []int                              `json:"ports,omitempty"`
	State       map[network.Path]network.PathState `json:"-"`
}

// GetPlans returns plans for all installed apps that declare Access needs.
func (h *PlansHandler) GetPlans(w http.ResponseWriter, r *http.Request) {
	if h.report == nil {
		JSONError(w, http.StatusServiceUnavailable, "Network reporting is not available.")
		return
	}
	rep := h.report.Report()
	if rep == nil {
		JSONError(w, http.StatusServiceUnavailable, "Network status is still being checked. Please try again.")
		return
	}

	installed, err := h.apps.ListInstalledApps(r.Context())
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't read your installed apps.")
		return
	}
	out := make([]planResult, 0, len(installed))
	for _, app := range installed {
		// Resolve the catalog Access requirements for this app.
		catalogApp, err := h.apps.GetCatalog().GetApp(app.AppID)
		if err != nil {
			continue // not a catalog app; no network plan
		}
		acc := catalogApp.ResolveAccess()
		req := acc.ToNetworkRequirement()

		var state map[network.Path]network.PathState
		if h.state != nil {
			if st, err := h.state.StateForApp(r.Context(), app.ID); err == nil {
				state = st
			}
		}

		plan := h.engine.Plan(req, rep, state)
		out = append(out, planResult{
			AppID:       app.ID,
			AppName:     app.Name,
			Path:        plan.Path,
			Message:     plan.Message,
			Steps:       plan.Steps,
			CoverageV4:  plan.CoverageV4,
			CoverageV6:  plan.CoverageV6,
			AddonNeeded: plan.AddonNeeded,
			Ports:       plan.Ports,
		})
	}

	JSON(w, http.StatusOK, map[string]any{"plans": out})
}
