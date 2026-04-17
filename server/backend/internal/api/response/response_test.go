package response

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/errors"
)

type User struct {
	ID       string `json:"id"`
	Username string `json:"username"`
}

func TestJSON_Success(t *testing.T) {
	w := httptest.NewRecorder()

	data := map[string]string{"message": "success"}
	JSON(w, http.StatusOK, data)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	contentType := w.Header().Get("Content-Type")
	if contentType != "application/json" {
		t.Errorf("expected content type application/json, got %s", contentType)
	}

	var result map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if result["message"] != "success" {
		t.Errorf("expected message 'success', got '%s'", result["message"])
	}
}

func TestJSONError_Generic(t *testing.T) {
	w := httptest.NewRecorder()
	JSONError(w, http.StatusBadRequest, "invalid input")

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}

	var result map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if result["error"] != "invalid input" {
		t.Errorf("expected error message 'invalid input', got '%s'", result["error"])
	}
}

func TestJSONErrorWithCode(t *testing.T) {
	w := httptest.NewRecorder()
	JSONErrorWithCode(w, http.StatusUnauthorized, "UNAUTHORIZED", "not logged in")

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
	}

	var resp Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Success {
		t.Error("expected success to be false")
	}

	if resp.Error.Code != "UNAUTHORIZED" {
		t.Errorf("expected code 'UNAUTHORIZED', got '%s'", resp.Error.Code)
	}

	if resp.Error.Message != "not logged in" {
		t.Errorf("expected message 'not logged in', got '%s'", resp.Error.Message)
	}
}

func TestJSONErrorFromAppError(t *testing.T) {
	w := httptest.NewRecorder()
	appErr := errors.New(
		errors.ErrCodeResourceNotFound,
		errors.CategoryResource,
		"User not found",
		404,
	)
	JSONErrorFromAppError(w, appErr)

	if w.Code != http.StatusNotFound {
		t.Errorf("expected status %d, got %d", http.StatusNotFound, w.Code)
	}

	var resp Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Success {
		t.Error("expected success to be false")
	}

	if resp.Error.Code != "RESOURCE_NOT_FOUND" {
		t.Errorf("expected code 'RESOURCE_NOT_FOUND', got '%s'", resp.Error.Code)
	}

	if resp.Error.Message != "User not found" {
		t.Errorf("expected message 'User not found', got '%s'", resp.Error.Message)
	}
}

func TestJSONSuccess(t *testing.T) {
	w := httptest.NewRecorder()
	data := User{ID: "1", Username: "alice"}
	JSONSuccess(w, data)

	if w.Code != http.StatusOK {
		t.Errorf("expected status %d, got %d", http.StatusOK, w.Code)
	}

	var resp Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if !resp.Success {
		t.Error("expected success to be true")
	}

	if resp.Data == nil {
		t.Fatal("expected data to be set")
	}

	var user User
	// resp.Data contains the actual struct that was JSON-encoded
	userData, err := json.Marshal(resp.Data)
	if err != nil {
		t.Fatalf("failed to marshal data: %v", err)
	}

	if err := json.Unmarshal(userData, &user); err != nil {
		t.Fatalf("failed to unmarshal data: %v", err)
	}

	if user.ID != "1" {
		t.Errorf("expected ID '1', got '%s'", user.ID)
	}
}

func TestJSONCreated(t *testing.T) {
	w := httptest.NewRecorder()
	data := User{ID: "2", Username: "bob"}
	JSONCreated(w, data)

	if w.Code != http.StatusCreated {
		t.Errorf("expected status %d, got %d", http.StatusCreated, w.Code)
	}

	var resp Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if !resp.Success {
		t.Error("expected success to be true")
	}

	if resp.Data == nil {
		t.Fatal("expected data to be set")
	}
}

func TestJSONNoContent(t *testing.T) {
	w := httptest.NewRecorder()
	JSONNoContent(w)

	if w.Code != http.StatusNoContent {
		t.Errorf("expected status %d, got %d", http.StatusNoContent, w.Code)
	}

	if w.Body.Len() != 0 {
		t.Errorf("expected body to be empty, got length %d", w.Body.Len())
	}
}

func TestHandleError_AppError(t *testing.T) {
	w := httptest.NewRecorder()
	appErr := errors.ErrInvalidCredentials
	HandleError(w, appErr)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
	}

	var resp Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Success {
		t.Error("expected success to be false")
	}
}

func TestHandleError_GenericError(t *testing.T) {
	w := httptest.NewRecorder()
	genericErr := fmt.Errorf("database connection failed")
	HandleError(w, genericErr)

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected status %d, got %d", http.StatusInternalServerError, w.Code)
	}

	var result map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if result["error"] == "" {
		t.Error("expected error message to be set")
	}
}

func TestUnauthorized(t *testing.T) {
	w := httptest.NewRecorder()
	Unauthorized(w, "")

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
	}

	var resp Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Success {
		t.Error("expected success to be false")
	}

	if resp.Error.Code != "UNAUTHORIZED" {
		t.Errorf("expected code 'UNAUTHORIZED', got '%s'", resp.Error.Code)
	}

	if resp.Error.Message == "" {
		t.Error("expected error message to be set")
	}
}

func TestUnauthorized_WithMessage(t *testing.T) {
	w := httptest.NewRecorder()
	Unauthorized(w, "Session expired")

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected status %d, got %d", http.StatusUnauthorized, w.Code)
	}

	var resp Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Error.Message != "Session expired" {
		t.Errorf("expected message 'Session expired', got '%s'", resp.Error.Message)
	}
}

func TestForbidden(t *testing.T) {
	w := httptest.NewRecorder()
	Forbidden(w, "")

	if w.Code != http.StatusForbidden {
		t.Errorf("expected status %d, got %d", http.StatusForbidden, w.Code)
	}

	var resp Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Success {
		t.Error("expected success to be false")
	}

	if resp.Error.Code != "FORBIDDEN" {
		t.Errorf("expected code 'FORBIDDEN', got '%s'", resp.Error.Code)
	}
}

func TestBadRequest(t *testing.T) {
	w := httptest.NewRecorder()
	BadRequest(w, "invalid field")

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}

	var result map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if result["error"] != "invalid field" {
		t.Errorf("expected error message 'invalid field', got '%s'", result["error"])
	}
}

func TestNotFound(t *testing.T) {
	w := httptest.NewRecorder()
	NotFound(w, "User", "123")

	if w.Code != http.StatusNotFound {
		t.Errorf("expected status %d, got %d", http.StatusNotFound, w.Code)
	}

	var resp Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Success {
		t.Error("expected success to be false")
	}

	if resp.Error.Code != "NOT_FOUND" {
		t.Errorf("expected code 'NOT_FOUND', got '%s'", resp.Error.Code)
	}

	if resp.Error.Message == "" {
		t.Error("expected error message to be set")
	}

	if resp.Error.Details == nil {
		t.Fatal("expected details to be set")
	}

	if resp.Error.Details["resource_type"] != "User" {
		t.Errorf("expected resource_type 'User', got '%v'", resp.Error.Details["resource_type"])
	}

	if resp.Error.Details["identifier"] != "123" {
		t.Errorf("expected identifier '123', got '%v'", resp.Error.Details["identifier"])
	}
}

func TestValidationError(t *testing.T) {
	w := httptest.NewRecorder()
	ValidationError(w, "email", "invalid format")

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected status %d, got %d", http.StatusBadRequest, w.Code)
	}

	var resp Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Success {
		t.Error("expected success to be false")
	}

	if resp.Error.Code != "VALIDATION_ERROR" {
		t.Errorf("expected code 'VALIDATION_ERROR', got '%s'", resp.Error.Code)
	}

	if resp.Error.Message != "Validation failed" {
		t.Errorf("expected message 'Validation failed', got '%s'", resp.Error.Message)
	}

	if resp.Error.Details == nil {
		t.Fatal("expected details to be set")
	}

	if resp.Error.Details["field"] != "email" {
		t.Errorf("expected field 'email', got '%v'", resp.Error.Details["field"])
	}

	if resp.Error.Details["message"] != "invalid format" {
		t.Errorf("expected message 'invalid format', got '%v'", resp.Error.Details["message"])
	}
}

func TestRateLimitExceeded(t *testing.T) {
	w := httptest.NewRecorder()
	RateLimitExceeded(w, 60)

	if w.Code != http.StatusTooManyRequests {
		t.Errorf("expected status %d, got %d", http.StatusTooManyRequests, w.Code)
	}

	retryAfter := w.Header().Get("Retry-After")
	if retryAfter != "60" {
		t.Errorf("expected Retry-After '60', got '%s'", retryAfter)
	}

	var resp Response
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if resp.Success {
		t.Error("expected success to be false")
	}

	if resp.Error.Code != "RATE_LIMITED" {
		t.Errorf("expected code 'RATE_LIMITED', got '%s'", resp.Error.Code)
	}
}

func TestServerError(t *testing.T) {
	w := httptest.NewRecorder()
	ServerError(w, "database error")

	if w.Code != http.StatusInternalServerError {
		t.Errorf("expected status %d, got %d", http.StatusInternalServerError, w.Code)
	}

	var result map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if result["error"] == "" {
		t.Error("expected error message to be set")
	}
}

func TestServerError_WithMessage(t *testing.T) {
	w := httptest.NewRecorder()
	ServerError(w, "Connection timeout")

	var result map[string]string
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatalf("failed to unmarshal response: %v", err)
	}

	if result["error"] != "Connection timeout" {
		t.Errorf("expected error message 'Connection timeout', got '%s'", result["error"])
	}
}
