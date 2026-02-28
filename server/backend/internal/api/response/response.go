// Package response provides standardized API response utilities.
// This package is designed to be used by both handlers and middleware
// without causing circular dependencies.
package response

import (
	"encoding/json"
	"net/http"
	"strconv"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/errors"
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

// JSONErrorWithCode writes a JSON error response with error code
func JSONErrorWithCode(w http.ResponseWriter, status int, code, message string) {
	JSON(w, status, Response{
		Success: false,
		Error: &ErrorInfo{
			Code:    code,
			Message: message,
		},
	})
}

// JSONErrorFromAppError writes a JSON error response from an AppError
func JSONErrorFromAppError(w http.ResponseWriter, appErr *errors.AppError) {
	resp := Response{
		Success: false,
		Error: &ErrorInfo{
			Code:    string(appErr.Code),
			Message: appErr.Message,
		},
	}

	if len(appErr.Details) > 0 {
		resp.Error.Details = appErr.Details
	}

	JSON(w, appErr.StatusCode, resp)
}

// JSONSuccess writes a successful JSON response
func JSONSuccess(w http.ResponseWriter, data interface{}) {
	JSON(w, http.StatusOK, Response{
		Success: true,
		Data:    data,
	})
}

// JSONCreated writes a successful creation response
func JSONCreated(w http.ResponseWriter, data interface{}) {
	JSON(w, http.StatusCreated, Response{
		Success: true,
		Data:    data,
	})
}

// JSONNoContent writes a 204 No Content response
func JSONNoContent(w http.ResponseWriter) {
	w.WriteHeader(http.StatusNoContent)
}

// HandleError handles an error and writes appropriate response
func HandleError(w http.ResponseWriter, err error) {
	if appErr, ok := errors.IsAppError(err); ok {
		JSONErrorFromAppError(w, appErr)
		return
	}

	// Fall back to generic error
	JSONError(w, http.StatusInternalServerError, "An unexpected error occurred")
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

// BadRequest writes a bad request error response
func BadRequest(w http.ResponseWriter, message string) {
	JSONError(w, http.StatusBadRequest, message)
}

// NotFound writes a not found error response
func NotFound(w http.ResponseWriter, resourceType, identifier string) {
	JSON(w, http.StatusNotFound, Response{
		Success: false,
		Error: &ErrorInfo{
			Code:    "NOT_FOUND",
			Message: "The requested resource was not found",
			Details: map[string]interface{}{
				"resource_type": resourceType,
				"identifier":    identifier,
			},
		},
	})
}

// ValidationError writes a validation error response
func ValidationError(w http.ResponseWriter, field, message string) {
	JSON(w, http.StatusBadRequest, Response{
		Success: false,
		Error: &ErrorInfo{
			Code:    "VALIDATION_ERROR",
			Message: "Validation failed",
			Details: map[string]interface{}{
				"field":   field,
				"message": message,
			},
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

// ServerError writes an internal server error response
func ServerError(w http.ResponseWriter, message string) {
	if message == "" {
		message = "An unexpected error occurred"
	}
	JSONError(w, http.StatusInternalServerError, message)
}
