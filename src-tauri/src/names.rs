//! Every name a fork changes, in one place.
//!
//! `scripts/rename-app.mjs` rewrites this file together with the files
//! that cannot read it (`tauri.conf.json`, `Cargo.toml`, `package.json`)
//! and the scripts that name the sidecars. Nothing else
//! in `src-tauri/src` spells the app's name, identifier, sidecars or ports.

/// What people see: window title, dialogs, the name the Vault shows for
/// this app, the name inside backups.
pub const APP_NAME: &str = "Holochain Desktop Starter";

/// The bundle identifier (`tauri.conf.json` has the same value). It names
/// the data folder on every system, so changing it on a released app moves
/// people's data out from under them. Never end it in `.app`: macOS shows a
/// folder with that ending as a broken application.
pub const APP_IDENTIFIER: &str = "com.flowsta.desktopstarter";

/// The log file's name and, on macOS, its folder under `~/Library/Logs`.
pub const LOG_FILE_NAME: &str = "starter";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
pub const LOG_FOLDER_NAME: &str = "Holochain Desktop Starter";

/// The sidecars, as `tauri.conf.json` `externalBin` names them: the
/// conductor and its key store. They carry the app's own prefix so they
/// never collide with another Holochain app's on the same computer, and so
/// the startup sweep can tell its own orphans from anyone else's processes.
pub const CONDUCTOR: &str = "starter-holochain";
pub const LAIR: &str = "starter-lair-keystore";
pub const SIDECARS: &[&str] = &[CONDUCTOR, LAIR];

/// The conductor's admin port. Change it if another Holochain app on the
/// same computer uses it (Flowsta Vault uses 4455).
pub const ADMIN_PORT: u16 = 4488;

/// Where the app's releases are published, the prefix of its two channel
/// tags (`<prefix>-beta`, `<prefix>-stable`: fixed pre-releases that hold
/// each channel's updater files), and the Flowsta identities whose
/// signature on a release manifest this build accepts. An app installs only
/// a release one of them signed, so a fork lists the identity ITS releases
/// are signed with (RELEASING.md) and never keeps this one: the rename
/// script empties the list, and an app with an empty list does not update
/// itself until you fill it.
pub const RELEASES_URL: &str = "https://github.com/WeAreFlowsta/holochain-desktop-starter/releases";
pub const CHANNEL_PREFIX: &str = "starter";
pub const RELEASE_SIGNERS: &[&str] = &["did:flowsta:uhCAkWuA-Ehm9EVzcsPE2Wo_vpc9ImljHN8NMMEXpbtG5BdooOV9a"];

/// The board's network: everyone whose app names the same one shares one
/// board. It is given to the conductor when the board is installed, so a
/// fork gets a board of its own with no rebuild of the DNA. It is the
/// identifier because that is already yours alone: two forks that picked
/// the same short name still get two boards. A device that installed the
/// board keeps the network it joined, which is one more reason never to
/// change the identifier of a released app.
pub const BOARD_NETWORK: &str = APP_IDENTIFIER;

/// The prefix of the random origin the conductor's interfaces accept, and
/// of the short folder the key store's socket goes in when the data
/// folder's path is too long for one.
pub const ORIGIN_PREFIX: &str = "st";

/// The key store tag the device's seed is kept under, and the file the
/// seed's recovery copy is written to.
pub const SEED_TAG: &str = "starter-device-seed";
pub const RECOVERY_FILE: &str = "starter-recovery.json";

#[cfg(test)]
mod tests {
    use super::*;

    /// `tauri.conf.json` cannot read this file: the two must say the same,
    /// or the app looks for sidecars the installer never shipped and for a
    /// data folder under another identifier.
    #[test]
    fn the_app_config_agrees_with_the_names() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert_eq!(conf["productName"], APP_NAME);
        assert_eq!(conf["identifier"], APP_IDENTIFIER);
        let mut bundled: Vec<String> = conf["bundle"]["externalBin"].as_array().unwrap().iter().map(|b| b.as_str().unwrap().trim_start_matches("binaries/").to_string()).collect();
        bundled.sort();
        let mut ours: Vec<String> = SIDECARS.iter().map(|s| s.to_string()).collect();
        ours.sort();
        assert_eq!(bundled, ours, "the sidecars the installer ships are the ones the app starts and sweeps");
    }

    #[test]
    fn the_sidecars_share_one_prefix_and_the_identifier_is_safe() {
        let prefix = LAIR.trim_end_matches("-lair-keystore");
        assert!(SIDECARS.iter().all(|s| s.starts_with(&format!("{prefix}-"))), "one prefix, so the startup sweep and the rename script find both");
        assert!(APP_IDENTIFIER.split('.').count() >= 3);
        assert!(!APP_IDENTIFIER.ends_with(".app"), "macOS shows a data folder ending in .app as a broken application");
    }
}
