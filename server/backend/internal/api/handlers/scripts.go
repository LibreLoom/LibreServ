package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
)

type ScriptsHandler struct {
	manager *apps.Manager
}

func NewScriptsHandler(manager *apps.Manager) *ScriptsHandler {
	return &ScriptsHandler{
		manager: manager,
	}
}

type ListActionsResponse struct {
	InstanceID string              `json:"instance_id"`
	Actions    []apps.ScriptAction `json:"actions"`
}

func (h *ScriptsHandler) ListActions(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app instance. Please refresh and try again.")
		return
	}

	app, err := h.manager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that app. It may have been uninstalled.")
		return
	}

	catalog := h.manager.GetCatalog()
	appDef, err := catalog.GetApp(app.AppID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that app's definition. It may have been removed from the catalog.")
		return
	}

	// Build the actions list: custom actions + system destructive repair (if available).
	actions := make([]apps.ScriptAction, len(appDef.Scripts.Actions))
	copy(actions, appDef.Scripts.Actions)

	if appDef.Scripts.System.DestructiveRepair.Script != "" {
		scriptPath := h.manager.GetScriptExecutor().GetSystemScriptPath(appDef.CatalogPath, "destructiveRepair")
		if scriptPath != "" {
			desc := appDef.Scripts.System.DestructiveRepair.Description
			if desc == "" {
				desc = "Wipes all app data and starts fresh. This cannot be undone — use only if the app is broken beyond normal repair."
			}
			actions = append(actions, apps.ScriptAction{
				Name:        "destructive-repair",
				Label:       "Destructive Repair",
				Description: desc,
				Script:      appDef.Scripts.System.DestructiveRepair.Script,
				Icon:        "alert-octagon",
				Confirm: apps.ActionConfirm{
					Enabled:  true,
					Message:  desc,
					Typename: "destructive",
				},
				Execution: apps.ScriptExecution{
					Timeout:      120,
					StreamOutput: true,
				},
			})
		}
	}

	JSON(w, http.StatusOK, ListActionsResponse{
		InstanceID: instanceID,
		Actions:    actions,
	})
}

type GetActionResponse struct {
	Action apps.ScriptAction `json:"action"`
}

func (h *ScriptsHandler) GetAction(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	actionName := chi.URLParam(r, "actionName")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app instance. Please refresh and try again.")
		return
	}
	if actionName == "" {
		JSONError(w, http.StatusBadRequest, "Please choose which action to run.")
		return
	}

	app, err := h.manager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that app. It may have been uninstalled.")
		return
	}

	catalog := h.manager.GetCatalog()
	appDef, err := catalog.GetApp(app.AppID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that app's definition. It may have been removed from the catalog.")
		return
	}

	for _, action := range appDef.Scripts.Actions {
		if action.Name == actionName {
			JSON(w, http.StatusOK, GetActionResponse{Action: action})
			return
		}
	}

	// System action: destructive repair
	if actionName == "destructive-repair" && appDef.Scripts.System.DestructiveRepair.Script != "" {
		scriptPath := h.manager.GetScriptExecutor().GetSystemScriptPath(appDef.CatalogPath, "destructiveRepair")
		if scriptPath != "" {
			desc := appDef.Scripts.System.DestructiveRepair.Description
			if desc == "" {
				desc = "Wipes all app data and starts fresh. This cannot be undone — use only if the app is broken beyond normal repair."
			}
			JSON(w, http.StatusOK, GetActionResponse{Action: apps.ScriptAction{
				Name:        "destructive-repair",
				Label:       "Destructive Repair",
				Description: desc,
				Script:      appDef.Scripts.System.DestructiveRepair.Script,
				Icon:        "alert-octagon",
				Confirm: apps.ActionConfirm{
					Enabled:  true,
					Message:  desc,
					Typename: "destructive",
				},
				Execution: apps.ScriptExecution{
					Timeout:      120,
					StreamOutput: true,
				},
			}})
			return
		}
	}

	JSONError(w, http.StatusNotFound, "We couldn't find that action for this app.")
}

type ExecuteActionRequest struct {
	Action  string                 `json:"action"`
	Options map[string]interface{} `json:"options,omitempty"`
}

type ExecuteActionResponse struct {
	ExecutionID string             `json:"execution_id"`
	Duration    string             `json:"duration"`
	Result      *apps.ScriptResult `json:"result,omitempty"`
	StreamURL   string             `json:"stream_url,omitempty"`
}

func (h *ScriptsHandler) ExecuteAction(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app instance. Please refresh and try again.")
		return
	}

	var req ExecuteActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "We couldn't understand that request. Please check the format and try again.")
		return
	}

	if req.Action == "" {
		JSONError(w, http.StatusBadRequest, "Please choose which action to run.")
		return
	}

	app, err := h.manager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that app. It may have been uninstalled.")
		return
	}

	catalog := h.manager.GetCatalog()
	appDef, err := catalog.GetApp(app.AppID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that app's definition. It may have been removed from the catalog.")
		return
	}

	var scriptPath string
	for _, action := range appDef.Scripts.Actions {
		if action.Name == req.Action {
			scriptPath = action.Script
			break
		}
	}

	// System action: destructive repair
	if scriptPath == "" && req.Action == "destructive-repair" && appDef.Scripts.System.DestructiveRepair.Script != "" {
		scriptPath = appDef.Scripts.System.DestructiveRepair.Script
	}

	if scriptPath == "" {
		JSONError(w, http.StatusNotFound, "We couldn't find that action for this app.")
		return
	}

	fullScriptPath := app.Path + "/" + scriptPath

	executor := h.manager.GetScriptExecutor()
	if executor == nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't run scripts right now. Please try again later.")
		return
	}

	result, err := executor.Execute(r.Context(), instanceID, fullScriptPath, req.Options)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't run that script. Please try again.")
		return
	}

	response := ExecuteActionResponse{
		ExecutionID: instanceID + "-" + req.Action,
		Duration:    result.Duration.String(),
		Result:      result,
	}

	if action, _ := h.getAction(appDef, req.Action); action != nil && action.Execution.StreamOutput {
		response.StreamURL = "/api/v1/apps/" + instanceID + "/actions/" + req.Action + "/stream"
	}

	JSON(w, http.StatusOK, response)
}

func (h *ScriptsHandler) getAction(appDef *apps.AppDefinition, actionName string) (*apps.ScriptAction, error) {
	for i, action := range appDef.Scripts.Actions {
		if action.Name == actionName {
			return &appDef.Scripts.Actions[i], nil
		}
	}
	// System action: destructive repair (not stored in appDef.Scripts.Actions,
	// so return a synthetic action for stream_output checks).
	if actionName == "destructive-repair" && appDef.Scripts.System.DestructiveRepair.Script != "" {
		return &apps.ScriptAction{
			Name:   "destructive-repair",
			Script: appDef.Scripts.System.DestructiveRepair.Script,
			Execution: apps.ScriptExecution{
				StreamOutput: true,
			},
		}, nil
	}
	return nil, nil
}

type StreamActionRequest struct {
	Action  string                 `json:"action"`
	Options map[string]interface{} `json:"options,omitempty"`
}

func (h *ScriptsHandler) StreamAction(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	actionName := chi.URLParam(r, "actionName")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app instance. Please refresh and try again.")
		return
	}
	if actionName == "" {
		JSONError(w, http.StatusBadRequest, "Please choose which action to run.")
		return
	}

	app, err := h.manager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that app. It may have been uninstalled.")
		return
	}

	catalog := h.manager.GetCatalog()
	appDef, err := catalog.GetApp(app.AppID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "We couldn't find that app's definition. It may have been removed from the catalog.")
		return
	}

	var scriptPath string
	for _, action := range appDef.Scripts.Actions {
		if action.Name == actionName {
			scriptPath = action.Script
			break
		}
	}

	// System action: destructive repair
	if scriptPath == "" && actionName == "destructive-repair" && appDef.Scripts.System.DestructiveRepair.Script != "" {
		scriptPath = appDef.Scripts.System.DestructiveRepair.Script
	}

	if scriptPath == "" {
		JSONError(w, http.StatusNotFound, "We couldn't find that action for this app.")
		return
	}

	fullScriptPath := app.Path + "/" + scriptPath

	executor := h.manager.GetScriptExecutor()
	if executor == nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't run scripts right now. Please try again later.")
		return
	}

	// Parse options from query parameters (opt_name=value)
	var options map[string]interface{}
	if r.URL.RawQuery != "" {
		options = make(map[string]interface{})
		for key, values := range r.URL.Query() {
			if strings.HasPrefix(key, "opt_") {
				optName := strings.TrimPrefix(key, "opt_")
				if len(values) == 1 {
					options[optName] = values[0]
				} else {
					options[optName] = values
				}
			}
		}
	}

	stream, err := executor.StreamExecute(r.Context(), instanceID, fullScriptPath, options)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, "We couldn't run that script. Please try again.")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	for output := range stream {
		data, _ := json.Marshal(output)
		_, _ = w.Write([]byte("data: " + string(data) + "\n\n"))
	}
}

// StreamInstall handles SSE streaming of install progress for a specific instance.
func (h *ScriptsHandler) StreamInstall(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "We couldn't identify which app instance. Please refresh and try again.")
		return
	}

	outputCh := h.manager.GetInstaller().GetInstallOutputChannel(instanceID)
	if outputCh == nil {
		JSONError(w, http.StatusNotFound, "There's no active install for this app to attach to.")
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	for output := range outputCh {
		data, _ := json.Marshal(output)
		_, _ = w.Write([]byte("data: " + string(data) + "\n\n"))
	}
}
