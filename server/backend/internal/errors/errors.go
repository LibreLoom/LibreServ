// Package errors provides domain-specific error types and codes for the LibreServ API.
// These errors provide structured information that can be used to generate consistent
// API responses and user-friendly error messages.
package errors

import (
	"fmt"
)

// ErrorCode represents a standardized error code for API responses
type ErrorCode string

const (
	// Authentication errors
	ErrCodeInvalidCredentials ErrorCode = "INVALID_CREDENTIALS"
	ErrCodeTokenExpired       ErrorCode = "TOKEN_EXPIRED"
	ErrCodeTokenRevoked       ErrorCode = "TOKEN_REVOKED"
	ErrCodeUnauthorized       ErrorCode = "UNAUTHORIZED"
	ErrCodeForbidden          ErrorCode = "FORBIDDEN"
	ErrCodeAccountLocked      ErrorCode = "ACCOUNT_LOCKED"

	// Validation errors
	ErrCodeValidation      ErrorCode = "VALIDATION_ERROR"
	ErrCodeInvalidInput    ErrorCode = "INVALID_INPUT"
	ErrCodeMissingField    ErrorCode = "MISSING_FIELD"
	ErrCodeInvalidFormat   ErrorCode = "INVALID_FORMAT"
	ErrCodeAlreadyExists   ErrorCode = "ALREADY_EXISTS"
	ErrCodeNotFound        ErrorCode = "NOT_FOUND"
	ErrCodeInvalidPassword ErrorCode = "INVALID_PASSWORD"

	// Resource errors
	ErrCodeResourceNotFound ErrorCode = "RESOURCE_NOT_FOUND"
	ErrCodeResourceExists   ErrorCode = "RESOURCE_EXISTS"
	ErrCodeResourceBusy     ErrorCode = "RESOURCE_BUSY"

	// Operation errors
	ErrCodeOperationFailed    ErrorCode = "OPERATION_FAILED"
	ErrCodeTimeout            ErrorCode = "TIMEOUT"
	ErrCodeCancelled          ErrorCode = "CANCELLED"
	ErrCodeConflict           ErrorCode = "CONFLICT"
	ErrCodeQuotaExceeded      ErrorCode = "QUOTA_EXCEEDED"
	ErrCodeRateLimited        ErrorCode = "RATE_LIMITED"
	ErrCodeNotImplemented     ErrorCode = "NOT_IMPLEMENTED"
	ErrCodeServiceUnavailable ErrorCode = "SERVICE_UNAVAILABLE"

	// Internal errors
	ErrCodeInternalError ErrorCode = "INTERNAL_ERROR"
	ErrCodeDatabaseError ErrorCode = "DATABASE_ERROR"
	ErrCodeConfigError   ErrorCode = "CONFIG_ERROR"
)

// ErrorCategory groups related error codes for client handling
type ErrorCategory string

const (
	CategoryAuth       ErrorCategory = "authentication"
	CategoryValidation ErrorCategory = "validation"
	CategoryResource   ErrorCategory = "resource"
	CategoryOperation  ErrorCategory = "operation"
	CategoryInternal   ErrorCategory = "internal"
)

// AppError represents a domain-specific error with code and metadata
type AppError struct {
	Code       ErrorCode              `json:"code"`
	Message    string                 `json:"message"`
	Category   ErrorCategory          `json:"category"`
	Details    map[string]interface{} `json:"details,omitempty"`
	StatusCode int                    `json:"-"` // HTTP status code (not serialized)
	Cause      error                  `json:"-"` // Wrapped error (not serialized)
}

// Error implements the error interface
func (e *AppError) Error() string {
	if e.Cause != nil {
		return fmt.Sprintf("%s: %s (caused by: %v)", e.Code, e.Message, e.Cause)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// Unwrap returns the wrapped error for error chain inspection
func (e *AppError) Unwrap() error {
	return e.Cause
}

// WithDetail adds a detail field to the error
func (e *AppError) WithDetail(key string, value interface{}) *AppError {
	if e.Details == nil {
		e.Details = make(map[string]interface{})
	}
	e.Details[key] = value
	return e
}

// WithCause wraps an underlying error
func (e *AppError) WithCause(err error) *AppError {
	e.Cause = err
	return e
}

// IsAppError checks if an error is an AppError
func IsAppError(err error) (*AppError, bool) {
	if err == nil {
		return nil, false
	}
	if appErr, ok := err.(*AppError); ok {
		return appErr, true
	}
	return nil, false
}

// Predefined errors for common scenarios
var (
	// Authentication errors
	ErrInvalidCredentials = New(ErrCodeInvalidCredentials, CategoryAuth, "The username or password you entered is incorrect", 401)
	ErrTokenExpired       = New(ErrCodeTokenExpired, CategoryAuth, "Your session has expired. Please log in again.", 401)
	ErrTokenRevoked       = New(ErrCodeTokenRevoked, CategoryAuth, "Your session has been revoked. Please log in again.", 401)
	ErrUnauthorized       = New(ErrCodeUnauthorized, CategoryAuth, "You must be logged in to perform this action", 401)
	ErrForbidden          = New(ErrCodeForbidden, CategoryAuth, "You don't have permission to perform this action", 403)
	ErrAccountLocked      = New(ErrCodeAccountLocked, CategoryAuth, "Your account is temporarily locked. Please try again later.", 429)

	// Validation errors
	ErrValidation      = New(ErrCodeValidation, CategoryValidation, "Please check your information and try again", 400)
	ErrInvalidInput    = New(ErrCodeInvalidInput, CategoryValidation, "The information you provided is not valid", 400)
	ErrMissingField    = New(ErrCodeMissingField, CategoryValidation, "Please fill in all required fields", 400)
	ErrInvalidFormat   = New(ErrCodeInvalidFormat, CategoryValidation, "The format of your input is not valid", 400)
	ErrAlreadyExists   = New(ErrCodeAlreadyExists, CategoryValidation, "This item already exists", 409)
	ErrNotFound        = New(ErrCodeNotFound, CategoryValidation, "The requested item was not found", 404)
	ErrInvalidPassword = New(ErrCodeInvalidPassword, CategoryValidation, "Password must be at least 12 characters with letters and numbers", 400)

	// Resource errors
	ErrResourceNotFound = New(ErrCodeResourceNotFound, CategoryResource, "The requested resource was not found", 404)
	ErrResourceExists   = New(ErrCodeResourceExists, CategoryResource, "This resource already exists", 409)
	ErrResourceBusy     = New(ErrCodeResourceBusy, CategoryResource, "This resource is currently busy. Please try again later.", 423)

	// Operation errors
	ErrOperationFailed    = New(ErrCodeOperationFailed, CategoryOperation, "Unable to complete the operation. Please try again.", 500)
	ErrTimeout            = New(ErrCodeTimeout, CategoryOperation, "The operation took too long to complete. Please try again.", 504)
	ErrCancelled          = New(ErrCodeCancelled, CategoryOperation, "The operation was cancelled", 499)
	ErrConflict           = New(ErrCodeConflict, CategoryOperation, "This action conflicts with the current state", 409)
	ErrQuotaExceeded      = New(ErrCodeQuotaExceeded, CategoryOperation, "You have exceeded your quota limit", 429)
	ErrRateLimited        = New(ErrCodeRateLimited, CategoryOperation, "Too many requests. Please wait a moment and try again.", 429)
	ErrNotImplemented     = New(ErrCodeNotImplemented, CategoryOperation, "This feature is not yet implemented", 501)
	ErrServiceUnavailable = New(ErrCodeServiceUnavailable, CategoryOperation, "Service temporarily unavailable. Please try again later.", 503)

	// Internal errors
	ErrInternalError = New(ErrCodeInternalError, CategoryInternal, "Something went wrong. Please try again later.", 500)
	ErrDatabaseError = New(ErrCodeDatabaseError, CategoryInternal, "Database error occurred. Please try again later.", 500)
	ErrConfigError   = New(ErrCodeConfigError, CategoryInternal, "Configuration error. Please contact support.", 500)
)

// New creates a new AppError
func New(code ErrorCode, category ErrorCategory, message string, statusCode int) *AppError {
	return &AppError{
		Code:       code,
		Message:    message,
		Category:   category,
		StatusCode: statusCode,
	}
}

// Wrap wraps a standard error into an AppError
func Wrap(err error, appErr *AppError) *AppError {
	return &AppError{
		Code:       appErr.Code,
		Message:    appErr.Message,
		Category:   appErr.Category,
		StatusCode: appErr.StatusCode,
		Cause:      err,
	}
}

// NewValidationError creates a validation error with field details
func NewValidationError(field, message string) *AppError {
	return ErrValidation.WithDetail("field", field).WithDetail("message", message)
}

// NewNotFoundError creates a not found error for a specific resource type
func NewNotFoundError(resourceType, identifier string) *AppError {
	return ErrResourceNotFound.WithDetail("resource_type", resourceType).WithDetail("identifier", identifier)
}
