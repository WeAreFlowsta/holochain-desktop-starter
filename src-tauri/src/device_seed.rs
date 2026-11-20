//! The device's key: made by the app, with a copy of its seed kept in a file.
//!
//! Each device has a key of its own on both networks. Its seed is created
//! by the app (not inside the key store), so a recovery copy exists in a
//! file in the profile: a key store that has to be made again gets the same
//! key back. The file's format, the load that never
//! regenerates over a corrupt file and the replace that keeps the outgoing
//! seed are `flowsta_vault_client::device_seed`; here are this app's file
//! name and key store tag, and the import into the key store.
//!
//! For a fork: nothing to change here. Never generate a seed over an
//! existing one: a new seed is a new key, and what the old key wrote would
//! no longer be this device's to change.

use flowsta_vault_client::device_seed as sdk;
use std::path::Path;

pub use flowsta_vault_client::device_seed::DeviceSeed;

pub const RECOVERY_FILE: &str = crate::names::RECOVERY_FILE;
pub const SEED_TAG: &str = crate::names::SEED_TAG;

/// Load the device seed, or None on a brand-new install. A corrupt file is
/// an ERROR, never regenerated: a new seed would be a new key, and what the
/// old one wrote would no longer be this device's.
pub fn load(data_dir: &Path) -> Result<Option<DeviceSeed>, String> {
    sdk::load(data_dir, RECOVERY_FILE)
}

/// A fresh random seed, persisted. Refuses to overwrite an existing file.
pub fn generate_and_store(data_dir: &Path) -> Result<DeviceSeed, String> {
    sdk::generate_and_store(data_dir, RECOVERY_FILE)
}

/// The Holochain agent key this seed produces.
pub fn agent_pub_key(seed: &DeviceSeed) -> Result<holochain_types::prelude::AgentPubKey, String> {
    Ok(holochain_types::prelude::AgentPubKey::from_raw_32(sdk::public_key(seed)?.to_vec()))
}

/// Load or create the device seed, put it in the key store, and return the
/// agent key. The key is the one the KEY STORE derives, cross-checked
/// against the app's own derivation, so the conductor can always sign for
/// the agent the apps are installed under.
pub async fn ensure_device_agent(client: &lair_keystore_api::prelude::LairClient, data_dir: &Path) -> Result<holochain_types::prelude::AgentPubKey, String> {
    let seed = match load(data_dir)? {
        Some(s) => s,
        None => {
            log::info!("[seed] making this device's key (the seed is kept in {RECOVERY_FILE})");
            generate_and_store(data_dir)?
        }
    };
    let lair_pk = crate::lair::import_seed_to_lair(client, &seed.seed_bytes()?, SEED_TAG).await?;
    let lair_key = holochain_types::prelude::AgentPubKey::from_raw_32(lair_pk.to_vec());
    if agent_pub_key(&seed)? != lair_key {
        return Err("the key store's key for the device seed differs from the recovery file's".into());
    }
    Ok(lair_key)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_key_is_stable_and_shaped() {
        let seed = DeviceSeed { device_seed_hex: "11".repeat(32), version: 1 };
        let k1 = agent_pub_key(&seed).unwrap();
        assert_eq!(k1, agent_pub_key(&seed).unwrap());
        assert_eq!(&k1.get_raw_39()[0..3], &[0x84, 0x20, 0x24]);
    }

    #[test]
    fn a_seed_is_made_once_and_never_overwritten() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path()).unwrap().is_none());
        let seed = generate_and_store(dir.path()).unwrap();
        assert!(dir.path().join(RECOVERY_FILE).exists());
        assert_eq!(load(dir.path()).unwrap().unwrap().device_seed_hex, seed.device_seed_hex);
        assert!(generate_and_store(dir.path()).is_err(), "an existing seed is never overwritten");
    }
}
