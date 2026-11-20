//! The key store (lair): where the device's signing key lives.
//!
//! The lines library starts and stops the key store process. This module is
//! the app's side of it: connecting with the passphrase, putting the
//! device's seed in, and keeping the key store's config pointing at its
//! folder when a profile moves.
//!
//! For a fork: nothing to change here.

use std::path::Path;
use std::sync::Arc;

/// Make `lair-keystore-config.yaml` point at the directory it now lives in.
///
/// Lair writes three absolute paths at init: `connectionUrl`
/// (`unix://<dir>/socket?k=...`), `pidFile` and `storeFile`. The URL's path
/// is PERCENT-ENCODED (`Application%20Support` on every Mac), so replacing
/// the old directory as plain text fixes the two file paths and silently
/// leaves the socket address behind. This parses the URL instead, compares
/// decoded paths, and lets the URL type do the encoding. Idempotent - safe
/// on every start, and it repairs a config left stale by an earlier move.
pub(crate) fn repoint_config(lair_dir: &Path) -> Result<bool, String> {
    let config_path = lair_dir.join("lair-keystore-config.yaml");
    if !config_path.exists() {
        return Ok(false);
    }
    let content = std::fs::read_to_string(&config_path)
        .map_err(|e| format!("lair config unreadable: {e}"))?;
    let mut changed = false;
    let mut out: Vec<String> = Vec::new();
    for line in content.lines() {
        let trimmed = line.trim_start();
        let indent = &line[..line.len() - trimmed.len()];
        if let Some(rest) = trimmed.strip_prefix("connectionUrl:") {
            let raw = rest.trim();
            if let Ok(mut url) = lair_keystore_api::dependencies::url::Url::parse(raw) {
                if url.scheme() == "unix" {
                    let decoded = percent_encoding::percent_decode_str(url.path())
                        .decode_utf8_lossy()
                        .to_string();
                    let expected = lair_dir.join("socket");
                    let decoded = Path::new(&decoded);
                    // A socket already moved to the short runtime path for
                    // THIS root (see `ensure_socket_fits`) is where it
                    // belongs; only a foreign address is pulled back here.
                    #[cfg(not(windows))]
                    let at_runtime_path = decoded == runtime_socket_path(lair_dir);
                    #[cfg(windows)]
                    let at_runtime_path = false;
                    if decoded != expected && !at_runtime_path {
                        url.set_path(&expected.to_string_lossy());
                        out.push(format!("{indent}connectionUrl: {url}"));
                        changed = true;
                        continue;
                    }
                }
            }
        } else {
            let mut handled = false;
            for (key, file) in [("pidFile:", "pid_file"), ("storeFile:", "store_file")] {
                if let Some(rest) = trimmed.strip_prefix(key) {
                    let expected = lair_dir.join(file);
                    if Path::new(rest.trim()) != expected {
                        out.push(format!("{indent}{key} {}", expected.display()));
                        changed = true;
                        handled = true;
                    }
                    break;
                }
            }
            if handled {
                continue;
            }
        }
        out.push(line.to_string());
    }
    if !changed {
        return Ok(false);
    }
    let tmp = config_path.with_extension("yaml.tmp");
    std::fs::write(&tmp, out.join("\n") + "\n").map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &config_path).map_err(|e| e.to_string())?;
    log::info!("[lair] key store config repointed to {:?}", lair_dir);
    Ok(true)
}

/// The key store's short socket for a profile: named after the profile's
/// own folder, so two profiles never share one.
#[cfg(not(windows))]
pub(crate) fn runtime_socket_path(lair_dir: &Path) -> std::path::PathBuf {
    crate::profiles::short_socket_path(lair_dir.parent().unwrap_or(lair_dir))
}

/// How long one connection to the key store may take. Without a limit, a
/// key store that accepted the connection and never answered
/// used to hold the start forever.
const CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

#[cfg(test)]
fn read_connection_url(config_path: &Path) -> Result<String, String> {
    let content = std::fs::read_to_string(config_path).map_err(|e| format!("Failed to read lair config at {:?}: {}", config_path, e))?;
    content
        .lines()
        .find_map(|l| l.trim().strip_prefix("connectionUrl:").map(|u| u.trim().to_string()))
        .ok_or_else(|| format!("No connectionUrl found in lair config: {:?}", config_path))
}

/// Connect to the running key store. One attempt: the start retries it.
pub async fn connect_to_lair(
    connection_url: &str,
    passphrase: &str,
) -> Result<lair_keystore_api::prelude::LairClient, String> {
    let url = lair_keystore_api::dependencies::url::Url::parse(connection_url)
        .map_err(|e| format!("Invalid lair connection URL: {}", e))?;
    let passphrase_array: lair_keystore_api::prelude::SharedLockedArray = Arc::new(std::sync::Mutex::new(
        lair_keystore_api::dependencies::sodoken::LockedArray::from(
            passphrase.as_bytes().to_vec(),
        ),
    ));
    match tokio::time::timeout(CONNECT_TIMEOUT, lair_keystore_api::ipc_keystore_connect(url, passphrase_array)).await {
        Ok(r) => r.map_err(|e| format!("Failed to connect to lair: {}", e)),
        Err(_) => Err(format!("Lair did not answer within {}s", CONNECT_TIMEOUT.as_secs())),
    }
}

/// Put a 32-byte seed into the key store under `tag` and return its public
/// key. The key store takes a seed only sealed to a key it controls; this
/// does that. An existing entry under `tag` is returned as it is.
pub async fn import_seed_to_lair(
    client: &lair_keystore_api::prelude::LairClient,
    seed_bytes: &[u8; 32],
    tag: &str,
) -> Result<[u8; 32], String> {
    use lair_keystore_api::dependencies::sodoken;
    use lair_keystore_api::prelude::{BinDataSized, LairEntryInfo};
    if let Ok(LairEntryInfo::Seed { seed_info, .. }) = client.get_entry(tag.into()).await {
        log::info!("Seed '{}' already exists in lair, reusing", tag);
        return Ok(*seed_info.ed25519_pub_key.0);
    }
    let helper = match client.new_seed("_import_helper".into(), None, false).await {
        Ok(h) => h,
        Err(_) => match client.get_entry("_import_helper".into()).await {
            Ok(LairEntryInfo::Seed { seed_info, .. }) => seed_info,
            _ => return Err("Failed to create or fetch _import_helper seed".into()),
        },
    };
    let mut sender_pub = [0u8; sodoken::crypto_box::XSALSA_PUBLICKEYBYTES];
    let mut sender_sec =
        sodoken::SizedLockedArray::<{ sodoken::crypto_box::XSALSA_SECRETKEYBYTES }>::new()
            .map_err(|e| e.to_string())?;
    sodoken::crypto_box::xsalsa_keypair(&mut sender_pub, &mut *sender_sec.lock())
        .map_err(|e| e.to_string())?;
    let mut nonce = [0u8; sodoken::crypto_box::XSALSA_NONCEBYTES];
    sodoken::random::randombytes_buf(&mut nonce).map_err(|e| e.to_string())?;
    let recipient_pub_bytes: &[u8; 32] = &*helper.x25519_pub_key.0;
    let mut cipher = vec![0u8; seed_bytes.len() + sodoken::crypto_box::XSALSA_MACBYTES];
    sodoken::crypto_box::xsalsa_easy(
        &mut cipher,
        seed_bytes,
        &nonce,
        recipient_pub_bytes,
        &*sender_sec.lock(),
    )
    .map_err(|e| e.to_string())?;
    let sender_pub_key = BinDataSized(Arc::new(sender_pub));
    let info = client
        .import_seed(
            sender_pub_key,
            helper.x25519_pub_key,
            None,
            nonce,
            cipher.into(),
            tag.into(),
            false,
        )
        .await
        .map_err(|e| format!("seed import into lair failed: {}", e))?;
    Ok(*info.ed25519_pub_key.0)
}

#[cfg(test)]
mod tests {

    /// The config lair writes on a Mac: the socket address is a URL, so the
    /// space in "Application Support" is `%20` there and a plain space in
    /// the two file paths.
    fn mac_style_config(dir: &Path) -> String {
        let url_path = dir.to_string_lossy().replace(' ', "%20");
        format!(
            "---\nconnectionUrl: unix://{url_path}/socket?k=AbC-123_x\npidFile: {0}/pid_file\nstoreFile: {0}/store_file\nsignatureFallback: none\n",
            dir.display()
        )
    }

    #[test]
    #[cfg(not(windows))]
    fn two_profiles_get_different_runtime_sockets() {
        let profiles = Path::new("/Users/someone/Library/Application Support/com.example.myapp/profiles");
        let one = super::runtime_socket_path(&profiles.join("0123456789abcdef").join("lair"));
        let other = super::runtime_socket_path(&profiles.join("fedcba9876543210").join("lair"));
        assert_ne!(one, other);
    }

    // Lair's unix:// socket addresses (macOS and Linux); a Windows named
    // pipe does not move with the folder.
    #[cfg(unix)]
    #[test]
    fn a_moved_key_store_is_repointed_when_its_path_has_a_space() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("Application Support").join("app").join("lair");
        let new = tmp.path().join("Application Support").join("app").join("profiles").join("local").join("lair");
        std::fs::create_dir_all(&new).unwrap();
        // Moved intact: the config still names the old directory everywhere.
        std::fs::write(new.join("lair-keystore-config.yaml"), mac_style_config(&old)).unwrap();

        assert_eq!(repoint_config(&new), Ok(true));
        let url = read_connection_url(&new.join("lair-keystore-config.yaml")).unwrap();
        let parsed = lair_keystore_api::dependencies::url::Url::parse(&url).unwrap();
        let decoded = percent_encoding::percent_decode_str(parsed.path()).decode_utf8_lossy().to_string();
        assert_eq!(Path::new(&decoded), new.join("socket"), "the socket address follows the move");
        assert!(url.contains("Application%20Support"), "and stays a valid encoded URL: {url}");
        assert!(url.ends_with("?k=AbC-123_x"), "the key in the address is kept: {url}");
        let after = std::fs::read_to_string(new.join("lair-keystore-config.yaml")).unwrap();
        assert!(after.contains(&format!("pidFile: {}", new.join("pid_file").display())));
        assert!(after.contains(&format!("storeFile: {}", new.join("store_file").display())));
        assert!(after.contains("signatureFallback: none"), "other settings untouched");
        // Idempotent: a second start changes nothing.
        assert_eq!(repoint_config(&new), Ok(false));
    }

    // Lair's unix:// socket addresses (macOS and Linux); a Windows named
    // pipe does not move with the folder.
    #[cfg(unix)]
    #[test]
    fn a_config_left_half_fixed_by_a_text_replace_is_healed() {
        // What a plain text replace leaves behind on a Mac: the two file paths moved,
        // the encoded socket address did not.
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("Application Support").join("app").join("lair");
        let new = tmp.path().join("Application Support").join("app").join("profiles").join("local").join("lair");
        std::fs::create_dir_all(&new).unwrap();
        let half = mac_style_config(&old).replace(
            &old.to_string_lossy().to_string(),
            &new.to_string_lossy().to_string(),
        );
        assert!(half.contains(&format!("pidFile: {}", new.join("pid_file").display())));
        assert!(half.contains("app/lair/socket"), "precondition: the socket address is still the old one");
        std::fs::write(new.join("lair-keystore-config.yaml"), half).unwrap();

        assert_eq!(repoint_config(&new), Ok(true));
        let url = read_connection_url(&new.join("lair-keystore-config.yaml")).unwrap();
        assert!(url.contains("profiles/local/lair/socket"), "{url}");
    }

    // Lair's unix:// socket addresses (macOS and Linux); a Windows named
    // pipe does not move with the folder.
    #[cfg(unix)]
    #[test]
    fn a_config_already_in_place_is_left_alone() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("Application Support").join("lair");
        std::fs::create_dir_all(&dir).unwrap();
        let original = mac_style_config(&dir);
        std::fs::write(dir.join("lair-keystore-config.yaml"), &original).unwrap();
        assert_eq!(repoint_config(&dir), Ok(false));
        assert_eq!(std::fs::read_to_string(dir.join("lair-keystore-config.yaml")).unwrap(), original);
    }


    use super::*;
}

#[cfg(all(test, not(windows)))]
mod socket_tests {

    #[test]
    fn a_profile_fits_when_only_the_runtime_socket_does() {
        let tmp = tempfile::tempdir().unwrap();
        let root = tmp.path().join("y".repeat(110));
        assert!(!crate::profiles::in_root_socket_fits(&root));
        assert!(crate::profiles::lair_socket_path_fits(&root), "the short socket carries it");
    }
}
