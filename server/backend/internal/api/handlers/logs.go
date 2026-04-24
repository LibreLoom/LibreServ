package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/moby/moby/api/pkg/stdcopy"
	"github.com/moby/moby/client"
	"gt.plainskill.net/LibreLoom/LibreServ/internal/docker"
)

type LogsHandler struct {
	dockerClient *docker.Client
}

func NewLogsHandler(dockerClient *docker.Client) *LogsHandler {
	return &LogsHandler{
		dockerClient: dockerClient,
	}
}

// sseWriter implements io.Writer and translates written bytes into SSE events
type sseWriter struct {
	w   http.ResponseWriter
	rc  *http.ResponseController
	typ string // "stdout" or "stderr"
}

func (sw *sseWriter) Write(p []byte) (n int, err error) {
	// A robust implementation would use a line scanner (like bufio.Scanner) to handle partial lines.
	// For simplicity, we split the incoming chunk on newlines.
	lines := strings.Split(string(p), "\n")

	for i, line := range lines {
		// Handle trailing newline from Split
		if i == len(lines)-1 && line == "" {
			continue
		}

		event := map[string]string{
			"type":    sw.typ,
			"content": line,
		}

		data, err := json.Marshal(event)
		if err != nil {
			continue
		}

		fmt.Fprintf(sw.w, "data: %s\n\n", data)
	}

	if sw.rc != nil {
		_ = sw.rc.Flush()
	}

	return len(p), nil
}

func (h *LogsHandler) StreamLogs(w http.ResponseWriter, r *http.Request) {
	// 1. Setup response controller for flushing (bypasses middleware wrappers)
	rc := http.NewResponseController(w)
	// Optionally extend timeouts for streaming
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	// 2. Set necessary headers for SSE
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

	// 3. Extract parameters
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		instanceID = r.URL.Query().Get("instanceId")
	}
	if instanceID == "" {
		instanceID = r.PathValue("instanceId")
	}
	if instanceID == "" {
		http.Error(w, "instanceId is required", http.StatusBadRequest)
		return
	}

	followParam := r.URL.Query().Get("follow")
	follow := followParam == "true" || followParam == "1"

	tail := r.URL.Query().Get("tail")
	if tail == "" {
		tail = "all"
	}

	// 4. Connect to Docker daemon to fetch/stream logs
	ctx := r.Context()
	opts := client.ContainerLogsOptions{
		ShowStdout: true,
		ShowStderr: true,
		Follow:     follow,
		Tail:       tail,
	}

	rawClient := h.dockerClient.GetRawClient()
	if rawClient == nil {
		http.Error(w, "Docker client is not available", http.StatusInternalServerError)
		return
	}

	containerID := instanceID
	isTTY := false

	// First try to find by libreserv.app label
	listResult, listErr := rawClient.ContainerList(ctx, client.ContainerListOptions{
		All:     true,
		Filters: make(client.Filters).Add("label", "libreserv.app="+instanceID),
	})

	// Fallback to docker compose project label
	if listErr != nil || len(listResult.Items) == 0 {
		listResult, listErr = rawClient.ContainerList(ctx, client.ContainerListOptions{
			All:     true,
			Filters: make(client.Filters).Add("label", "com.docker.compose.project="+instanceID),
		})
	}

	// Fallback to script_executor docker compose project name
	if listErr != nil || len(listResult.Items) == 0 {
		listResult, listErr = rawClient.ContainerList(ctx, client.ContainerListOptions{
			All:     true,
			Filters: make(client.Filters).Add("label", "com.docker.compose.project=libreserv-"+instanceID),
		})
	}

	// Final fallback: Match explicitly against the container name
	if listErr != nil || len(listResult.Items) == 0 {
		listResult, listErr = rawClient.ContainerList(ctx, client.ContainerListOptions{
			All:     true,
			Filters: make(client.Filters).Add("name", "^"+instanceID+"-"),
		})
	}

	if listErr == nil && len(listResult.Items) > 0 {
		containerID = listResult.Items[0].ID
	}

	cJSON, err := rawClient.ContainerInspect(ctx, containerID, client.ContainerInspectOptions{})
	if err == nil && cJSON.Container.Config != nil && cJSON.Container.Config.Tty {
		isTTY = true
	}

	logsResult, err := rawClient.ContainerLogs(ctx, containerID, opts)
	if err != nil {
		slog.Error("Failed to get container logs", "container_id", containerID, "error", err)
		errEvent := map[string]string{
			"type":    "stderr",
			"content": "Failed to get container logs",
		}
		data, _ := json.Marshal(errEvent)
		fmt.Fprintf(w, "data: %s\n\n", data)
		_ = rc.Flush()
		return
	}
	defer logsResult.Close()

	// 5. Multiplex stdout and stderr to SSE format
	outWriter := &sseWriter{w: w, rc: rc, typ: "stdout"}
	errWriter := &sseWriter{w: w, rc: rc, typ: "stderr"}

	if isTTY {
		_, err = io.Copy(outWriter, logsResult)
	} else {
		_, err = stdcopy.StdCopy(outWriter, errWriter, logsResult)
	}

	if err != nil && err != io.EOF {
		slog.Error("Log stream interrupted", "container_id", containerID, "error", err)
		errEvent := map[string]string{
			"type":    "stderr",
			"content": "stream interrupted",
		}
		data, _ := json.Marshal(errEvent)
		fmt.Fprintf(w, "data: %s\n\n", data)
		_ = rc.Flush()
	}
}
