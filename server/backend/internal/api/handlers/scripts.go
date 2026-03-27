package handlers

import (
	"encoding/json"
	"net/http"

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
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}

	app, err := h.manager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		JSONError(w, http.StatusNotFound, err.Error())
		return
	}

	catalog := h.manager.GetCatalog()
	appDef, err := catalog.GetApp(app.AppID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "app definition not found")
		return
	}

	JSON(w, http.StatusOK, ListActionsResponse{
		InstanceID: instanceID,
		Actions:    appDef.Scripts.Actions,
	})
}

type GetActionResponse struct {
	Action apps.ScriptAction `json:"action"`
}

func (h *ScriptsHandler) GetAction(w http.ResponseWriter, r *http.Request) {
	instanceID := chi.URLParam(r, "instanceId")
	actionName := chi.URLParam(r, "actionName")
	if instanceID == "" {
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}
	if actionName == "" {
		JSONError(w, http.StatusBadRequest, "action name is required")
		return
	}

	app, err := h.manager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		JSONError(w, http.StatusNotFound, err.Error())
		return
	}

	catalog := h.manager.GetCatalog()
	appDef, err := catalog.GetApp(app.AppID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "app definition not found")
		return
	}

	for _, action := range appDef.Scripts.Actions {
		if action.Name == actionName {
			JSON(w, http.StatusOK, GetActionResponse{Action: action})
			return
		}
	}

	JSONError(w, http.StatusNotFound, "action not found")
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
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}

	var req ExecuteActionRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.Action == "" {
		JSONError(w, http.StatusBadRequest, "action is required")
		return
	}

	app, err := h.manager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		JSONError(w, http.StatusNotFound, err.Error())
		return
	}

	catalog := h.manager.GetCatalog()
	appDef, err := catalog.GetApp(app.AppID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "app definition not found")
		return
	}

	var scriptPath string
	for _, action := range appDef.Scripts.Actions {
		if action.Name == req.Action {
			scriptPath = action.Script
			break
		}
	}

	if scriptPath == "" {
		JSONError(w, http.StatusNotFound, "action not found")
		return
	}

	fullScriptPath := app.Path + "/" + scriptPath

	executor := h.manager.GetScriptExecutor()
	if executor == nil {
		JSONError(w, http.StatusInternalServerError, "script executor not available")
		return
	}

	result, err := executor.Execute(r.Context(), instanceID, fullScriptPath, req.Options)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
		return
	}

	response := ExecuteActionResponse{
		ExecutionID: instanceID + "-" + req.Action,
		Duration:    result.Duration.String(),
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
		JSONError(w, http.StatusBadRequest, "instance ID is required")
		return
	}
	if actionName == "" {
		JSONError(w, http.StatusBadRequest, "action name is required")
		return
	}

	app, err := h.manager.GetInstalledApp(r.Context(), instanceID)
	if err != nil {
		JSONError(w, http.StatusNotFound, err.Error())
		return
	}

	catalog := h.manager.GetCatalog()
	appDef, err := catalog.GetApp(app.AppID)
	if err != nil {
		JSONError(w, http.StatusNotFound, "app definition not found")
		return
	}

	var scriptPath string
	for _, action := range appDef.Scripts.Actions {
		if action.Name == actionName {
			scriptPath = action.Script
			break
		}
	}

	if scriptPath == "" {
		JSONError(w, http.StatusNotFound, "action not found")
		return
	}

	fullScriptPath := app.Path + "/" + scriptPath

	executor := h.manager.GetScriptExecutor()
	if executor == nil {
		JSONError(w, http.StatusInternalServerError, "script executor not available")
		return
	}

	stream, err := executor.StreamExecute(r.Context(), instanceID, fullScriptPath, nil)
	if err != nil {
		JSONError(w, http.StatusInternalServerError, err.Error())
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
