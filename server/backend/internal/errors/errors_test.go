package errors

import (
	"fmt"
	"testing"
)

func TestNewError(t *testing.T) {
	err := New(
		ErrCodeInvalidCredentials,
		CategoryAuth,
		"Wrong password",
		401,
	)

	if err.Code != ErrCodeInvalidCredentials {
		t.Errorf("expected code %s, got %s", ErrCodeInvalidCredentials, err.Code)
	}
	if err.Category != CategoryAuth {
		t.Errorf("expected category %s, got %s", CategoryAuth, err.Category)
	}
	if err.Message != "Wrong password" {
		t.Errorf("expected message 'Wrong password', got '%s'", err.Message)
	}
	if err.StatusCode != 401 {
		t.Errorf("expected status code 401, got %d", err.StatusCode)
	}
}

func TestError_Method(t *testing.T) {
	err := New(ErrCodeNotFound, CategoryResource, "Not found", 404)

	errStr := err.Error()
	if errStr == "" {
		t.Error("expected error message to not be empty")
	}
	if !contains(errStr, "NOT_FOUND") {
		t.Error("expected error code in error message")
	}
	if !contains(errStr, "Not found") {
		t.Error("expected error message in error message")
	}
}

func TestUnwrap_ReturnsCause(t *testing.T) {
	underlying := fmt.Errorf("network timeout")
	err := New(ErrCodeOperationFailed, CategoryOperation, "Failed", 500).
		WithCause(underlying)

	unwrapped := err.Unwrap()
	if unwrapped != underlying {
		t.Errorf("expected unwrapped error to be %v, got %v", underlying, unwrapped)
	}
}

func TestWithDetail_AddsField(t *testing.T) {
	err := New(ErrCodeResourceNotFound, CategoryResource, "Not found", 404).
		WithDetail("resource_type", "User").
		WithDetail("identifier", "123")

	if err.Details == nil {
		t.Fatal("expected details to be initialized")
	}

	if err.Details["resource_type"] != "User" {
		t.Errorf("expected resource_type 'User', got '%v'", err.Details["resource_type"])
	}
	if err.Details["identifier"] != "123" {
		t.Errorf("expected identifier '123', got '%v'", err.Details["identifier"])
	}
	if len(err.Details) != 2 {
		t.Errorf("expected 2 details, got %d", len(err.Details))
	}
}

func TestWithCause_WrapsError(t *testing.T) {
	underlying := fmt.Errorf("database connection failed")
	err := New(ErrCodeDatabaseError, CategoryInternal, "DB failed", 500).
		WithCause(underlying)

	if err.Cause == nil {
		t.Fatal("expected cause to be set")
	}
	if err.Cause != underlying {
		t.Errorf("expected cause to be %v, got %v", underlying, err.Cause)
	}
}

func TestIsAppError_Valid(t *testing.T) {
	appErr := ErrInvalidCredentials
	isErr, ok := IsAppError(appErr)

	if !ok {
		t.Error("expected IsAppError to return true for AppError")
	}
	if isErr == nil {
		t.Fatal("expected non-nil AppError")
	}
	if isErr.Code != ErrCodeInvalidCredentials {
		t.Errorf("expected code %s, got %s", ErrCodeInvalidCredentials, isErr.Code)
	}
}

func TestIsAppError_Invalid(t *testing.T) {
	genericErr := fmt.Errorf("generic error")
	isErr, ok := IsAppError(genericErr)

	if ok {
		t.Error("expected IsAppError to return false for non-AppError")
	}
	if isErr != nil {
		t.Error("expected nil for non-AppError")
	}
}

func TestIsAppError_Nil(t *testing.T) {
	isErr, ok := IsAppError(nil)

	if ok {
		t.Error("expected IsAppError to return false for nil")
	}
	if isErr != nil {
		t.Error("expected nil for nil error")
	}
}

func TestNewValidationError(t *testing.T) {
	err := NewValidationError("email", "invalid format")

	if err.Code != ErrCodeValidation {
		t.Errorf("expected code %s, got %s", ErrCodeValidation, err.Code)
	}
	if err.Category != CategoryValidation {
		t.Errorf("expected category %s, got %s", CategoryValidation, err.Category)
	}
	if err.Details == nil {
		t.Fatal("expected details to be initialized")
	}
	if err.Details["field"] != "email" {
		t.Errorf("expected field 'email', got '%v'", err.Details["field"])
	}
	if err.Details["message"] != "invalid format" {
		t.Errorf("expected message 'invalid format', got '%v'", err.Details["message"])
	}
}

func TestNewNotFoundError(t *testing.T) {
	err := NewNotFoundError("User", "alice")

	if err.Code != ErrCodeResourceNotFound {
		t.Errorf("expected code %s, got %s", ErrCodeResourceNotFound, err.Code)
	}
	if err.Category != CategoryResource {
		t.Errorf("expected category %s, got %s", CategoryResource, err.Category)
	}
	if err.Details == nil {
		t.Fatal("expected details to be initialized")
	}
	if err.Details["resource_type"] != "User" {
		t.Errorf("expected resource_type 'User', got '%v'", err.Details["resource_type"])
	}
	if err.Details["identifier"] != "alice" {
		t.Errorf("expected identifier 'alice', got '%v'", err.Details["identifier"])
	}
}

func TestPredefinedErrors(t *testing.T) {
	tests := []struct {
		err    *AppError
		code   ErrorCode
		status int
	}{
		{ErrInvalidCredentials, ErrCodeInvalidCredentials, 401},
		{ErrTokenExpired, ErrCodeTokenExpired, 401},
		{ErrTokenRevoked, ErrCodeTokenRevoked, 401},
		{ErrUnauthorized, ErrCodeUnauthorized, 401},
		{ErrForbidden, ErrCodeForbidden, 403},
		{ErrAccountLocked, ErrCodeAccountLocked, 429},
		{ErrValidation, ErrCodeValidation, 400},
		{ErrInvalidInput, ErrCodeInvalidInput, 400},
		{ErrMissingField, ErrCodeMissingField, 400},
		{ErrInvalidFormat, ErrCodeInvalidFormat, 400},
		{ErrAlreadyExists, ErrCodeAlreadyExists, 409},
		{ErrNotFound, ErrCodeNotFound, 404},
		{ErrInvalidPassword, ErrCodeInvalidPassword, 400},
		{ErrResourceNotFound, ErrCodeResourceNotFound, 404},
		{ErrResourceExists, ErrCodeResourceExists, 409},
		{ErrResourceBusy, ErrCodeResourceBusy, 423},
		{ErrOperationFailed, ErrCodeOperationFailed, 500},
		{ErrTimeout, ErrCodeTimeout, 504},
		{ErrCancelled, ErrCodeCancelled, 499},
		{ErrConflict, ErrCodeConflict, 409},
		{ErrQuotaExceeded, ErrCodeQuotaExceeded, 429},
		{ErrRateLimited, ErrCodeRateLimited, 429},
		{ErrNotImplemented, ErrCodeNotImplemented, 501},
		{ErrServiceUnavailable, ErrCodeServiceUnavailable, 503},
		{ErrInternalError, ErrCodeInternalError, 500},
		{ErrDatabaseError, ErrCodeDatabaseError, 500},
		{ErrConfigError, ErrCodeConfigError, 500},
	}

	for _, tt := range tests {
		if tt.err.Code != tt.code {
			t.Errorf("error %s: expected code %s, got %s", tt.err.Message, tt.code, tt.err.Code)
		}
		if tt.err.StatusCode != tt.status {
			t.Errorf("error %s: expected status %d, got %d", tt.err.Message, tt.status, tt.err.StatusCode)
		}
	}
}

func TestWrap_WrapsAppError(t *testing.T) {
	underlying := fmt.Errorf("underlying error")
	original := New(ErrCodeNotFound, CategoryResource, "Not found", 404)
	wrapped := Wrap(underlying, original)

	if wrapped.Code != original.Code {
		t.Errorf("expected code %s, got %s", original.Code, wrapped.Code)
	}
	if wrapped.Message != original.Message {
		t.Errorf("expected message '%s', got '%s'", original.Message, wrapped.Message)
	}
	if wrapped.Cause != underlying {
		t.Errorf("expected cause %v, got %v", underlying, wrapped.Cause)
	}
}

// Helper function to check if a string contains a substring
func contains(s, substr string) bool {
	return len(s) >= len(substr) && (s == substr || len(s) > len(substr) &&
		(s[:len(substr)] == substr || s[len(s)-len(substr):] == substr ||
			containsMiddle(s, substr)))
}

func containsMiddle(s, substr string) bool {
	for i := 0; i <= len(s)-len(substr); i++ {
		if s[i:i+len(substr)] == substr {
			return true
		}
	}
	return false
}
