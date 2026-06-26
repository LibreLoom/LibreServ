package handlers

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"strconv"
	"strings"

	"github.com/go-chi/chi/v5"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/apps"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/config"
)

type ReposHandler struct {
	manager *apps.Manager
	config  *config.Config
}

func NewReposHandler(manager *apps.Manager, cfg *config.Config) *ReposHandler {
	return &ReposHandler{
		manager: manager,
		config:  cfg,
	}
}

func (h *ReposHandler) PullRepos(w http.ResponseWriter, r *http.Request) {
	if err := h.manager.ForcePullRepos(r.Context()); err != nil {
		slog.Error("Failed to pull repos", "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't refresh the app catalog. Please try again.")
		return
	}

	catalog := h.manager.GetCatalog()
	JSON(w, http.StatusOK, map[string]interface{}{
		"message": "repositories pulled",
		"count":   catalog.Count(),
	})
}

func (h *ReposHandler) GetReposStatus(w http.ResponseWriter, r *http.Request) {
	statuses := h.manager.GetRepoStatus()
	if statuses == nil {
		statuses = []apps.RepoStatus{}
	}

	JSON(w, http.StatusOK, statuses)
}

type AddRepoRequest struct {
	URL      string `json:"url"`
	Branch   string `json:"branch"`
	Priority int    `json:"priority"`
}

func (h *ReposHandler) AddRepo(w http.ResponseWriter, r *http.Request) {
	var req AddRepoRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		JSONError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	if req.URL == "" {
		JSONError(w, http.StatusBadRequest, "url is required")
		return
	}
	req.URL = strings.TrimSpace(req.URL)
	if !strings.HasPrefix(req.URL, "https://") && !strings.HasPrefix(req.URL, "http://") {
		JSONError(w, http.StatusBadRequest, "url must start with http:// or https://")
		return
	}
	if req.Branch == "" {
		req.Branch = "main"
	}

	repos := h.config.Apps.Repos
	for _, existing := range repos {
		if existing.URL == req.URL {
			JSONError(w, http.StatusConflict, "repository already exists")
			return
		}
	}

	newRepo := config.RepoConfig{
		URL:      req.URL,
		Branch:   req.Branch,
		Enabled:  true,
		Priority: req.Priority,
	}

	h.config.Apps.Repos = append(h.config.Apps.Repos, newRepo)

	if err := config.SaveConfig(""); err != nil {
		slog.Error("Failed to save config after adding repo", "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't save the repository settings. Please try again.")
		return
	}

	JSON(w, http.StatusCreated, map[string]interface{}{
		"message":          "repository added",
		"url":              req.URL,
		"restart_required": true,
	})
}

func (h *ReposHandler) RemoveRepo(w http.ResponseWriter, r *http.Request) {
	indexStr := chi.URLParam(r, "index")
	index, err := strconv.Atoi(indexStr)
	if err != nil || index < 0 {
		JSONError(w, http.StatusBadRequest, "invalid repository index")
		return
	}

	repos := h.config.Apps.Repos
	if index >= len(repos) {
		JSONError(w, http.StatusNotFound, "repository not found")
		return
	}

	removed := repos[index]
	h.config.Apps.Repos = append(repos[:index], repos[index+1:]...)

	if err := config.SaveConfig(""); err != nil {
		slog.Error("Failed to save config after removing repo", "error", err)
		JSONError(w, http.StatusInternalServerError, "We couldn't save the repository settings. Please try again.")
		return
	}

	JSON(w, http.StatusOK, map[string]interface{}{
		"message":          "repository removed",
		"url":              removed.URL,
		"restart_required": true,
	})
}
