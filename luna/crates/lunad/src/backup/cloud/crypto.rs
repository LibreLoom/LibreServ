//! Cloud backup crypto: recovery phrase to keys, sealing to public keys, authenticated
//! encryption, signatures, and chunk/pack ids. Only well-known crates provide the primitives
//! (RustCrypto for HKDF, HMAC, SHA-256 and XChaCha20-Poly1305; dalek for X25519 and Ed25519).
//! The browser port reads `vectors.json` next to this file, so changing any output here is a
//! format change.

use anyhow::{Result, bail};
use bip39::{Language, Mnemonic};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

/// Fixed HKDF salt for deriving keys from a recovery phrase.
const DERIVE_SALT: &[u8] = b"luna-backup-v1";
/// Prefix for the bytes a signature covers, so a signature for one purpose never passes for another.
const SIG_PREFIX: &[u8] = b"luna-sig-v1\0";
/// HKDF label for the key that seals a copy to a user's public key.
const SEAL_INFO: &[u8] = b"luna-seal-v1";
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
const PUBLIC_LEN: usize = 32;

/// Keys derived from one recovery phrase and one Luna id.
pub struct UserKeys {
    pub x25519_secret: [u8; 32],
    pub x25519_public: [u8; 32],
    pub self_key: [u8; 32],
    pub auth_secret: [u8; 32],
    pub auth_public: [u8; 32],
}

/// HKDF info: label, a zero byte, then the Luna id.
fn derive_info(label: &[u8], luna_id: &str) -> Vec<u8> {
    let mut info = Vec::with_capacity(label.len() + 1 + luna_id.len());
    info.extend_from_slice(label);
    info.push(0);
    info.extend_from_slice(luna_id.as_bytes());
    info
}

fn hkdf_32(ikm: &[u8], salt: Option<&[u8]>, info: &[u8]) -> [u8; 32] {
    let hk = Hkdf::<Sha256>::new(salt, ikm);
    let mut out = [0u8; 32];
    // 32 bytes is always a valid output length for HKDF-SHA256.
    hk.expand(info, &mut out)
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    out
}

/// Derive the user's keys from the 16 bytes of recovery phrase entropy.
pub fn derive(entropy: &[u8; 16], luna_id: &str) -> UserKeys {
    let mut x25519_secret = hkdf_32(entropy, Some(DERIVE_SALT), &derive_info(b"x25519", luna_id));
    // Clamp as X25519 does, so the stored secret and its public key always agree.
    x25519_secret[0] &= 248;
    x25519_secret[31] &= 127;
    x25519_secret[31] |= 64;
    let x25519_public = PublicKey::from(&StaticSecret::from(x25519_secret)).to_bytes();

    let self_key = hkdf_32(entropy, Some(DERIVE_SALT), &derive_info(b"self", luna_id));

    let auth_secret = hkdf_32(entropy, Some(DERIVE_SALT), &derive_info(b"auth", luna_id));
    let auth_public = SigningKey::from_bytes(&auth_secret)
        .verifying_key()
        .to_bytes();

    UserKeys {
        x25519_secret,
        x25519_public,
        self_key,
        auth_secret,
        auth_public,
    }
}

/// Seal `msg` so only the holder of the secret half of `recipient_public` can open it.
/// Layout: ephemeral public key (32) ‖ nonce (24) ‖ ciphertext and tag.
pub fn seal(recipient_public: &[u8; 32], aad: &[u8], msg: &[u8]) -> Result<Vec<u8>> {
    let mut eph_secret = [0u8; 32];
    OsRng.fill_bytes(&mut eph_secret);
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    seal_inner(eph_secret, nonce, recipient_public, aad, msg)
}

/// Check that a recipient public key is not a low-order point. Such a key makes every
/// shared secret the same (all zeros), so anything sealed to it could be opened by anyone.
pub fn check_public_key(public: &[u8; 32]) -> Result<()> {
    // Multiplying a low-order point by a clamped scalar gives the identity (all zeros).
    let probe = StaticSecret::from([0x42u8; 32]);
    if !probe
        .diffie_hellman(&PublicKey::from(*public))
        .was_contributory()
    {
        bail!("This recovery key is not valid. Set up the recovery phrase again.");
    }
    Ok(())
}

/// `seal` with the ephemeral secret and nonce supplied by the caller (used by the vectors).
fn seal_inner(
    eph_secret: [u8; 32],
    nonce: [u8; NONCE_LEN],
    recipient_public: &[u8; 32],
    aad: &[u8],
    msg: &[u8],
) -> Result<Vec<u8>> {
    let eph = StaticSecret::from(eph_secret);
    let eph_public = PublicKey::from(&eph).to_bytes();
    let shared = eph.diffie_hellman(&PublicKey::from(*recipient_public));
    // A low-order recipient key gives an all-zero shared secret. Refuse to seal to it.
    if !shared.was_contributory() {
        bail!("This recovery key is not valid. Set up the recovery phrase again.");
    }
    let key = seal_key(shared.as_bytes(), &eph_public, recipient_public);

    let mut out = Vec::with_capacity(PUBLIC_LEN + NONCE_LEN + msg.len() + TAG_LEN);
    out.extend_from_slice(&eph_public);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&aead_encrypt(&key, &nonce, aad, msg));
    Ok(out)
}

/// Open a sealed copy with the recipient's X25519 secret.
pub fn open(secret: &[u8; 32], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < PUBLIC_LEN + NONCE_LEN + TAG_LEN {
        bail!("This sealed copy is too short to be valid.");
    }
    let mut eph_public = [0u8; PUBLIC_LEN];
    eph_public.copy_from_slice(&sealed[..PUBLIC_LEN]);
    let nonce: [u8; NONCE_LEN] = sealed[PUBLIC_LEN..PUBLIC_LEN + NONCE_LEN]
        .try_into()
        .expect("slice has NONCE_LEN bytes");
    let body = &sealed[PUBLIC_LEN + NONCE_LEN..];

    let secret = StaticSecret::from(*secret);
    let recipient_public = PublicKey::from(&secret).to_bytes();
    let shared = secret.diffie_hellman(&PublicKey::from(eph_public));
    if !shared.was_contributory() {
        bail!("This sealed copy is not valid.");
    }
    let key = seal_key(shared.as_bytes(), &eph_public, &recipient_public);
    aead_decrypt(&key, &nonce, aad, body)
        .map_err(|_| anyhow::anyhow!("This sealed copy could not be opened. It was changed, or it was sealed to a different key."))
}

/// HKDF over the X25519 shared secret, bound to both public keys.
fn seal_key(shared: &[u8; 32], eph_public: &[u8; 32], recipient_public: &[u8; 32]) -> [u8; 32] {
    let mut info = Vec::with_capacity(SEAL_INFO.len() + 2 * PUBLIC_LEN);
    info.extend_from_slice(SEAL_INFO);
    info.extend_from_slice(eph_public);
    info.extend_from_slice(recipient_public);
    hkdf_32(shared, None, &info)
}

/// Encrypt with a random nonce. Layout: nonce (24) ‖ ciphertext and tag.
pub fn encrypt(key: &[u8; 32], aad: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    encrypt_inner(key, nonce, aad, msg)
}

/// `encrypt` with the nonce supplied by the caller (used by the vectors).
fn encrypt_inner(key: &[u8; 32], nonce: [u8; NONCE_LEN], aad: &[u8], msg: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(NONCE_LEN + msg.len() + TAG_LEN);
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&aead_encrypt(key, &nonce, aad, msg));
    out
}

/// Decrypt the output of `encrypt`.
pub fn decrypt(key: &[u8; 32], aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    if sealed.len() < NONCE_LEN + TAG_LEN {
        bail!("This encrypted data is too short to be valid.");
    }
    let nonce: [u8; NONCE_LEN] = sealed[..NONCE_LEN]
        .try_into()
        .expect("slice has NONCE_LEN bytes");
    aead_decrypt(key, &nonce, aad, &sealed[NONCE_LEN..]).map_err(|_| {
        anyhow::anyhow!(
            "This encrypted data could not be opened. It was changed, or the key is wrong."
        )
    })
}

fn aead_encrypt(key: &[u8; 32], nonce: &[u8; NONCE_LEN], aad: &[u8], msg: &[u8]) -> Vec<u8> {
    let cipher = XChaCha20Poly1305::new(&Key::from(*key));
    // Encryption only fails if the message exceeds the cipher's length limit, far above any pack.
    cipher
        .encrypt(&XNonce::from(*nonce), Payload { msg, aad })
        .expect("XChaCha20-Poly1305 encryption fails only on oversized input")
}

fn aead_decrypt(
    key: &[u8; 32],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    body: &[u8],
) -> std::result::Result<Vec<u8>, chacha20poly1305::aead::Error> {
    let cipher = XChaCha20Poly1305::new(&Key::from(*key));
    cipher.decrypt(&XNonce::from(*nonce), Payload { msg: body, aad })
}

/// An Ed25519 signing key. Its secret is never shown to a person; it lives in Luna's database and drives.
pub struct Signer {
    key: SigningKey,
}

impl Signer {
    pub fn generate() -> Self {
        let mut seed = [0u8; 32];
        OsRng.fill_bytes(&mut seed);
        Self::from_seed(seed)
    }

    pub fn from_seed(seed: [u8; 32]) -> Self {
        Self {
            key: SigningKey::from_bytes(&seed),
        }
    }

    pub fn seed(&self) -> [u8; 32] {
        self.key.to_bytes()
    }

    pub fn public(&self) -> [u8; 32] {
        self.key.verifying_key().to_bytes()
    }

    /// Sign `msg` under `domain`. The signed bytes are `SIG_PREFIX ‖ domain ‖ 0x00 ‖ msg`.
    pub fn sign(&self, domain: &str, msg: &[u8]) -> [u8; 64] {
        self.key.sign(&signed_bytes(domain, msg)).to_bytes()
    }
}

/// Check a signature made by `Signer::sign` with the same `domain`.
pub fn verify(public: &[u8; 32], domain: &str, msg: &[u8], sig: &[u8; 64]) -> bool {
    let Ok(key) = VerifyingKey::from_bytes(public) else {
        return false;
    };
    key.verify_strict(&signed_bytes(domain, msg), &Signature::from_bytes(sig))
        .is_ok()
}

fn signed_bytes(domain: &str, msg: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(SIG_PREFIX.len() + domain.len() + 1 + msg.len());
    out.extend_from_slice(SIG_PREFIX);
    out.extend_from_slice(domain.as_bytes());
    out.push(0);
    out.extend_from_slice(msg);
    out
}

/// Chunk id = HMAC-SHA256(dedup key, chunk). Equal chunks in one backup get one id.
pub fn chunk_id(dedup_key: &[u8; 32], chunk: &[u8]) -> [u8; 32] {
    let mut mac =
        <Hmac<Sha256> as Mac>::new_from_slice(dedup_key).expect("HMAC accepts keys of any length");
    mac.update(chunk);
    mac.finalize().into_bytes().into()
}

/// Pack id = SHA-256 of the pack's ciphertext. Connect checks it on upload and browsers on download.
pub fn pack_id(ciphertext: &[u8]) -> [u8; 32] {
    Sha256::digest(ciphertext).into()
}

/// Unambiguous byte encoding for signed data: each name and value gets a u32 BE length prefix.
pub fn canonical(fields: &[(&str, &[u8])]) -> Vec<u8> {
    let mut out = Vec::new();
    for (name, value) in fields {
        push_len_prefixed(&mut out, name.as_bytes());
        push_len_prefixed(&mut out, value);
    }
    out
}

fn push_len_prefixed(out: &mut Vec<u8>, bytes: &[u8]) {
    let len = u32::try_from(bytes.len()).expect("canonical field is under 4 GiB");
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(bytes);
}

/// Read 12 English recovery words (case and extra spaces ignored) into their 16 bytes of entropy.
pub fn phrase_to_entropy(words: &str) -> Result<[u8; 16]> {
    let words: Vec<String> = words.split_whitespace().map(str::to_lowercase).collect();
    if words.len() != 12 {
        bail!(
            "Your recovery phrase has {} words. It needs exactly 12.",
            words.len()
        );
    }
    for word in &words {
        if Language::English.find_word(word).is_none() {
            bail!("That word isn't on the recovery phrase list: {word}");
        }
    }
    let phrase = words.join(" ");
    let mnemonic = Mnemonic::parse_in_normalized(Language::English, &phrase).map_err(|_| {
        anyhow::anyhow!("These 12 words don't form a valid recovery phrase. Check each word.")
    })?;
    let entropy = mnemonic.to_entropy();
    entropy.try_into().map_err(|_| {
        anyhow::anyhow!("These 12 words don't form a valid recovery phrase. Check each word.")
    })
}

/// The 12 English words for 16 bytes of entropy.
pub fn entropy_to_phrase(entropy: &[u8; 16]) -> String {
    // 16 bytes is always a valid BIP39 entropy length.
    Mnemonic::from_entropy_in(Language::English, entropy)
        .expect("16 bytes is a valid BIP39 entropy length")
        .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{Value, json};

    const LUNA_ID: &str = "luna-test-1";

    fn entropy() -> [u8; 16] {
        std::array::from_fn(|i| i as u8)
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{b:02x}")).collect()
    }

    /// Everything the JS port must reproduce, from fixed inputs.
    fn build_vectors() -> Value {
        let keys = derive(&entropy(), LUNA_ID);
        let signer = Signer::from_seed(std::array::from_fn(|i| 0x40 + i as u8));
        let dedup_key = [0xa5u8; 32];
        let recipient_public = keys.x25519_public;
        let sealed = seal_inner(
            [0x11; 32],
            [0x22; NONCE_LEN],
            &recipient_public,
            b"aad",
            b"backup key bytes",
        )
        .unwrap();
        let canonical_bytes = canonical(&[
            ("luna_id", LUNA_ID.as_bytes()),
            ("protection", b"p1"),
            ("version", &[0, 0, 0, 2]),
        ]);
        let record = b"snapshot record";
        let pack = encrypt_inner(
            &keys.self_key,
            [0x33; NONCE_LEN],
            b"pack-aad",
            b"pack bytes",
        );
        json!({
            "entropy": hex(&entropy()),
            "luna_id": LUNA_ID,
            "phrase": entropy_to_phrase(&entropy()),
            "x25519_secret": hex(&keys.x25519_secret),
            "x25519_public": hex(&keys.x25519_public),
            "self_key": hex(&keys.self_key),
            "auth_secret": hex(&keys.auth_secret),
            "auth_public": hex(&keys.auth_public),
            "signer_seed": hex(&signer.seed()),
            "signer_public": hex(&signer.public()),
            "chunk_id": hex(&chunk_id(&dedup_key, b"luna chunk one")),
            "pack_id": hex(&pack_id(b"ciphertext bytes")),
            "canonical": hex(&canonical_bytes),
            "signature": hex(&signer.sign("snapshot", record)),
            "seal": {
                "ephemeral_secret": hex(&[0x11; 32]),
                "nonce": hex(&[0x22; NONCE_LEN]),
                "aad": hex(b"aad"),
                "msg": hex(b"backup key bytes"),
                "sealed": hex(&sealed),
            },
            "encrypt": {
                "key": hex(&keys.self_key),
                "nonce": hex(&[0x33; NONCE_LEN]),
                "aad": hex(b"pack-aad"),
                "msg": hex(b"pack bytes"),
                "sealed": hex(&pack),
            },
        })
    }

    #[test]
    #[ignore = "prints vectors.json; run with --ignored --nocapture to regenerate"]
    fn print_vectors() {
        println!(
            "{}",
            serde_json::to_string_pretty(&build_vectors()).unwrap()
        );
    }

    #[test]
    fn vectors_match_file() {
        let file: Value = serde_json::from_str(include_str!("vectors.json")).unwrap();
        assert_eq!(build_vectors(), file);
    }

    #[test]
    fn derive_is_deterministic_and_bound_to_luna_id() {
        let a = derive(&entropy(), LUNA_ID);
        let b = derive(&entropy(), LUNA_ID);
        assert_eq!(a.x25519_public, b.x25519_public);
        assert_eq!(a.self_key, b.self_key);
        let other = derive(&entropy(), "luna-test-2");
        assert_ne!(a.x25519_public, other.x25519_public);
        assert_ne!(a.self_key, other.self_key);
        assert_ne!(a.auth_public, other.auth_public);
    }

    #[test]
    fn x25519_secret_is_clamped() {
        let k = derive(&entropy(), LUNA_ID);
        assert_eq!(k.x25519_secret[0] & 7, 0);
        assert_eq!(k.x25519_secret[31] & 0x80, 0);
        assert_eq!(k.x25519_secret[31] & 0x40, 0x40);
    }

    #[test]
    fn seal_open_round_trip() {
        let k = derive(&entropy(), LUNA_ID);
        let sealed = seal(&k.x25519_public, b"aad", b"hello").unwrap();
        assert_eq!(open(&k.x25519_secret, b"aad", &sealed).unwrap(), b"hello");
    }

    #[test]
    fn seal_refuses_low_order_recipient_keys() {
        // All zeros is the identity point, and so is the order-2 point u = 1.
        for low_order in [[0u8; 32], {
            let mut one = [0u8; 32];
            one[0] = 1;
            one
        }] {
            assert!(seal(&low_order, b"aad", b"key").is_err());
            assert!(check_public_key(&low_order).is_err());
        }
        let k = derive(&entropy(), LUNA_ID);
        assert!(check_public_key(&k.x25519_public).is_ok());
        assert!(seal(&k.x25519_public, b"aad", b"key").is_ok());
    }

    #[test]
    fn open_rejects_wrong_key_aad_and_tampering() {
        let k = derive(&entropy(), LUNA_ID);
        let other = derive(&[9u8; 16], LUNA_ID);
        let sealed = seal(&k.x25519_public, b"aad", b"hello").unwrap();
        assert!(open(&other.x25519_secret, b"aad", &sealed).is_err());
        assert!(open(&k.x25519_secret, b"other", &sealed).is_err());
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(open(&k.x25519_secret, b"aad", &tampered).is_err());
        assert!(open(&k.x25519_secret, b"aad", &sealed[..10]).is_err());
    }

    #[test]
    fn encrypt_decrypt_round_trip_and_rejects_wrong_key_or_aad() {
        let key = [7u8; 32];
        let sealed = encrypt(&key, b"aad", b"pack");
        assert_eq!(decrypt(&key, b"aad", &sealed).unwrap(), b"pack");
        assert!(decrypt(&[8u8; 32], b"aad", &sealed).is_err());
        assert!(decrypt(&key, b"other", &sealed).is_err());
    }

    #[test]
    fn signatures_verify_only_under_their_domain_and_message() {
        let signer = Signer::from_seed([3u8; 32]);
        let public = signer.public();
        let sig = signer.sign("snapshot", b"record");
        assert!(verify(&public, "snapshot", b"record", &sig));
        assert!(!verify(&public, "other", b"record", &sig));
        assert!(!verify(&public, "snapshot", b"changed", &sig));
        let stranger = Signer::from_seed([4u8; 32]).public();
        assert!(!verify(&stranger, "snapshot", b"record", &sig));
    }

    #[test]
    fn generated_signer_round_trips_its_seed() {
        let signer = Signer::generate();
        let again = Signer::from_seed(signer.seed());
        assert_eq!(signer.public(), again.public());
    }

    #[test]
    fn chunk_id_depends_on_dedup_key_and_chunk() {
        let a = chunk_id(&[1u8; 32], b"chunk");
        assert_eq!(a, chunk_id(&[1u8; 32], b"chunk"));
        assert_ne!(a, chunk_id(&[2u8; 32], b"chunk"));
        assert_ne!(a, chunk_id(&[1u8; 32], b"other"));
    }

    #[test]
    fn canonical_is_length_prefixed_and_unambiguous() {
        let joined = canonical(&[("ab", b"c")]);
        let split = canonical(&[("a", b"bc")]);
        assert_ne!(joined, split);
        assert_eq!(joined, [0, 0, 0, 2, b'a', b'b', 0, 0, 0, 1, b'c']);
    }

    #[test]
    fn all_zero_entropy_matches_bip39_vector() {
        let phrase = entropy_to_phrase(&[0u8; 16]);
        assert_eq!(
            phrase,
            "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
        );
        assert_eq!(phrase_to_entropy(&phrase).unwrap(), [0u8; 16]);
    }

    #[test]
    fn phrase_round_trips_and_ignores_case_and_spacing() {
        let phrase = entropy_to_phrase(&entropy());
        let messy = format!("  {}  ", phrase.to_uppercase().replace(' ', "   "));
        assert_eq!(phrase_to_entropy(&messy).unwrap(), entropy());
    }

    #[test]
    fn phrase_errors_are_plain() {
        let good = entropy_to_phrase(&entropy());
        let unknown = good.replacen("abandon", "lunaxyz", 1);
        let err = phrase_to_entropy(&unknown).unwrap_err().to_string();
        assert!(
            err.starts_with("That word isn't on the recovery phrase list: lunaxyz"),
            "{err}"
        );

        let bad_checksum = "abandon ".repeat(11) + "abandon";
        let err = phrase_to_entropy(&bad_checksum).unwrap_err().to_string();
        assert_eq!(
            err,
            "These 12 words don't form a valid recovery phrase. Check each word."
        );

        let short = phrase_to_entropy("abandon abandon")
            .unwrap_err()
            .to_string();
        assert_eq!(
            short,
            "Your recovery phrase has 2 words. It needs exactly 12."
        );
    }
}
