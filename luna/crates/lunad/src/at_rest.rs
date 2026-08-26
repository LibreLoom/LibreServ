//! AES-256-GCM encryption for small JSON blobs (connect credentials).

use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::password_hash::rand_core::{OsRng, RngCore};
use base64::Engine;
use serde_json::Value;

const PREFIX: &str = "v1:";

pub fn encrypt_json(key: &[u8; 32], value: &Value) -> anyhow::Result<String> {
    let plain = serde_json::to_vec(value)?;
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| anyhow::anyhow!("{e}"))?;
    let mut nonce_bytes = [0u8; 12];
    OsRng.fill_bytes(&mut nonce_bytes);
    let nonce = Nonce::from_slice(&nonce_bytes);
    let ciphertext = cipher
        .encrypt(nonce, plain.as_ref())
        .map_err(|e| anyhow::anyhow!("encrypt: {e}"))?;
    let mut out = nonce_bytes.to_vec();
    out.extend(ciphertext);
    Ok(format!(
        "{PREFIX}{}",
        base64::engine::general_purpose::STANDARD.encode(out)
    ))
}

pub fn decrypt_json(key: &[u8; 32], blob: &str) -> anyhow::Result<Value> {
    let Some(encoded) = blob.strip_prefix(PREFIX) else {
        anyhow::bail!("unknown encryption format");
    };
    let bytes = base64::engine::general_purpose::STANDARD.decode(encoded)?;
    if bytes.len() < 13 {
        anyhow::bail!("ciphertext too short");
    }
    let (nonce_bytes, ciphertext) = bytes.split_at(12);
    let cipher = Aes256Gcm::new_from_slice(key).map_err(|e| anyhow::anyhow!("{e}"))?;
    let nonce = Nonce::from_slice(nonce_bytes);
    let plain = cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| anyhow::anyhow!("decrypt: {e}"))?;
    Ok(serde_json::from_slice(&plain)?)
}

pub fn is_encrypted_blob(bytes: &[u8]) -> bool {
    bytes.starts_with(PREFIX.as_bytes())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trip_json() {
        let key = [7u8; 32];
        let value = json!({"device_token": "secret", "hostname": "x.example"});
        let enc = encrypt_json(&key, &value).unwrap();
        assert!(enc.starts_with(PREFIX));
        let dec = decrypt_json(&key, &enc).unwrap();
        assert_eq!(dec, value);
    }
}
