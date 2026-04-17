package validation

import (
	"testing"
)

func TestNewValidator(t *testing.T) {
	v := New()
	if v == nil {
		t.Fatal("expected non-nil validator")
	}
	if v.HasErrors() {
		t.Error("expected no errors initially")
	}
}

func TestHasErrors(t *testing.T) {
	v := New()
	if v.HasErrors() {
		t.Error("expected no errors initially")
	}

	v.addError("username", "required")
	if !v.HasErrors() {
		t.Error("expected errors after adding one")
	}
}

func TestErrors(t *testing.T) {
	v := New()
	v.addError("username", "required")
	v.addError("email", "invalid")

	errors := v.Errors()
	if len(errors) != 2 {
		t.Errorf("expected 2 errors, got %d", len(errors))
	}

	if errors[0].Field != "username" {
		t.Errorf("expected first error field 'username', got '%s'", errors[0].Field)
	}
	if errors[0].Message != "required" {
		t.Errorf("expected first error message 'required', got '%s'", errors[0].Message)
	}
}

func TestFirstError(t *testing.T) {
	v := New()
	v.addError("username", "required")
	v.addError("email", "invalid")

	first := v.FirstError()
	if first == nil {
		t.Fatal("expected non-nil first error")
	}
	if first.Field != "username" {
		t.Errorf("expected field 'username', got '%s'", first.Field)
	}
}

func TestFirstError_NoErrors(t *testing.T) {
	v := New()
	first := v.FirstError()
	if first != nil {
		t.Error("expected nil for no errors")
	}
}

func TestErrorMap(t *testing.T) {
	v := New()
	v.ValidateUsername("invalid@user")
	v.ValidatePassword("short")
	v.ValidateEmail("bad.email")

	errors := v.ErrorMap()
	if len(errors) != 3 {
		t.Errorf("expected 3 errors, got %d", len(errors))
	}

	if errors["username"] != "Username can only contain letters, numbers, hyphens, and underscores" {
		t.Errorf("unexpected username error: %s", errors["username"])
	}
	if errors["password"] != "Password must be at least 12 characters" {
		t.Errorf("unexpected password error: %s", errors["password"])
	}
	if errors["email"] != "Invalid email format" {
		t.Errorf("unexpected email error: %s", errors["email"])
	}
}

func TestValidateUsername_Valid(t *testing.T) {
	v := New()
	v.ValidateUsername("alice")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}
}

func TestValidateUsername_TooShort(t *testing.T) {
	v := New()
	v.ValidateUsername("ab")
	if !v.HasErrors() {
		t.Error("expected validation error for too short username")
	}

	first := v.FirstError()
	if first.Field != "username" {
		t.Errorf("expected field 'username', got '%s'", first.Field)
	}
	if first.Message != "Username must be at least 3 characters" {
		t.Errorf("expected message 'Username must be at least 3 characters', got '%s'", first.Message)
	}
}

func TestValidateUsername_TooLong(t *testing.T) {
	v := New()
	username := string(make([]byte, 33))
	v.ValidateUsername(username)
	if !v.HasErrors() {
		t.Error("expected validation error for too long username")
	}

	first := v.FirstError()
	if first.Field != "username" {
		t.Errorf("expected field 'username', got '%s'", first.Field)
	}
	if !contains(first.Message, "32 characters") {
		t.Errorf("expected message to mention 32 characters, got '%s'", first.Message)
	}
}

func TestValidateUsername_InvalidChars(t *testing.T) {
	v := New()
	v.ValidateUsername("alice@")
	if !v.HasErrors() {
		t.Error("expected validation error for invalid characters")
	}

	first := v.FirstError()
	if !contains(first.Message, "only contain letters") {
		t.Errorf("expected error message to mention allowed characters, got '%s'", first.Message)
	}
}

func TestValidatePassword_Valid(t *testing.T) {
	v := New()
	v.ValidatePassword("alice1234567")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}
}

func TestValidatePassword_Valid_12Chars(t *testing.T) {
	v := New()
	v.ValidatePassword("abcdefghij12")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}
}

func TestValidatePassword_NoLetter(t *testing.T) {
	v := New()
	v.ValidatePassword("123456789012")
	if !v.HasErrors() {
		t.Error("expected validation error for password without letter")
	}

	first := v.FirstError()
	if first.Message != "Password must contain at least one letter and one number" {
		t.Errorf("expected message 'Password must contain at least one letter and one number', got '%s'", first.Message)
	}
}

func TestValidatePassword_NoNumber(t *testing.T) {
	v := New()
	v.ValidatePassword("alicepassword")
	if !v.HasErrors() {
		t.Error("expected validation error for password without number")
	}

	first := v.FirstError()
	if first.Message != "Password must contain at least one letter and one number" {
		t.Errorf("expected message 'Password must contain at least one letter and one number', got '%s'", first.Message)
	}
}

func TestValidateEmail_Valid(t *testing.T) {
	v := New()
	v.ValidateEmail("alice@example.com")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}
}

func TestValidateEmail_InvalidFormat(t *testing.T) {
	v := New()
	v.ValidateEmail("not-an-email")
	if !v.HasErrors() {
		t.Error("expected validation error for invalid email format")
	}

	first := v.FirstError()
	if first.Field != "email" {
		t.Errorf("expected field 'email', got '%s'", first.Field)
	}
	if first.Message != "Invalid email format" {
		t.Errorf("expected message 'Invalid email format', got '%s'", first.Message)
	}
}

func TestValidateRole_Valid(t *testing.T) {
	v := New()
	v.ValidateRole("admin")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}

	v.ValidateRole("user")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}
}

func TestValidateRole_Invalid(t *testing.T) {
	v := New()
	v.ValidateRole("superadmin")
	if !v.HasErrors() {
		t.Error("expected validation error for invalid role")
	}

	first := v.FirstError()
	if first.Field != "role" {
		t.Errorf("expected field 'role', got '%s'", first.Field)
	}
	if !contains(first.Message, "admin") && !contains(first.Message, "user") {
		t.Errorf("expected message to mention valid roles, got '%s'", first.Message)
	}
}

func TestValidateInstanceID_Valid(t *testing.T) {
	v := New()
	v.ValidateInstanceID("my-app")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}
}

func TestValidateInstanceID_PathTraversal(t *testing.T) {
	v := New()
	v.ValidateInstanceID("../etc/passwd")
	if !v.HasErrors() {
		t.Error("expected validation error for path traversal")
	}

	first := v.FirstError()
	if first.Field != "instance_id" {
		t.Errorf("expected field 'instance_id', got '%s'", first.Field)
	}
	if !contains(first.Message, "only contain letters") {
		t.Errorf("expected message to mention allowed characters, got '%s'", first.Message)
	}
}

func TestValidateSubdomain_Valid(t *testing.T) {
	v := New()
	v.ValidateSubdomain("api")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}
}

func TestValidateSubdomain_InvalidFormat(t *testing.T) {
	v := New()
	v.ValidateSubdomain("api@domain")
	if !v.HasErrors() {
		t.Error("expected validation error for invalid subdomain format")
	}

	first := v.FirstError()
	if first.Field != "subdomain" {
		t.Errorf("expected field 'subdomain', got '%s'", first.Field)
	}
	if !contains(first.Message, "Invalid subdomain format") {
		t.Errorf("expected message to mention invalid format, got '%s'", first.Message)
	}
}

func TestValidateRouteID_Valid(t *testing.T) {
	v := New()
	v.ValidateRouteID("123e4567-e89b-12d3-a456-426614174000")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}
}

func TestValidateRouteID_InvalidFormat(t *testing.T) {
	v := New()
	v.ValidateRouteID("not-a-uuid")
	if !v.HasErrors() {
		t.Error("expected validation error for invalid route ID format")
	}

	first := v.FirstError()
	if first.Field != "route_id" {
		t.Errorf("expected field 'route_id', got '%s'", first.Field)
	}
	if !contains(first.Message, "Invalid route ID format") {
		t.Errorf("expected message to mention invalid format, got '%s'", first.Message)
	}
}

func TestValidateSearchQuery(t *testing.T) {
	v := New()
	v.ValidateSearchQuery("test query")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}
}

func TestValidateSearchQuery_TooLong(t *testing.T) {
	v := New()
	query := string(make([]byte, 101))
	v.ValidateSearchQuery(query)
	if !v.HasErrors() {
		t.Error("expected validation error for too long search query")
	}

	first := v.FirstError()
	if first.Field != "search" {
		t.Errorf("expected field 'search', got '%s'", first.Field)
	}
	if !contains(first.Message, "100 characters") {
		t.Errorf("expected message to mention 100 characters, got '%s'", first.Message)
	}
}

func TestValidateNotEmpty(t *testing.T) {
	v := New()
	v.ValidateNotEmpty("field", "", "Username")
	if !v.HasErrors() {
		t.Error("expected validation error for empty value")
	}

	first := v.FirstError()
	if first.Field != "field" {
		t.Errorf("expected field 'field', got '%s'", first.Field)
	}
	if !contains(first.Message, "Username") {
		t.Errorf("expected message to mention field name, got '%s'", first.Message)
	}
}

func TestValidateMaxLength(t *testing.T) {
	v := New()
	v.ValidateMaxLength("field", "a", 1, "Name")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}
}

func TestValidateMaxLength_Exceeds(t *testing.T) {
	v := New()
	v.ValidateMaxLength("field", "abc", 1, "Name")
	if !v.HasErrors() {
		t.Error("expected validation error for exceeding max length")
	}

	first := v.FirstError()
	if !contains(first.Message, "1 characters") {
		t.Errorf("expected message to mention max length, got '%s'", first.Message)
	}
}

func TestValidateMinLength(t *testing.T) {
	v := New()
	v.ValidateMinLength("field", "a", 2, "Name")
	if !v.HasErrors() {
		t.Error("expected validation error for below min length")
	}

	first := v.FirstError()
	if !contains(first.Message, "2 characters") {
		t.Errorf("expected message to mention min length, got '%s'", first.Message)
	}
}

func TestValidateMinLength_Sufficient(t *testing.T) {
	v := New()
	v.ValidateMinLength("field", "ab", 2, "Name")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}
}

func TestValidateEnum(t *testing.T) {
	v := New()
	v.ValidateEnum("role", "admin", []string{"admin", "user"}, "Role")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}
}

func TestValidateEnum_Invalid(t *testing.T) {
	v := New()
	v.ValidateEnum("role", "guest", []string{"admin", "user"}, "Role")
	if !v.HasErrors() {
		t.Error("expected validation error for invalid enum value")
	}

	first := v.FirstError()
	if !contains(first.Message, "admin") && !contains(first.Message, "user") {
		t.Errorf("expected message to mention valid values, got '%s'", first.Message)
	}
}

func TestValidatePositiveInt(t *testing.T) {
	v := New()
	v.ValidatePositiveInt("count", 10, "Count")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}
}

func TestValidatePositiveInt_Zero(t *testing.T) {
	v := New()
	v.ValidatePositiveInt("count", 0, "Count")
	if !v.HasErrors() {
		t.Error("expected validation error for zero")
	}

	first := v.FirstError()
	if !contains(first.Message, "positive number") {
		t.Errorf("expected message to mention positive number, got '%s'", first.Message)
	}
}

func TestValidatePositiveInt_Negative(t *testing.T) {
	v := New()
	v.ValidatePositiveInt("count", -5, "Count")
	if !v.HasErrors() {
		t.Error("expected validation error for negative")
	}

	first := v.FirstError()
	if !contains(first.Message, "positive number") {
		t.Errorf("expected message to mention positive number, got '%s'", first.Message)
	}
}

func TestValidateRange(t *testing.T) {
	v := New()
	v.ValidateRange("age", 25, 18, 65, "Age")
	if v.HasErrors() {
		t.Errorf("unexpected errors: %v", v.Errors())
	}
}

func TestValidateRange_BelowMin(t *testing.T) {
	v := New()
	v.ValidateRange("age", 10, 18, 65, "Age")
	if !v.HasErrors() {
		t.Error("expected validation error for below min")
	}

	first := v.FirstError()
	if !contains(first.Message, "18") && !contains(first.Message, "18 and 65") {
		t.Errorf("expected message to mention range, got '%s'", first.Message)
	}
}

func TestValidateRange_AboveMax(t *testing.T) {
	v := New()
	v.ValidateRange("age", 70, 18, 65, "Age")
	if !v.HasErrors() {
		t.Error("expected validation error for above max")
	}

	first := v.FirstError()
	if !contains(first.Message, "18") && !contains(first.Message, "18 and 65") {
		t.Errorf("expected message to mention range, got '%s'", first.Message)
	}
}

func TestSanitizeString(t *testing.T) {
	input := "test\x00\x01\x02string"
	result := SanitizeString(input)

	if contains(result, "\x00") {
		t.Error("expected null bytes to be removed")
	}
	if !contains(result, "test") {
		t.Error("expected valid characters to be preserved")
	}
	if !contains(result, "string") {
		t.Error("expected valid characters to be preserved")
	}
}

func TestSanitizeString_ControlCharacters(t *testing.T) {
	input := "test\t\n\r\x1bstring"
	result := SanitizeString(input)

	// Control characters except tab, newline, carriage return should be removed
	if contains(result, "\x1b") {
		t.Error("expected escape character to be removed")
	}
}

func TestTrimAndSanitize(t *testing.T) {
	input := "  test string  "
	result := TrimAndSanitize(input)

	if result != "test string" {
		t.Errorf("expected trimmed result 'test string', got '%s'", result)
	}
}

func TestTrimAndSanitize_WithNulls(t *testing.T) {
	input := "  test\x00\x00string  "
	result := TrimAndSanitize(input)

	if contains(result, "\x00") {
		t.Error("expected null bytes to be removed")
	}
	if result != "teststring" {
		t.Errorf("expected sanitized result 'teststring', got '%s'", result)
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
