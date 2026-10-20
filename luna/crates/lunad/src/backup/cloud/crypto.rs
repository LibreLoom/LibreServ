//! Cloud backup crypto: recovery phrase to keys, sealing to public keys, authenticated
//! encryption, signatures, and chunk/pack ids. Only well-known crates provide the primitives
//! (RustCrypto for HKDF, HMAC, SHA-256, XChaCha20-Poly1305 and ML-KEM; dalek for X25519 and Ed25519).
//!
//! Sealing is hybrid: a copy opens only with both the X25519 secret and the ML-KEM-768 secret, so
//! it stays safe if either one is broken later (for example by a quantum computer).
//! The browser port reads `vectors.json` next to this file, so changing any output here is a
//! format change.

use anyhow::{Result, bail};
use bip39::{Language, Mnemonic};
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use ed25519_dalek::{Signature, Signer as _, SigningKey, VerifyingKey};
use hkdf::Hkdf;
use hmac::{Hmac, Mac};
use ml_dsa::{
    EncodedSignature, EncodedVerifyingKey, Keypair, MlDsa65, Signature as MlSignature,
    SigningKey as MlSigningKey, VerifyingKey as MlVerifyingKey,
};
use ml_kem::kem::{Decapsulate, KeyExport};
use ml_kem::{B32, DecapsulationKey768, EncapsulationKey768, Seed};
use rand_core::{OsRng, RngCore};
use sha2::{Digest, Sha256};
use x25519_dalek::{PublicKey, StaticSecret};

/// Fixed HKDF salt for deriving keys from a recovery phrase.
const DERIVE_SALT: &[u8] = b"luna-backup-v1";
/// Prefix for the bytes a signature covers, so a signature for one purpose never passes for another.
const SIG_PREFIX: &[u8] = b"luna-sig-v2\0";
/// HKDF label that turns a 32-byte signing seed into the ML-DSA seed beside the Ed25519 key.
const MLDSA_SEED_INFO: &[u8] = b"luna-mldsa-v1";
/// Ed25519 public key length.
const ED_PUBLIC_LEN: usize = 32;
/// ML-DSA-65 public key length.
const MLDSA_PUBLIC_LEN: usize = 1952;
/// Ed25519 signature length.
const ED_SIG_LEN: usize = 64;
/// ML-DSA-65 signature length.
const MLDSA_SIG_LEN: usize = 3309;
/// A public signing key: Ed25519 public key (32) ‖ ML-DSA-65 public key (1952).
pub const SIG_PUBLIC_LEN: usize = ED_PUBLIC_LEN + MLDSA_PUBLIC_LEN;
/// A signature: Ed25519 signature (64) ‖ ML-DSA-65 signature (3309). Valid only if both halves verify.
pub const SIG_LEN: usize = ED_SIG_LEN + MLDSA_SIG_LEN;

pub type SigPublic = [u8; SIG_PUBLIC_LEN];
pub type SigBytes = [u8; SIG_LEN];
/// HKDF label for the key that seals a copy to a user's public key.
const SEAL_INFO: &[u8] = b"luna-seal-v2";
const NONCE_LEN: usize = 24;
const TAG_LEN: usize = 16;
/// X25519 public key length.
const X25519_LEN: usize = 32;
/// ML-KEM-768 encapsulation (public) key length.
const MLKEM_PUBLIC_LEN: usize = 1184;
/// ML-KEM-768 ciphertext length.
const MLKEM_CT_LEN: usize = 1088;
/// ML-KEM-768 key seed length (FIPS 203 `d` then `z`).
const MLKEM_SEED_LEN: usize = 64;
/// A user's public sealing key: X25519 public key (32) ‖ ML-KEM-768 encapsulation key (1184).
pub const SEAL_PUBLIC_LEN: usize = X25519_LEN + MLKEM_PUBLIC_LEN;
/// A user's secret sealing key: clamped X25519 secret (32) ‖ ML-KEM-768 seed (64).
pub const SEAL_SECRET_LEN: usize = X25519_LEN + MLKEM_SEED_LEN;

pub type SealPublic = [u8; SEAL_PUBLIC_LEN];
pub type SealSecret = [u8; SEAL_SECRET_LEN];

/// Keys derived from one recovery phrase and one Luna id.
pub struct UserKeys {
    pub seal_secret: SealSecret,
    pub seal_public: SealPublic,
    pub self_key: [u8; 32],
    pub auth_secret: [u8; 32],
    pub auth_public: SigPublic,
}

/// HKDF info: label, a zero byte, then the Luna id.
fn derive_info(label: &[u8], luna_id: &str) -> Vec<u8> {
    let mut info = Vec::with_capacity(label.len() + 1 + luna_id.len());
    info.extend_from_slice(label);
    info.push(0);
    info.extend_from_slice(luna_id.as_bytes());
    info
}

fn hkdf_n<const N: usize>(ikm: &[u8], salt: Option<&[u8]>, info: &[u8]) -> [u8; N] {
    let hk = Hkdf::<Sha256>::new(salt, ikm);
    let mut out = [0u8; N];
    // HKDF-SHA256 allows up to 8160 bytes of output; every caller asks for 64 or fewer.
    hk.expand(info, &mut out)
        .expect("output length is within the HKDF-SHA256 limit");
    out
}

fn hkdf_32(ikm: &[u8], salt: Option<&[u8]>, info: &[u8]) -> [u8; 32] {
    hkdf_n::<32>(ikm, salt, info)
}

/// The ML-KEM-768 key for a 64-byte seed.
fn mlkem_key(seed: &[u8; MLKEM_SEED_LEN]) -> DecapsulationKey768 {
    DecapsulationKey768::from_seed(Seed::from(*seed))
}

/// Split a public sealing key into its X25519 and ML-KEM halves.
fn split_public(public: &SealPublic) -> (&[u8; X25519_LEN], &[u8; MLKEM_PUBLIC_LEN]) {
    let (x, k) = public.split_at(X25519_LEN);
    (
        x.try_into().expect("first half is X25519_LEN bytes"),
        k.try_into().expect("second half is MLKEM_PUBLIC_LEN bytes"),
    )
}

/// Derive the user's keys from the recovery phrase entropy: 16 bytes (12 words) or 32 bytes (24 words).
/// Every key comes from the same entropy, so the phrase's strength (128 or 256 bits) caps the
/// strength of all of them.
pub fn derive(entropy: &[u8], luna_id: &str) -> UserKeys {
    assert!(
        matches!(entropy.len(), 16 | 32),
        "recovery phrase entropy is 16 or 32 bytes"
    );
    let mut x25519_secret = hkdf_32(entropy, Some(DERIVE_SALT), &derive_info(b"x25519", luna_id));
    // Clamp as X25519 does, so the stored secret and its public key always agree.
    x25519_secret[0] &= 248;
    x25519_secret[31] &= 127;
    x25519_secret[31] |= 64;
    let x25519_public = PublicKey::from(&StaticSecret::from(x25519_secret)).to_bytes();
    let mlkem_seed =
        hkdf_n::<MLKEM_SEED_LEN>(entropy, Some(DERIVE_SALT), &derive_info(b"mlkem", luna_id));
    let mlkem_public = mlkem_key(&mlkem_seed).encapsulation_key().to_bytes();

    let mut seal_secret = [0u8; SEAL_SECRET_LEN];
    seal_secret[..X25519_LEN].copy_from_slice(&x25519_secret);
    seal_secret[X25519_LEN..].copy_from_slice(&mlkem_seed);
    let mut seal_public = [0u8; SEAL_PUBLIC_LEN];
    seal_public[..X25519_LEN].copy_from_slice(&x25519_public);
    seal_public[X25519_LEN..].copy_from_slice(&mlkem_public);

    let self_key = hkdf_32(entropy, Some(DERIVE_SALT), &derive_info(b"self", luna_id));

    let auth_secret = hkdf_32(entropy, Some(DERIVE_SALT), &derive_info(b"auth", luna_id));
    let auth_public = Signer::from_seed(auth_secret).public();

    UserKeys {
        seal_secret,
        seal_public,
        self_key,
        auth_secret,
        auth_public,
    }
}

/// Seal `msg` so only the holder of the secret half of `recipient_public` can open it.
/// Layout: ephemeral X25519 public key (32) ‖ ML-KEM ciphertext (1088) ‖ nonce (24) ‖ ciphertext and tag.
pub fn seal(recipient_public: &SealPublic, aad: &[u8], msg: &[u8]) -> Result<Vec<u8>> {
    let mut eph_secret = [0u8; 32];
    OsRng.fill_bytes(&mut eph_secret);
    let mut m = [0u8; 32];
    OsRng.fill_bytes(&mut m);
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    seal_inner(eph_secret, m, nonce, recipient_public, aad, msg)
}

/// Check that a recipient public key is usable: its X25519 half is not a low-order point (such a
/// key makes every shared secret the same, so anything sealed to it could be opened by anyone),
/// and its ML-KEM half passes the FIPS 203 encapsulation key check.
pub fn check_public_key(public: &SealPublic) -> Result<()> {
    let (x, k) = split_public(public);
    // Multiplying a low-order point by a clamped scalar gives the identity (all zeros).
    let probe = StaticSecret::from([0x42u8; 32]);
    if !probe
        .diffie_hellman(&PublicKey::from(*x))
        .was_contributory()
    {
        bail!("{BAD_KEY}");
    }
    EncapsulationKey768::new(&(*k).into()).map_err(|_| anyhow::anyhow!("{BAD_KEY}"))?;
    Ok(())
}

const BAD_KEY: &str = "This recovery key is not valid. Set up the recovery phrase again.";

/// `seal` with the ephemeral secret, ML-KEM message and nonce supplied by the caller (used by the vectors).
fn seal_inner(
    eph_secret: [u8; 32],
    m: [u8; 32],
    nonce: [u8; NONCE_LEN],
    recipient_public: &SealPublic,
    aad: &[u8],
    msg: &[u8],
) -> Result<Vec<u8>> {
    check_public_key(recipient_public)?;
    let (x_public, k_public) = split_public(recipient_public);

    let eph = StaticSecret::from(eph_secret);
    let eph_public = PublicKey::from(&eph).to_bytes();
    let shared_x = eph.diffie_hellman(&PublicKey::from(*x_public));
    if !shared_x.was_contributory() {
        bail!("{BAD_KEY}");
    }
    let ek =
        EncapsulationKey768::new(&(*k_public).into()).map_err(|_| anyhow::anyhow!("{BAD_KEY}"))?;
    let (mlkem_ct, shared_k) = ek.encapsulate_deterministic(&B32::from(m));
    let key = seal_key(
        shared_x.as_bytes(),
        shared_k.as_slice(),
        &eph_public,
        recipient_public,
        mlkem_ct.as_slice(),
    );

    let mut out = Vec::with_capacity(X25519_LEN + MLKEM_CT_LEN + NONCE_LEN + msg.len() + TAG_LEN);
    out.extend_from_slice(&eph_public);
    out.extend_from_slice(mlkem_ct.as_slice());
    out.extend_from_slice(&nonce);
    out.extend_from_slice(&aead_encrypt(&key, &nonce, aad, msg));
    Ok(out)
}

/// Open a sealed copy with the recipient's secret sealing key.
pub fn open(secret: &SealSecret, aad: &[u8], sealed: &[u8]) -> Result<Vec<u8>> {
    const HEAD: usize = X25519_LEN + MLKEM_CT_LEN + NONCE_LEN;
    if sealed.len() < HEAD + TAG_LEN {
        bail!("This sealed copy is too short to be valid.");
    }
    let eph_public: [u8; X25519_LEN] = sealed[..X25519_LEN]
        .try_into()
        .expect("slice has X25519_LEN bytes");
    let mlkem_ct = &sealed[X25519_LEN..X25519_LEN + MLKEM_CT_LEN];
    let nonce: [u8; NONCE_LEN] = sealed[X25519_LEN + MLKEM_CT_LEN..HEAD]
        .try_into()
        .expect("slice has NONCE_LEN bytes");
    let body = &sealed[HEAD..];

    let x_secret = StaticSecret::from(
        <[u8; X25519_LEN]>::try_from(&secret[..X25519_LEN])
            .expect("first half is X25519_LEN bytes"),
    );
    let seed: [u8; MLKEM_SEED_LEN] = secret[X25519_LEN..]
        .try_into()
        .expect("second half is MLKEM_SEED_LEN bytes");
    let dk = mlkem_key(&seed);

    let mut recipient_public = [0u8; SEAL_PUBLIC_LEN];
    recipient_public[..X25519_LEN].copy_from_slice(PublicKey::from(&x_secret).as_bytes());
    recipient_public[X25519_LEN..].copy_from_slice(&dk.encapsulation_key().to_bytes());

    let shared_x = x_secret.diffie_hellman(&PublicKey::from(eph_public));
    if !shared_x.was_contributory() {
        bail!("This sealed copy is not valid.");
    }
    let ct = ml_kem::kem::Ciphertext::<ml_kem::MlKem768>::try_from(mlkem_ct)
        .map_err(|_| anyhow::anyhow!("This sealed copy is not valid."))?;
    // ML-KEM never fails here: a wrong ciphertext gives an unrelated secret and the open fails below.
    let shared_k = dk.decapsulate(&ct);
    let key = seal_key(
        shared_x.as_bytes(),
        shared_k.as_slice(),
        &eph_public,
        &recipient_public,
        mlkem_ct,
    );
    aead_decrypt(&key, &nonce, aad, body)
        .map_err(|_| anyhow::anyhow!("This sealed copy could not be opened. It was changed, or it was sealed to a different key."))
}

/// HKDF over both shared secrets, bound to the ephemeral key, the ML-KEM ciphertext and the
/// recipient's whole public key (the ML-KEM half by its SHA-256).
fn seal_key(
    shared_x: &[u8; 32],
    shared_k: &[u8],
    eph_public: &[u8; X25519_LEN],
    recipient_public: &SealPublic,
    mlkem_ct: &[u8],
) -> [u8; 32] {
    let (recipient_x, recipient_k) = split_public(recipient_public);
    let mut ikm = Vec::with_capacity(64);
    ikm.extend_from_slice(shared_x);
    ikm.extend_from_slice(shared_k);
    let mut info = Vec::with_capacity(SEAL_INFO.len() + 2 * X25519_LEN + MLKEM_CT_LEN + 32);
    info.extend_from_slice(SEAL_INFO);
    info.extend_from_slice(eph_public);
    info.extend_from_slice(recipient_x);
    info.extend_from_slice(mlkem_ct);
    info.extend_from_slice(&Sha256::digest(recipient_k));
    hkdf_32(&ikm, None, &info)
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

/// The ML-DSA seed that goes with a 32-byte Ed25519 signing seed.
fn mldsa_seed(seed: &[u8; 32]) -> [u8; 32] {
    hkdf_32(seed, None, MLDSA_SEED_INFO)
}

/// A signing key: an Ed25519 key and an ML-DSA-65 key, both made from one 32-byte seed. Its secret is
/// never shown to a person; it lives in Luna's database and drives. A signature carries both
/// halves and is valid only if both verify, so a forger must break Ed25519 and ML-DSA.
pub struct Signer {
    key: SigningKey,
    mldsa: MlSigningKey<MlDsa65>,
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
            mldsa: MlSigningKey::<MlDsa65>::from_seed(&mldsa_seed(&seed).into()),
        }
    }

    pub fn seed(&self) -> [u8; 32] {
        self.key.to_bytes()
    }

    pub fn public(&self) -> SigPublic {
        let mut out = [0u8; SIG_PUBLIC_LEN];
        out[..ED_PUBLIC_LEN].copy_from_slice(&self.key.verifying_key().to_bytes());
        out[ED_PUBLIC_LEN..].copy_from_slice(&self.mldsa.verifying_key().encode());
        out
    }

    /// Sign `msg` under `domain`. The signed bytes are `SIG_PREFIX ‖ domain ‖ 0x00 ‖ msg`.
    /// Both signatures are deterministic, so the same input always gives the same bytes.
    pub fn sign(&self, domain: &str, msg: &[u8]) -> SigBytes {
        let signed = signed_bytes(domain, msg);
        let mut out = [0u8; SIG_LEN];
        out[..ED_SIG_LEN].copy_from_slice(&self.key.sign(&signed).to_bytes());
        let mldsa = self
            .mldsa
            .expanded_key()
            .sign_deterministic(&signed, b"")
            .expect("an empty context is always allowed");
        out[ED_SIG_LEN..].copy_from_slice(&mldsa.encode());
        out
    }
}

/// Check a signature made by `Signer::sign` with the same `domain`. Both halves must verify.
pub fn verify(public: &SigPublic, domain: &str, msg: &[u8], sig: &SigBytes) -> bool {
    let signed = signed_bytes(domain, msg);
    let ed_public: [u8; ED_PUBLIC_LEN] = public[..ED_PUBLIC_LEN]
        .try_into()
        .expect("first half is ED_PUBLIC_LEN bytes");
    let Ok(ed_key) = VerifyingKey::from_bytes(&ed_public) else {
        return false;
    };
    let ed_sig: [u8; ED_SIG_LEN] = sig[..ED_SIG_LEN]
        .try_into()
        .expect("first half is ED_SIG_LEN bytes");
    let ed_ok = ed_key
        .verify_strict(&signed, &Signature::from_bytes(&ed_sig))
        .is_ok();

    let Ok(encoded_key) = EncodedVerifyingKey::<MlDsa65>::try_from(&public[ED_PUBLIC_LEN..]) else {
        return false;
    };
    let Ok(encoded_sig) = EncodedSignature::<MlDsa65>::try_from(&sig[ED_SIG_LEN..]) else {
        return false;
    };
    let Some(mldsa_sig) = MlSignature::<MlDsa65>::decode(&encoded_sig) else {
        return false;
    };
    let mldsa_ok = MlVerifyingKey::<MlDsa65>::decode(&encoded_key)
        .verify_with_context(&signed, b"", &mldsa_sig);
    ed_ok && mldsa_ok
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

/// Read 12 or 24 English recovery words (case and extra spaces ignored) into their 16 or 32 bytes of entropy.
pub fn phrase_to_entropy(words: &str) -> Result<Vec<u8>> {
    let words: Vec<String> = words.split_whitespace().map(str::to_lowercase).collect();
    if words.len() != 12 && words.len() != 24 {
        bail!(
            "Your recovery phrase has {} words. It needs 12 or 24.",
            words.len()
        );
    }
    for word in &words {
        if Language::English.find_word(word).is_none() {
            bail!("That word isn't on the recovery phrase list: {word}");
        }
    }
    let phrase = words.join(" ");
    let count = words.len();
    let mnemonic = Mnemonic::parse_in_normalized(Language::English, &phrase).map_err(|_| {
        anyhow::anyhow!("These {count} words don't form a valid recovery phrase. Check each word.")
    })?;
    Ok(mnemonic.to_entropy())
}

/// The 12 or 24 English words for 16 or 32 bytes of entropy.
pub fn entropy_to_phrase(entropy: &[u8]) -> String {
    // 16 and 32 bytes are valid BIP39 entropy lengths.
    Mnemonic::from_entropy_in(Language::English, entropy)
        .expect("16 or 32 bytes is a valid BIP39 entropy length")
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
        let recipient_public = keys.seal_public;
        let sealed = seal_inner(
            [0x11; 32],
            [0x55; 32],
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
        let long_entropy: [u8; 32] = std::array::from_fn(|i| i as u8);
        let long_keys = derive(&long_entropy, LUNA_ID);
        json!({
            "long": {
                "entropy": hex(&long_entropy),
                "phrase": entropy_to_phrase(&long_entropy),
                "seal_secret": hex(&long_keys.seal_secret),
                "seal_public": hex(&long_keys.seal_public),
                "self_key": hex(&long_keys.self_key),
                "auth_public": hex(&long_keys.auth_public),
            },
            "entropy": hex(&entropy()),
            "luna_id": LUNA_ID,
            "phrase": entropy_to_phrase(&entropy()),
            "seal_secret": hex(&keys.seal_secret),
            "seal_public": hex(&keys.seal_public),
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
                "mlkem_message": hex(&[0x55; 32]),
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
        assert_eq!(a.seal_public, b.seal_public);
        assert_eq!(a.self_key, b.self_key);
        let other = derive(&entropy(), "luna-test-2");
        assert_ne!(a.seal_public, other.seal_public);
        assert_ne!(a.self_key, other.self_key);
        assert_ne!(a.auth_public, other.auth_public);
    }

    #[test]
    fn seal_secret_is_clamped() {
        let k = derive(&entropy(), LUNA_ID);
        assert_eq!(k.seal_secret[0] & 7, 0);
        assert_eq!(k.seal_secret[31] & 0x80, 0);
        assert_eq!(k.seal_secret[31] & 0x40, 0x40);
    }

    #[test]
    fn seal_open_round_trip() {
        let k = derive(&entropy(), LUNA_ID);
        let sealed = seal(&k.seal_public, b"aad", b"hello").unwrap();
        assert_eq!(open(&k.seal_secret, b"aad", &sealed).unwrap(), b"hello");
    }

    #[test]
    fn seal_refuses_low_order_recipient_keys() {
        let k = derive(&entropy(), LUNA_ID);
        // All zeros is the identity point, and so is the order-2 point u = 1.
        for low_order in [[0u8; 32], {
            let mut one = [0u8; 32];
            one[0] = 1;
            one
        }] {
            let mut bad = k.seal_public;
            bad[..32].copy_from_slice(&low_order);
            assert!(seal(&bad, b"aad", b"key").is_err());
            assert!(check_public_key(&bad).is_err());
        }
        assert!(check_public_key(&k.seal_public).is_ok());
        assert!(seal(&k.seal_public, b"aad", b"key").is_ok());
    }

    #[test]
    fn seal_refuses_an_invalid_mlkem_public_key() {
        let k = derive(&entropy(), LUNA_ID);
        // A coefficient of 0xfff is not below the modulus, so FIPS 203 rejects the key.
        let mut bad = k.seal_public;
        bad[32] = 0xff;
        bad[33] |= 0x0f;
        assert!(check_public_key(&bad).is_err());
        assert!(seal(&bad, b"aad", b"key").is_err());
    }

    #[test]
    fn a_copy_needs_both_secrets_to_open() {
        let k = derive(&entropy(), LUNA_ID);
        let other = derive(&[9u8; 16], LUNA_ID);
        let sealed = seal(&k.seal_public, b"aad", b"hello").unwrap();
        // Right X25519 secret with someone else's ML-KEM seed, and the other way round.
        let mut only_x = k.seal_secret;
        only_x[32..].copy_from_slice(&other.seal_secret[32..]);
        let mut only_k = other.seal_secret;
        only_k[32..].copy_from_slice(&k.seal_secret[32..]);
        assert!(open(&only_x, b"aad", &sealed).is_err());
        assert!(open(&only_k, b"aad", &sealed).is_err());
        assert_eq!(open(&k.seal_secret, b"aad", &sealed).unwrap(), b"hello");
    }

    #[test]
    fn sealed_copy_has_the_documented_layout() {
        let k = derive(&entropy(), LUNA_ID);
        let sealed = seal(&k.seal_public, b"aad", b"hello").unwrap();
        assert_eq!(sealed.len(), 32 + 1088 + 24 + 5 + 16);
    }

    #[test]
    fn open_rejects_wrong_key_aad_and_tampering() {
        let k = derive(&entropy(), LUNA_ID);
        let other = derive(&[9u8; 16], LUNA_ID);
        let sealed = seal(&k.seal_public, b"aad", b"hello").unwrap();
        assert!(open(&other.seal_secret, b"aad", &sealed).is_err());
        assert!(open(&k.seal_secret, b"other", &sealed).is_err());
        let mut tampered = sealed.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 1;
        assert!(open(&k.seal_secret, b"aad", &tampered).is_err());
        assert!(open(&k.seal_secret, b"aad", &sealed[..10]).is_err());
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
    fn a_signature_needs_both_halves_to_verify() {
        let signer = Signer::from_seed([3u8; 32]);
        let public = signer.public();
        let sig = signer.sign("snapshot", b"record");
        assert_eq!(sig.len(), SIG_LEN);
        assert_eq!(public.len(), SIG_PUBLIC_LEN);
        assert!(verify(&public, "snapshot", b"record", &sig));

        // Corrupt only the Ed25519 half, then only the ML-DSA half.
        let mut ed_bad = sig;
        ed_bad[0] ^= 1;
        assert!(!verify(&public, "snapshot", b"record", &ed_bad));
        let mut ml_bad = sig;
        ml_bad[SIG_LEN - 1] ^= 1;
        assert!(!verify(&public, "snapshot", b"record", &ml_bad));
        let mut ml_zero = sig;
        ml_zero[ED_SIG_LEN..].fill(0);
        assert!(!verify(&public, "snapshot", b"record", &ml_zero));

        // A key whose ML-DSA half belongs to someone else does not verify either.
        let other = Signer::from_seed([4u8; 32]).public();
        let mut mixed = public;
        mixed[ED_PUBLIC_LEN..].copy_from_slice(&other[ED_PUBLIC_LEN..]);
        assert!(!verify(&mixed, "snapshot", b"record", &sig));
        let mut mixed_ed = public;
        mixed_ed[..ED_PUBLIC_LEN].copy_from_slice(&other[..ED_PUBLIC_LEN]);
        assert!(!verify(&mixed_ed, "snapshot", b"record", &sig));
    }

    #[test]
    fn signing_is_deterministic() {
        let signer = Signer::from_seed([3u8; 32]);
        assert_eq!(
            signer.sign("snapshot", b"record"),
            signer.sign("snapshot", b"record")
        );
        assert_eq!(signer.public(), Signer::from_seed([3u8; 32]).public());
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
        assert_eq!(phrase_to_entropy(&phrase).unwrap(), vec![0u8; 16]);
    }

    #[test]
    fn phrase_round_trips_and_ignores_case_and_spacing() {
        let phrase = entropy_to_phrase(&entropy());
        let messy = format!("  {}  ", phrase.to_uppercase().replace(' ', "   "));
        assert_eq!(phrase_to_entropy(&messy).unwrap(), entropy().to_vec());
    }

    #[test]
    fn twenty_four_word_phrase_round_trips_and_derives_its_own_keys() {
        let long: [u8; 32] = std::array::from_fn(|i| i as u8);
        let phrase = entropy_to_phrase(&long);
        assert_eq!(phrase.split(' ').count(), 24);
        assert_eq!(phrase_to_entropy(&phrase).unwrap(), long.to_vec());
        let k = derive(&long, LUNA_ID);
        let short = derive(&entropy(), LUNA_ID);
        assert_ne!(k.seal_public, short.seal_public);
        let sealed = seal(&k.seal_public, b"aad", b"hello").unwrap();
        assert_eq!(open(&k.seal_secret, b"aad", &sealed).unwrap(), b"hello");
    }

    #[test]
    fn phrase_of_the_wrong_length_or_checksum_is_refused_plainly() {
        let long = entropy_to_phrase(&[7u8; 32]);
        let err = phrase_to_entropy(&long.replace("  ", " "))
            .map(|_| ())
            .err();
        assert!(err.is_none());
        let eighteen = vec!["abandon"; 18].join(" ");
        assert_eq!(
            phrase_to_entropy(&eighteen).unwrap_err().to_string(),
            "Your recovery phrase has 18 words. It needs 12 or 24."
        );
        let bad_long = vec!["abandon"; 24].join(" ");
        assert_eq!(
            phrase_to_entropy(&bad_long).unwrap_err().to_string(),
            "These 24 words don't form a valid recovery phrase. Check each word."
        );
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
            "Your recovery phrase has 2 words. It needs 12 or 24."
        );
    }
}
