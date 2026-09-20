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
	"gt.plainskill.net/LibreLoom/LibreServ/internal/runtime"
)

type LogsHandler struct {
	runtime runtime.ContainerRuntime
}

func NewLogsHandler(rt runtime.ContainerRuntime) *LogsHandler {
	return &LogsHandler{
		runtime: rt,
	}
}

type sseWriter struct {
	w   http.ResponseWriter
	rc  *http.ResponseController
	typ string
}

func (sw *sseWriter) Write(p []byte) (n int, err error) {
	lines := strings.Split(string(p), "\n")

	for i, line := range lines {
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
	rc := http.NewResponseController(w)
	_ = rc.SetReadDeadline(time.Time{})
	_ = rc.SetWriteDeadline(time.Time{})

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")

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

	ctx := r.Context()

	containers, err := h.runtime.FindContainersByInstanceID(ctx, instanceID)
	if err != nil || len(containers) == 0 {
		http.Error(w, "Container not found", http.StatusNotFound)
		return
	}

	target := containers[0]

	inspect, err := h.runtime.InspectContainer(ctx, target.ID)
	if err != nil {
		slog.Warn("Failed to inspect container, assuming non-TTY", "container_id", target.ID, "error", err)
	}
	isTTY := inspect != nil && inspect.TTY

	logsReader, err := h.runtime.ContainerLogs(ctx, target.ID, runtime.LogOptions{
		Follow: follow,
		Tail:   tail,
	})
	if err != nil {
		slog.Error("Failed to get container logs", "container_id", target.ID, "error", err)
		errEvent := map[string]string{
			"type":    "stderr",
			"content": "Failed to get container logs",
		}
		data, _ := json.Marshal(errEvent)
		fmt.Fprintf(w, "data: %s\n\n", data)
		_ = rc.Flush()
		return
	}
	defer logsReader.Close()

	outWriter := &sseWriter{w: w, rc: rc, typ: "stdout"}
	errWriter := &sseWriter{w: w, rc: rc, typ: "stderr"}

	if isTTY {
		_, err = io.Copy(outWriter, logsReader)
	} else {
		_, err = stdcopy.StdCopy(outWriter, errWriter, logsReader)
	}

	if err != nil && err != io.EOF {
		slog.Error("Log stream interrupted", "container_id", target.ID, "error", err)
		errEvent := map[string]string{
			"type":    "stderr",
			"content": "stream interrupted",
		}
		data, _ := json.Marshal(errEvent)
		fmt.Fprintf(w, "data: %s\n\n", data)
		_ = rc.Flush()
	}
}
