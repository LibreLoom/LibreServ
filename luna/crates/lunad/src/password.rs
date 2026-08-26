//! Password policy aligned with LibreServ (12+ chars, letter + digit).

use thiserror::Error;

pub const MIN_PASSWORD_LENGTH: usize = 12;

#[derive(Debug, Error, PartialEq, Eq)]
#[error("{0}")]
pub struct PasswordValidationError(pub &'static str);

impl PasswordValidationError {
    pub fn message(&self) -> &str {
        self.0
    }
}

pub fn validate_password(password: &str) -> Result<(), PasswordValidationError> {
    if password.len() < MIN_PASSWORD_LENGTH {
        return Err(PasswordValidationError(
            "Passwords need at least 12 characters.",
        ));
    }
    let mut has_letter = false;
    let mut has_digit = false;
    for ch in password.chars() {
        if ch.is_ascii_alphabetic() {
            has_letter = true;
        } else if ch.is_ascii_digit() {
            has_digit = true;
        }
    }
    if !has_letter || !has_digit {
        return Err(PasswordValidationError(
            "Passwords need at least one letter and one number.",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_short_passwords() {
        assert!(validate_password("abc123").is_err());
    }

    #[test]
    fn accepts_libreserv_style_password() {
        assert!(validate_password("hunter22hunter1").is_ok());
    }
}
