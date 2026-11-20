//! Disconnect: the sign-in ends on this device first, then on the network.
//!
//!   1. The link and the cached profile are removed from this device at
//!      once (that is what ends the sign-in here), and the link record still
//!      to be revoked on the network is written down.
//!   2. The record is revoked on the board's network.
//!   3. A revoke the network does not take (it is not reachable, the cell
//!      is still starting) is tried again at the next starts, until none is
//!      left. The person is never left signed in with an error on the page.
//!
//! For a fork: nothing to change here. A person's records stay when they
//! disconnect; only the link between this device and their identity goes.

use crate::commands::{call_zome, AppState};
use crate::dna::{AGENT_LINKING_ZOME, BOARD};
use holochain_types::prelude::ActionHash;
use std::path::{Path, PathBuf};
use std::sync::Arc;

const OWED_FILE: &str = "disconnect-owed.json";

/// A link this device no longer uses, still to be revoked on the network.
#[derive(serde::Serialize, serde::Deserialize, Clone, Debug, PartialEq)]
pub(crate) struct Owed {
    /// The link record's hash.
    pub entry_action_hash: String,
}

fn owed_path(data_dir: &Path) -> PathBuf {
    data_dir.join(OWED_FILE)
}

pub(crate) fn load_owed(data_dir: &Path) -> Vec<Owed> {
    std::fs::read(owed_path(data_dir)).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

fn write_owed(data_dir: &Path, owed: &[Owed]) {
    if owed.is_empty() {
        let _ = std::fs::remove_file(owed_path(data_dir));
    } else if let Ok(json) = serde_json::to_vec_pretty(owed) {
        let _ = std::fs::write(owed_path(data_dir), json);
    }
}

/// Note a link to revoke (once, whatever the number of presses).
pub(crate) fn owe(data_dir: &Path, link: Owed) {
    let mut owed = load_owed(data_dir);
    if !owed.contains(&link) {
        owed.push(link);
        write_owed(data_dir, &owed);
    }
}

/// The network's answer that the record is not there: nothing to revoke,
/// which is not a failure (it is gone already).
pub(crate) fn not_there(error: &str) -> bool {
    let e = error.to_ascii_lowercase();
    e.contains("entry not found") || e.contains("record not found") || e.contains("link not found")
}

/// Revoke one link. `Err` with the reason when it is still to do.
async fn revoke(state: &AppState, owed: &Owed) -> Result<(), String> {
    let hash = match ActionHash::try_from(owed.entry_action_hash.clone()) {
        Ok(h) => h,
        Err(e) => {
            // Nothing can be revoked by a hash that cannot be read: let it go.
            log::warn!("[disconnect] the saved link hash cannot be read ({:?}): nothing to revoke", e);
            return Ok(());
        }
    };
    let client = state.board.lock().await;
    let client = client.as_ref().ok_or("Holochain is not running")?;
    match call_zome(client, BOARD, AGENT_LINKING_ZOME, "revoke_link", crate::hc::encode(&hash)?).await {
        Ok(_) => Ok(()),
        Err(e) if not_there(&e) => Ok(()),
        Err(e) => Err(e),
    }
}

/// Try every owed revoke; keep what is still left for the next start.
pub(crate) async fn settle(state: &AppState) {
    let loaded = load_owed(&state.data_dir);
    if loaded.is_empty() {
        return;
    }
    let mut still = Vec::new();
    for link in &loaded {
        match revoke(state, link).await {
            Ok(()) => log::info!("[disconnect] the link to the identity is revoked on the network"),
            Err(e) => {
                log::warn!("[disconnect] not revoked yet, tried again at the next start: {}", e);
                still.push(link.clone());
            }
        }
    }
    // A Disconnect pressed while this ran added its own line: keep it.
    still.extend(load_owed(&state.data_dir).into_iter().filter(|l| !loaded.contains(l)));
    write_owed(&state.data_dir, &still);
}

/// At a start: finish any Disconnect the network did not take last time,
/// once Holochain answers.
pub(crate) fn spawn(state: Arc<AppState>) {
    if load_owed(&state.data_dir).is_empty() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        for _ in 0..60 {
            if state.board.lock().await.is_some() {
                break;
            }
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
        }
        settle(&state).await;
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_record_that_is_not_there_is_not_a_failure() {
        assert!(not_there("Something went wrong: Guest(\"Entry not found\")"));
        assert!(not_there("Record not found"));
        assert!(!not_there("Holochain is not running"));
        assert!(!not_there("timed out after 60 s"));
        assert!(!not_there("Only the link's own agents can revoke it"));
    }

    #[test]
    fn a_disconnect_is_owed_once_and_the_file_goes_when_nothing_is_owed() {
        let dir = tempfile::tempdir().unwrap();
        let link = Owed { entry_action_hash: "uhCkk-link".into() };
        assert!(load_owed(dir.path()).is_empty());
        owe(dir.path(), link.clone());
        owe(dir.path(), link.clone());
        assert_eq!(load_owed(dir.path()), vec![link]);
        write_owed(dir.path(), &[]);
        assert!(!owed_path(dir.path()).exists());
    }
}
