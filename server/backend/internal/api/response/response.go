// Package response provides standardized API response utilities.
// This package is designed to be used by both handlers and middleware
// without causing circular dependencies.
package response

import (
	"encoding/json"
	"net/http"
	"strconv"
)

// Response represents a standardized API response
type Response struct {
	Success bool        `json:"success"`
	Data    interface{} `json:"data,omitempty"`
	Error   *ErrorInfo  `json:"error,omitempty"`
	Meta    *MetaInfo   `json:"meta,omitempty"`
}

// ErrorInfo represents error details in API responses
type ErrorInfo struct {
	Code    string                 `json:"code"`
	Message string                 `json:"message"`
	Details map[string]interface{} `json:"details,omitempty"`
}

// MetaInfo represents metadata in API responses (pagination, etc.)
type MetaInfo struct {
	Page       int   `json:"page,omitempty"`
	PageSize   int   `json:"page_size,omitempty"`
	TotalItems int64 `json:"total_items,omitempty"`
	TotalPages int   `json:"total_pages,omitempty"`
}

// JSON writes a JSON response with the given status code
func JSON(w http.ResponseWriter, status int, data interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	json.NewEncoder(w).Encode(data)
}

// JSONError writes a JSON error response
func JSONError(w http.ResponseWriter, status int, message string) {
	JSON(w, status, map[string]string{"error": message})
}

// JSONCreated writes a successful creation response
func JSONCreated(w http.ResponseWriter, data interface{}) {
	JSON(w, http.StatusCreated, Response{
		Success: true,
		Data:    data,
	})
}

// Unauthorized writes an unauthorized error response
func Unauthorized(w http.ResponseWriter, message string) {
	if message == "" {
		message = "You must be logged in to perform this action"
	}
	JSON(w, http.StatusUnauthorized, Response{
		Success: false,
		Error: &ErrorInfo{
			Code:    "UNAUTHORIZED",
			Message: message,
		},
	})
}

// Forbidden writes a forbidden error response
func Forbidden(w http.ResponseWriter, message string) {
	if message == "" {
		message = "You don't have permission to perform this action"
	}
	JSON(w, http.StatusForbidden, Response{
		Success: false,
		Error: &ErrorInfo{
			Code:    "FORBIDDEN",
			Message: message,
		},
	})
}

// RateLimitExceeded writes a rate limit error response
func RateLimitExceeded(w http.ResponseWriter, retryAfter int) {
	w.Header().Set("Retry-After", strconv.Itoa(retryAfter))
	JSON(w, http.StatusTooManyRequests, Response{
		Success: false,
		Error: &ErrorInfo{
			Code:    "RATE_LIMITED",
			Message: "Too many requests. Please try again later.",
			Details: map[string]interface{}{
				"retry_after": retryAfter,
			},
		},
	})
}
