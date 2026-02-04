// Package validation provides input validation utilities for API handlers.
package validation

import (
	"fmt"
	"net/mail"
	"regexp"
	"strings"
	"unicode"

	"gt.plainskill.net/LibreLoom/LibreServ/internal/constants"
)

var (
	// usernamePattern validates usernames: alphanumeric, hyphens, underscores
	usernamePattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

	// subdomainPattern validates DNS subdomains
	subdomainPattern = regexp.MustCompile(`^[a-zA-Z0-9]([a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$`)

	// instanceIDPattern validates app instance IDs
	instanceIDPattern = regexp.MustCompile(`^[a-zA-Z0-9_-]+$`)

	// routeIDPattern validates route IDs (UUID format)
	routeIDPattern = regexp.MustCompile(`^[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}$`)

	// rolePattern validates user roles
	rolePattern = regexp.MustCompile(`^(admin|user)$`)

	// pathTraversalPattern detects path traversal attempts
	pathTraversalPattern = regexp.MustCompile(`\.\./|\.\.\\`)
)

// ValidationError represents a validation error
type ValidationError struct {
	Field   string
	Message string
}

func (e ValidationError) Error() string {
	return fmt.Sprintf("%s: %s", e.Field, e.Message)
}

// Validator provides validation methods
type Validator struct {
	errors []ValidationError
}

// New creates a new Validator
func New() *Validator {
	return &Validator{
		errors: make([]ValidationError, 0),
	}
}

// HasErrors returns true if there are validation errors
func (v *Validator) HasErrors() bool {
	return len(v.errors) > 0
}

// Errors returns all validation errors
func (v *Validator) Errors() []ValidationError {
	return v.errors
}

// FirstError returns the first error or nil
func (v *Validator) FirstError() *ValidationError {
	if len(v.errors) > 0 {
		return &v.errors[0]
	}
	return nil
}

// ErrorMap returns errors as a map for JSON responses
func (v *Validator) ErrorMap() map[string]string {
	result := make(map[string]string)
	for _, err := range v.errors {
		result[err.Field] = err.Message
	}
	return result
}

// addError adds a validation error
func (v *Validator) addError(field, message string) {
	v.errors = append(v.errors, ValidationError{
		Field:   field,
		Message: message,
	})
}

// ValidateUsername validates a username
func (v *Validator) ValidateUsername(username string) *Validator {
	if strings.TrimSpace(username) == "" {
		v.addError("username", "Username is required")
		return v
	}

	if len(username) < 3 {
		v.addError("username", "Username must be at least 3 characters")
		return v
	}

	if len(username) > 32 {
		v.addError("username", "Username must be no more than 32 characters")
		return v
	}

	if !usernamePattern.MatchString(username) {
		v.addError("username", "Username can only contain letters, numbers, hyphens, and underscores")
	}

	return v
}

// ValidatePassword validates a password
func (v *Validator) ValidatePassword(password string) *Validator {
	if strings.TrimSpace(password) == "" {
		v.addError("password", "Password is required")
		return v
	}

	if len(password) < constants.MinPasswordLength {
		v.addError("password", fmt.Sprintf("Password must be at least %d characters", constants.MinPasswordLength))
		return v
	}

	if len(password) > 128 {
		v.addError("password", "Password must be no more than 128 characters")
		return v
	}

	hasLetter := false
	hasNumber := false
	for _, char := range password {
		if unicode.IsLetter(char) {
			hasLetter = true
		}
		if unicode.IsNumber(char) {
			hasNumber = true
		}
	}

	if !hasLetter || !hasNumber {
		v.addError("password", "Password must contain at least one letter and one number")
	}

	return v
}

// ValidateEmail validates an email address
func (v *Validator) ValidateEmail(email string) *Validator {
	if strings.TrimSpace(email) == "" {
		// Email is optional in some contexts
		return v
	}

	if len(email) > 254 {
		v.addError("email", "Email must be no more than 254 characters")
		return v
	}

	_, err := mail.ParseAddress(email)
	if err != nil {
		v.addError("email", "Invalid email format")
	}

	return v
}

// ValidateRole validates a user role
func (v *Validator) ValidateRole(role string) *Validator {
	if strings.TrimSpace(role) == "" {
		v.addError("role", "Role is required")
		return v
	}

	if !rolePattern.MatchString(role) {
		v.addError("role", "Role must be 'admin' or 'user'")
	}

	return v
}

// ValidateInstanceID validates an app instance ID
func (v *Validator) ValidateInstanceID(instanceID string) *Validator {
	if strings.TrimSpace(instanceID) == "" {
		v.addError("instance_id", "Instance ID is required")
		return v
	}

	if len(instanceID) < constants.MinInstanceIDLength {
		v.addError("instance_id", "Instance ID cannot be empty")
		return v
	}

	if len(instanceID) > constants.MaxInstanceIDLength {
		v.addError("instance_id", fmt.Sprintf("Instance ID must be no more than %d characters", constants.MaxInstanceIDLength))
		return v
	}

	if !instanceIDPattern.MatchString(instanceID) {
		v.addError("instance_id", "Instance ID can only contain letters, numbers, hyphens, and underscores")
	}

	if pathTraversalPattern.MatchString(instanceID) {
		v.addError("instance_id", "Instance ID contains invalid characters")
	}

	return v
}

// ValidateSubdomain validates a subdomain
func (v *Validator) ValidateSubdomain(subdomain string) *Validator {
	if strings.TrimSpace(subdomain) == "" {
		v.addError("subdomain", "Subdomain is required")
		return v
	}

	if len(subdomain) > 63 {
		v.addError("subdomain", "Subdomain must be no more than 63 characters")
		return v
	}

	if !subdomainPattern.MatchString(subdomain) {
		v.addError("subdomain", "Invalid subdomain format")
	}

	return v
}

// ValidateRouteID validates a route ID (UUID)
func (v *Validator) ValidateRouteID(routeID string) *Validator {
	if strings.TrimSpace(routeID) == "" {
		v.addError("route_id", "Route ID is required")
		return v
	}

	if !routeIDPattern.MatchString(routeID) {
		v.addError("route_id", "Invalid route ID format")
	}

	return v
}

// ValidateSearchQuery validates a search query
func (v *Validator) ValidateSearchQuery(query string) *Validator {
	if len(query) > 100 {
		v.addError("search", "Search query must be no more than 100 characters")
	}

	return v
}

// ValidateNotEmpty validates that a field is not empty
func (v *Validator) ValidateNotEmpty(field, value, fieldName string) *Validator {
	if strings.TrimSpace(value) == "" {
		v.addError(field, fmt.Sprintf("%s is required", fieldName))
	}
	return v
}

// ValidateMaxLength validates maximum string length
func (v *Validator) ValidateMaxLength(field, value string, maxLen int, fieldName string) *Validator {
	if len(value) > maxLen {
		v.addError(field, fmt.Sprintf("%s must be no more than %d characters", fieldName, maxLen))
	}
	return v
}

// ValidateMinLength validates minimum string length
func (v *Validator) ValidateMinLength(field, value string, minLen int, fieldName string) *Validator {
	if len(value) < minLen {
		v.addError(field, fmt.Sprintf("%s must be at least %d characters", fieldName, minLen))
	}
	return v
}

// ValidateEnum validates that a value is in a set of allowed values
func (v *Validator) ValidateEnum(field, value string, allowed []string, fieldName string) *Validator {
	if strings.TrimSpace(value) == "" {
		return v // Empty is handled by ValidateNotEmpty if needed
	}

	for _, allowed := range allowed {
		if value == allowed {
			return v
		}
	}

	v.addError(field, fmt.Sprintf("%s must be one of: %s", fieldName, strings.Join(allowed, ", ")))
	return v
}

// ValidatePositiveInt validates that an integer is positive
func (v *Validator) ValidatePositiveInt(field string, value int, fieldName string) *Validator {
	if value <= 0 {
		v.addError(field, fmt.Sprintf("%s must be a positive number", fieldName))
	}
	return v
}

// ValidateRange validates that an integer is within a range
func (v *Validator) ValidateRange(field string, value, min, max int, fieldName string) *Validator {
	if value < min || value > max {
		v.addError(field, fmt.Sprintf("%s must be between %d and %d", fieldName, min, max))
	}
	return v
}

// SanitizeString removes potentially dangerous characters from a string
func SanitizeString(input string) string {
	// Remove null bytes
	input = strings.ReplaceAll(input, "\x00", "")
	// Remove control characters except newlines and tabs
	var result strings.Builder
	for _, r := range input {
		if r == '\n' || r == '\r' || r == '\t' || (r >= 32 && r < 127) || r > 127 {
			result.WriteRune(r)
		}
	}
	return result.String()
}

// TrimAndSanitize trims whitespace and sanitizes a string
func TrimAndSanitize(input string) string {
	return SanitizeString(strings.TrimSpace(input))
}
