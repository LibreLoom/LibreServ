package middleware

import (
	"log/slog"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5/middleware"
)

// Logger returns a middleware that logs HTTP requests using slog
func Logger(logger *slog.Logger) func(next http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			start := time.Now()

			// Wrap response writer to capture status code
			ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)

			defer func() {
				status := ww.Status()
				if status == 0 {
					status = http.StatusOK
				}

				// Log level based on status code
				logLevel := slog.LevelInfo
				if status >= 500 {
					logLevel = slog.LevelError
				} else if status >= 400 {
					logLevel = slog.LevelWarn
				}

				ctx := r.Context()
				if !logger.Enabled(ctx, logLevel) {
					return
				}
				logger.LogAttrs(ctx, logLevel, "HTTP request",
					slog.String("method", r.Method),
					slog.String("path", r.URL.Path),
					slog.Int("status", status),
					slog.Int64("duration_ms", time.Since(start).Milliseconds()),
					slog.Int("bytes", ww.BytesWritten()),
					slog.String("remote_addr", r.RemoteAddr),
					slog.String("request_id", middleware.GetReqID(ctx)),
				)
			}()

			next.ServeHTTP(ww, r)
		})
	}
}
