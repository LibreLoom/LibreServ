package apps

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/moby/moby/api/pkg/stdcopy"
	"gt.plainskill.net/LibreLoom/Sol/internal/runtime"
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

type logEvent struct {
	Content string `json:"content"`
	Type    string `json:"type"`
}

func (sw *sseWriter) Write(p []byte) (n int, err error) {
	if len(p) > 0 {
		// A trailing newline ends the last line without adding an event.
		// Blank lines earlier in the chunk still produce events.
		text := strings.TrimSuffix(string(p), "\n")
		var frame bytes.Buffer
		encoder := json.NewEncoder(&frame)
		for line := range strings.SplitSeq(text, "\n") {
			frame.Reset()
			frame.WriteString("data: ")
			if err := encoder.Encode(logEvent{Content: line, Type: sw.typ}); err != nil {
				continue
			}
			frame.WriteByte('\n')
			_, _ = sw.w.Write(frame.Bytes())
		}
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

	query := r.URL.Query()
	instanceID := chi.URLParam(r, "instanceId")
	if instanceID == "" {
		instanceID = query.Get("instanceId")
	}
	if instanceID == "" {
		instanceID = r.PathValue("instanceId")
	}
	if instanceID == "" {
		http.Error(w, "instanceId is required", http.StatusBadRequest)
		return
	}

	followParam := query.Get("follow")
	follow := followParam == "true" || followParam == "1"

	tail := query.Get("tail")
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
