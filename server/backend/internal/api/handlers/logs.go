package handlers

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/api/types/filters"
	"github.com/docker/docker/pkg/stdcopy"
	"github.com/go-chi/chi/v5"
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
	instanceId := chi.URLParam(r, "instanceId")
	if instanceId == "" {
		instanceId = r.URL.Query().Get("instanceId")
	}
	if instanceId == "" {
		instanceId = r.PathValue("instanceId")
	}
	if instanceId == "" {
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
	opts := container.LogsOptions{
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

	containerID := instanceId
	isTTY := false

	// First try to find by libreserv.app label
	containers, listErr := rawClient.ContainerList(ctx, container.ListOptions{
		All:     true,
		Filters: filters.NewArgs(filters.Arg("label", "libreserv.app="+instanceId)),
	})

	// Fallback to docker compose project label
	if listErr != nil || len(containers) == 0 {
		containers, listErr = rawClient.ContainerList(ctx, container.ListOptions{
			All:     true,
			Filters: filters.NewArgs(filters.Arg("label", "com.docker.compose.project="+instanceId)),
		})
	}

	// Fallback to script_executor docker compose project name
	if listErr != nil || len(containers) == 0 {
		containers, listErr = rawClient.ContainerList(ctx, container.ListOptions{
			All:     true,
			Filters: filters.NewArgs(filters.Arg("label", "com.docker.compose.project=libreserv-"+instanceId)),
		})
	}

	// Final fallback: Match explicitly against the container name
	if listErr != nil || len(containers) == 0 {
		containers, listErr = rawClient.ContainerList(ctx, container.ListOptions{
			All:     true,
			Filters: filters.NewArgs(filters.Arg("name", "^"+instanceId+"-")),
		})
	}

	if listErr == nil && len(containers) > 0 {
		containerID = containers[0].ID
	}

	cJSON, err := rawClient.ContainerInspect(ctx, containerID)
	if err == nil && cJSON.Config != nil && cJSON.Config.Tty {
		isTTY = true
	}

	logsReader, err := rawClient.ContainerLogs(ctx, containerID, opts)
	if err != nil {
		errEvent := map[string]string{
			"type":    "stderr",
			"content": fmt.Sprintf("Failed to get container logs: %v", err),
		}
		data, _ := json.Marshal(errEvent)
		fmt.Fprintf(w, "data: %s\n\n", data)
		_ = rc.Flush()
		return
	}
	defer logsReader.Close()

	// 5. Multiplex stdout and stderr to SSE format
	outWriter := &sseWriter{w: w, rc: rc, typ: "stdout"}
	errWriter := &sseWriter{w: w, rc: rc, typ: "stderr"}

	if isTTY {
		// If TTY is enabled, there is no multiplexing header
		_, err = io.Copy(outWriter, logsReader)
	} else {
		// Docker log streams for containers without a TTY are multiplexed using a custom header.
		// stdcopy.StdCopy decodes this multiplexed stream and directs payloads to the respective writers.
		_, err = stdcopy.StdCopy(outWriter, errWriter, logsReader)
	}

	if err != nil && err != io.EOF {
		// If an error happens midway, try to inform the client
		errEvent := map[string]string{
			"type":    "stderr",
			"content": fmt.Sprintf("stream interrupted: %v", err),
		}
		data, _ := json.Marshal(errEvent)
		fmt.Fprintf(w, "data: %s\n\n", data)
		_ = rc.Flush()
	}
}
