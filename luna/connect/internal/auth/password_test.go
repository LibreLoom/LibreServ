package auth

import "testing"

func TestValidatePassword(t *testing.T) {
	if err := ValidatePassword("short1"); err == nil {
		t.Fatal("expected short password to fail")
	}
	if err := ValidatePassword("longpassword"); err == nil {
		t.Fatal("expected missing digit to fail")
	}
	if err := ValidatePassword("password1234"); err != nil {
		t.Fatalf("expected valid password: %v", err)
	}
}

func TestValidEmail(t *testing.T) {
	if ValidEmail("not-an-email") {
		t.Fatal("expected invalid email")
	}
	if !ValidEmail("person@example.com") {
		t.Fatal("expected valid email")
	}
}
