//! Windows self-update: signed feed check, checked download, run the installer.
//!
//! Linux gets updates from our Flatpak repo (the software center), so nothing
//! here runs there. The feed check and the "is there something newer?"
//! decision compile and test everywhere; only starting the installer is
//! `cfg(windows)`. Rules: `infra/ci-source/internal/feed/README.md` ("Rules for every
//! receiver"); the signature, replay and version rules live in
//! `luna_feed`.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

use luna_feed::{self as feed, FeedError, Part};
use serde::{Deserialize, Serialize};

use crate::session;

pub const UNIT: &str = "luna-desktop";
/// The feed part (and the file inside it) for the Windows installer.
pub const PART: &str = "windows";
pub const OS: &str = "windows";
pub const ARCH: &str = "amd64";
pub const FEED_BASE: &str =
    "https://gt.plainskill.net/LibreLoom/LibreServ/raw/branch/feeds/luna-desktop";
const SLOT_MARK: &[u8; 24] = b"LUNA-DESKTOP-VERSION-V1:";
const SLOT_VERSION_LEN: usize = 64;
const SLOT_LEN: usize = SLOT_MARK.len() + SLOT_VERSION_LEN;

/// The version lives in a fixed-size slot of the binary: a marker, then up to
/// 64 bytes of version padded with NULs. A normal build fills it from
/// `desktop/VERSION` (strict semver, checked by build.rs). The release build
/// (`LUNA_DESKTOP_VERSION_PATCH` set) leaves it empty and the release tool
/// writes the version into the finished binary (packaging/patch-version.py), so
/// a new version recompiles and relinks nothing.
#[used]
static VERSION_SLOT: [u8; SLOT_LEN] = version_slot(env!("LUNA_DESKTOP_APP_VERSION"));

const fn version_slot(version: &str) -> [u8; SLOT_LEN] {
    let v = version.as_bytes();
    assert!(v.len() <= SLOT_VERSION_LEN, "version longer than its slot");
    let mut out = [0u8; SLOT_LEN];
    let mut i = 0;
    while i < SLOT_MARK.len() {
        out[i] = SLOT_MARK[i];
        i += 1;
    }
    let mut j = 0;
    while j < v.len() {
        out[SLOT_MARK.len() + j] = v[j];
        j += 1;
    }
    out
}

/// The app's version (see [`VERSION_SLOT`]).
pub fn app_version() -> &'static str {
    static V: std::sync::OnceLock<&'static str> = std::sync::OnceLock::new();
    V.get_or_init(|| {
        // Volatile: the compiler must not fold the slot's build-time bytes in,
        // because a release build patches them after linking.
        // SAFETY: the pointer is to a live static of exactly SLOT_LEN bytes.
        let slot: [u8; SLOT_LEN] = unsafe { std::ptr::read_volatile(&raw const VERSION_SLOT) };
        let v = &slot[SLOT_MARK.len()..];
        let end = v.iter().position(|&b| b == 0).unwrap_or(v.len());
        match std::str::from_utf8(&v[..end]) {
            Ok(s) if !s.is_empty() => Box::leak(s.to_owned().into_boxed_str()),
            _ => "unpatched",
        }
    })
}

/// Luna's release key, pinned into the build. Windows only: the Linux Flatpak
/// build never reads the feed, and the file sits outside `luna/desktop`.
#[cfg(windows)]
pub const FEED_KEY: &str = include_str!("../../../keys/lsluna.minisign.pub");
/// Never used off Windows (no check runs there); empty trusts nothing.
#[cfg(not(windows))]
pub const FEED_KEY: &str = "";

/// How often the background check runs.
pub const CHECK_EVERY: Duration = Duration::from_secs(6 * 60 * 60);

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    #[default]
    Stable,
    Beta,
}

impl Channel {
    pub fn as_str(self) -> &'static str {
        match self {
            Channel::Stable => "stable",
            Channel::Beta => "beta",
        }
    }
}

/// What is remembered between runs (`update-state.json` in the data folder).
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Stored {
    #[serde(default)]
    pub channel: Channel,
    /// Newest `published` seen, keyed `<unit>/<channel>`, so switching channel
    /// never trips the replay rule.
    #[serde(default)]
    pub seen: BTreeMap<String, String>,
}

fn state_path() -> PathBuf {
    session::data_dir().join("update-state.json")
}

pub fn load() -> Stored {
    std::fs::read(state_path())
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}

pub fn save(stored: &Stored) -> Result<(), String> {
    let dir = session::data_dir();
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let json = serde_json::to_vec_pretty(stored).map_err(|e| e.to_string())?;
    let tmp = dir.join("update-state.json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    std::fs::rename(tmp, state_path()).map_err(|e| e.to_string())
}

pub fn set_channel(channel: Channel) -> Result<(), String> {
    let mut stored = load();
    stored.channel = channel;
    save(&stored)
}

/// A newer installer the feed offers.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Available {
    pub version: String,
    pub notes: String,
    pub part: Part,
}

fn seen_key(channel: Channel) -> String {
    format!("{UNIT}/{}", channel.as_str())
}

/// The decision: verify the feed bytes and say whether a newer Windows
/// installer is on offer. Records the feed's `published` in `stored` when it
/// is newer than what was seen (the caller saves). Never offers an equal or
/// lower version.
pub fn decide(
    feed_bytes: &[u8],
    sig: &[u8],
    keys: &[&str],
    channel: Channel,
    installed_version: &str,
    stored: &mut Stored,
) -> Result<Option<Available>, FeedError> {
    let key = seen_key(channel);
    let seen = stored.seen.get(&key).cloned().unwrap_or_default();
    let verified = feed::check(
        feed_bytes,
        sig,
        keys,
        &feed::Request {
            unit: UNIT,
            channel: channel.as_str(),
            part: PART,
            os: OS,
            arch: ARCH,
            installed_version,
            newest_published_seen: &seen,
        },
    )?;
    if verified.feed.published > seen {
        stored.seen.insert(key, verified.feed.published.clone());
    }
    if !verified.newer {
        return Ok(None);
    }
    Ok(Some(Available {
        version: verified.feed.version,
        notes: verified.feed.notes,
        part: verified.part,
    }))
}

/// [`decide`] on feed files fetched with `fetch` (feed URL -> body).
pub fn check_with(
    fetch: &dyn Fn(&str) -> Result<Vec<u8>, String>,
    feed_base: &str,
    keys: &[&str],
    channel: Channel,
    installed_version: &str,
    stored: &mut Stored,
) -> Result<Option<Available>, String> {
    let url = format!("{feed_base}/{}.json", channel.as_str());
    let body = fetch(&url)?;
    let sig = fetch(&format!("{url}.minisig"))?;
    decide(&body, &sig, keys, channel, installed_version, stored).map_err(|e| plain_feed_error(&e))
}

/// Ask the real feed. Reads and saves the replay state in the data folder.
pub fn check_latest() -> Result<Option<Available>, String> {
    let mut stored = load();
    let channel = stored.channel;
    let before = stored.clone();
    let found = check_with(
        &http_get,
        FEED_BASE,
        &[FEED_KEY],
        channel,
        app_version(),
        &mut stored,
    )?;
    if stored != before {
        save(&stored).map_err(|e| format!("Couldn't save the update check: {e}"))?;
    }
    Ok(found)
}

fn http_get(url: &str) -> Result<Vec<u8>, String> {
    let agent = ureq::Agent::new_with_config(
        ureq::Agent::config_builder()
            .timeout_connect(Some(Duration::from_secs(10)))
            .timeout_global(Some(Duration::from_secs(30)))
            .build(),
    );
    let mut resp = agent
        .get(url)
        .call()
        .map_err(|_| "Couldn't reach the update server.".to_string())?;
    resp.body_mut()
        .with_config()
        .limit(1024 * 1024)
        .read_to_vec()
        .map_err(|_| "Couldn't read the update list.".to_string())
}

/// Plain words for a refused feed or download.
pub fn plain_feed_error(e: &FeedError) -> String {
    match e {
        FeedError::BadSignature | FeedError::Malformed(_) | FeedError::BadVersion(_) => {
            "The update list didn't pass its safety check, so it was ignored.".into()
        }
        FeedError::UnknownFormat(_) => {
            "The update list is from a newer kind than this app understands. Install the latest Luna Desktop by hand.".into()
        }
        FeedError::WrongUnit | FeedError::WrongChannel | FeedError::Replayed => {
            "The update list didn't match what this app asked for, so it was ignored.".into()
        }
        FeedError::MissingPart => "There is no Windows update in the update list.".into(),
        FeedError::SizeMismatch | FeedError::ShaMismatch => {
            "The downloaded update didn't pass its safety check, so it wasn't kept.".into()
        }
        FeedError::AllUrlsFailed => {
            "Couldn't download the update. Check your internet connection.".into()
        }
        FeedError::Io(_) => "Couldn't save the update on this computer.".into(),
    }
}

/// Where downloaded installers go: inside the app's own data folder, which is
/// private to the signed-in Windows user.
pub fn updates_dir() -> PathBuf {
    session::data_dir().join("updates")
}

/// Download the installer (size and SHA-256 checked) and return its path.
/// Older downloads are cleared first.
pub fn download(avail: &Available) -> Result<PathBuf, String> {
    let dir = updates_dir();
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).map_err(|_| plain_feed_error(&FeedError::Io(String::new())))?;
    // The version is strict semver (feed::check), so this is a safe file name.
    let dest = dir.join(format!("Luna-Desktop-Setup-{}-x86_64.exe", avail.version));
    feed::download(&avail.part, &dest, Duration::from_secs(600))
        .map_err(|e| plain_feed_error(&e))?;
    Ok(dest)
}

/// Start the installer quietly, in this app's own folder, and let it outlive
/// this process. The caller quits the app right after; the installer waits for
/// the old files to be released, then starts the app again.
///
/// NSIS needs `/D=` last, unquoted (spaces are fine there).
#[cfg(windows)]
pub fn run_installer(installer: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;

    const DETACHED_PROCESS: u32 = 0x0000_0008;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;

    let dir = std::env::current_exe()
        .ok()
        .and_then(|exe| exe.parent().map(Path::to_path_buf))
        .ok_or_else(|| "Couldn't find where Luna Desktop is installed.".to_string())?;
    std::process::Command::new(installer)
        .arg("/S")
        .raw_arg(format!("/D={}", dir.display()))
        .creation_flags(DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP)
        .spawn()
        .map(|_| ())
        .map_err(|_| "Couldn't start the installer.".to_string())
}

#[cfg(not(windows))]
pub fn run_installer(_installer: &Path) -> Result<(), String> {
    Err("Luna Desktop updates itself on Windows only. Use your software center.".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::session::test_env;

    fn testdata() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../infra/feed-testdata")
    }

    fn test_key() -> String {
        std::fs::read_to_string(testdata().join("test-key.pub")).unwrap()
    }

    fn read(name: &str) -> Vec<u8> {
        std::fs::read(testdata().join(name)).unwrap()
    }

    fn windows_feed(installed: &str, stored: &mut Stored) -> Result<Option<Available>, FeedError> {
        let key = test_key();
        decide(
            &read("luna-desktop-stable.json"),
            &read("luna-desktop-stable.json.minisig"),
            &[key.as_str()],
            Channel::Stable,
            installed,
            stored,
        )
    }

    #[test]
    fn desktop_windows_update() {
        // cases.json: desktop-windows-update
        let mut stored = Stored::default();
        let a = windows_feed("0.3.0", &mut stored)
            .unwrap()
            .expect("an update");
        assert_eq!(a.version, "0.4.0");
        assert_eq!(a.notes, "Test release 0.4.0");
        assert_eq!(a.part.name, "windows");
        assert_eq!(a.part.file, "Luna-Desktop-Setup-x86_64.exe");
        assert_eq!(
            stored.seen.get("luna-desktop/stable").map(String::as_str),
            Some("2026-10-12T14:03:00Z")
        );
    }

    #[test]
    fn same_or_newer_installed_means_no_update() {
        let mut stored = Stored::default();
        assert_eq!(windows_feed("0.4.0", &mut stored).unwrap(), None);
        assert_eq!(windows_feed("0.5.0", &mut stored).unwrap(), None);
    }

    #[test]
    fn replayed_feed_is_refused_and_seen_is_not_lowered() {
        let mut stored = Stored::default();
        stored
            .seen
            .insert("luna-desktop/stable".into(), "2027-01-01T00:00:00Z".into());
        let err = windows_feed("0.3.0", &mut stored).unwrap_err();
        assert_eq!(err, FeedError::Replayed);
        assert_eq!(stored.seen["luna-desktop/stable"], "2027-01-01T00:00:00Z");
    }

    #[test]
    fn other_channels_seen_does_not_matter() {
        let mut stored = Stored::default();
        stored
            .seen
            .insert("luna-desktop/beta".into(), "2027-01-01T00:00:00Z".into());
        assert!(windows_feed("0.3.0", &mut stored).unwrap().is_some());
    }

    #[test]
    fn wrong_key_and_tampered_feed_are_refused() {
        let key = test_key();
        let mut stored = Stored::default();
        let tampered = decide(
            &read("luna-stable.tampered.json"),
            &read("luna-stable.tampered.json.minisig"),
            &[key.as_str()],
            Channel::Stable,
            "0.3.0",
            &mut stored,
        );
        assert_eq!(tampered.unwrap_err(), FeedError::BadSignature);
        // Signed by the test key, but not a key this build trusts.
        let other = std::fs::read_to_string(
            PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../keys/lsluna.minisign.pub"),
        )
        .unwrap();
        let other = other.as_str();
        let wrong = decide(
            &read("luna-desktop-stable.json"),
            &read("luna-desktop-stable.json.minisig"),
            &[other],
            Channel::Stable,
            "0.3.0",
            &mut stored,
        );
        assert_eq!(wrong.unwrap_err(), FeedError::BadSignature);
        assert!(stored.seen.is_empty());
    }

    #[test]
    fn another_products_feed_is_refused() {
        let key = test_key();
        let mut stored = Stored::default();
        let r = decide(
            &read("luna-stable.json"),
            &read("luna-stable.json.minisig"),
            &[key.as_str()],
            Channel::Stable,
            "0.3.0",
            &mut stored,
        );
        assert_eq!(r.unwrap_err(), FeedError::WrongUnit);
    }

    #[test]
    fn asking_for_the_other_channel_is_refused() {
        let key = test_key();
        let mut stored = Stored::default();
        let r = decide(
            &read("luna-desktop-stable.json"),
            &read("luna-desktop-stable.json.minisig"),
            &[key.as_str()],
            Channel::Beta,
            "0.3.0",
            &mut stored,
        );
        assert_eq!(r.unwrap_err(), FeedError::WrongChannel);
    }

    #[test]
    fn check_with_fetches_the_channel_files() {
        let key = test_key();
        let asked = std::cell::RefCell::new(Vec::new());
        let fetch = |url: &str| -> Result<Vec<u8>, String> {
            asked.borrow_mut().push(url.to_string());
            Ok(if url.ends_with(".minisig") {
                read("luna-desktop-stable.json.minisig")
            } else {
                read("luna-desktop-stable.json")
            })
        };
        let mut stored = Stored::default();
        let found = check_with(
            &fetch,
            "https://feeds.example/luna-desktop",
            &[key.as_str()],
            Channel::Stable,
            "0.3.0",
            &mut stored,
        )
        .unwrap();
        assert!(found.is_some());
        assert_eq!(
            *asked.borrow(),
            vec![
                "https://feeds.example/luna-desktop/stable.json".to_string(),
                "https://feeds.example/luna-desktop/stable.json.minisig".to_string()
            ]
        );
        let failing = |_: &str| -> Result<Vec<u8>, String> { Err("offline".into()) };
        assert_eq!(
            check_with(
                &failing,
                "x",
                &[key.as_str()],
                Channel::Stable,
                "0.3.0",
                &mut stored
            )
            .unwrap_err(),
            "offline"
        );
    }

    #[test]
    fn state_round_trips_in_the_data_folder() {
        let _g = test_env::lock();
        let dir = tempfile::tempdir().unwrap();
        unsafe { std::env::set_var("LUNA_DESKTOP_DATA", dir.path()) };
        assert_eq!(load(), Stored::default());
        set_channel(Channel::Beta).unwrap();
        let mut s = load();
        assert_eq!(s.channel, Channel::Beta);
        s.seen
            .insert("luna-desktop/beta".into(), "2026-10-12T14:03:00Z".into());
        save(&s).unwrap();
        assert_eq!(load(), s);
        unsafe { std::env::remove_var("LUNA_DESKTOP_DATA") };
    }

    #[test]
    fn app_version_is_strict_semver() {
        assert!(feed::parse_version(app_version()).is_ok());
    }
}
