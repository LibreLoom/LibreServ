package response

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
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
