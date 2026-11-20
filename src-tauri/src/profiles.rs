//! Profiles: one key, key store, conductor and set of link files per
//! Flowsta identity that has signed in on this install.
//!
//!   <app data dir>/profiles.json              the index
//!   <app data dir>/profiles/<folder>/          one profile:
//!       lair-passphrase, lair/, conductor/,
//!       the device seed's recovery file, identity-link.json,
//!       profile-cache.json
//!
//! So two people who share a computer account (or one person's two
//! identities) never share keys or data: each gets the app as their own.
//! The index, the folder naming and the choice of profile at a start are
//! `flowsta_vault_client::profiles`; here is what THIS app keeps in one.
//!
//! For a fork: if your app keeps another file or folder per person beside
//! these, list it in `LAYOUT` below so it lives in the profile with them.

use flowsta_vault_client::profiles as sdk;
use std::path::{Path, PathBuf};

pub use flowsta_vault_client::profiles::bind_profile;
#[cfg(not(windows))]
pub use flowsta_vault_client::profiles::short_socket_path;
#[cfg(all(test, not(windows)))]
pub use flowsta_vault_client::profiles::{in_root_socket_fits, lair_socket_path_fits};

/// The key store's config names absolute paths. When its folder moves they
/// are pointed at the new place (the socket address is a URL, so this goes
/// through a URL-aware rewrite, never a text replace).
fn repoint(new_lair_dir: &Path) -> Result<(), String> {
    crate::lair::repoint_config(new_lair_dir).map(|_| ())
}

fn no_other_files(_name: &str) -> bool {
    false
}

/// What a profile of this app holds.
const LAYOUT: sdk::Layout<'static> = sdk::Layout {
    recovery_file: crate::device_seed::RECOVERY_FILE,
    files: &["lair-passphrase"],
    also: &no_other_files,
    dirs: crate::conductor::LINE_DIRS,
    key_stores: &[crate::conductor::LAIR_DIR],
    conductor: crate::conductor::CONDUCTOR_DIR,
    repoint_key_store: &repoint,
};

/// The profile this launch runs in. `live_identity`: the identity the Vault
/// holds, when it is unlocked and names it at launch.
pub fn select_profile_root(device_root: &Path, live_identity: Option<&str>) -> PathBuf {
    sdk::select_profile_root(device_root, live_identity, &LAYOUT)
}

/// The profile for an identity the Vault holds and does not name yet: the
/// one no identity is bound to, or a new, empty one beside the others.
pub fn select_unbound_profile_root(device_root: &Path) -> PathBuf {
    sdk::select_unbound_profile_root(device_root, &LAYOUT)
}

#[cfg(test)]
mod tests {
    use super::*;

    const KEY_A: &str = "uhCAk75qJ5oobyfm3Lh-akZIQSe2zpSTtG1Pcxs23qTFoQwY_GDWY";
    const KEY_B: &str = "uhCAk0O4EJ97RZ7eX2wf9x08PWjNj3Avt2K1SdU8tgPzWoQBwWk0s";

    #[test]
    fn each_identity_gets_a_profile_of_its_own_and_keeps_it() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // A first start with the Vault closed: a profile no identity is bound to.
        let first = select_profile_root(root, None);
        assert!(first.starts_with(root.join("profiles")), "{first:?}");
        assert_eq!(select_profile_root(root, None), first, "the same one at the next start");

        // Signing in binds it to that identity.
        bind_profile(root, &first, KEY_A);
        assert_eq!(select_profile_root(root, Some(KEY_A)), first);

        // Another identity in the Vault at launch: another profile.
        let second = select_profile_root(root, Some(KEY_B));
        assert_ne!(second, first, "two identities never share a key store or a conductor");
        assert_eq!(select_profile_root(root, Some(KEY_A)), first, "and the first is there when its identity is back");
    }
}
