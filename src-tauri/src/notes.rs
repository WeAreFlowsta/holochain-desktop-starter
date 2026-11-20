//! Notes: the commands the two tabs call. THIS IS THE FILE TO MAKE YOURS.
//!
//! Both tabs keep the same record, a note, and call the same functions; a
//! tab only says which network it means:
//!   - `Place::Board`: the shared network (`dna/board`). Everyone reads it;
//!     a note is changed by the key that wrote it.
//!   - `Place::MyNotes`: the person's own network (`dna/my-notes`). Only
//!     their devices are on it; any of them changes any note.
//!
//! Every write goes through `require_identity_link` first (signed in on
//! this device, and no other identity's Vault open). Reads need nothing.
//!
//! To make it yours: rename `Note` here and in the two DNAs, change the
//! commands to your record's, and register them in `lib.rs`.

use crate::commands::{call_zome, read_or_local, require_identity_link, require_identity_match, AppState};
use crate::dna::{App, BOARD, MY_NOTES, NOTES_ZOME};
use crate::hc::AppClient;
use holochain_types::prelude::{ActionHash, AgentPubKey};
use std::sync::Arc;

/// Which network a command means.
#[derive(serde::Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Place {
    Board,
    MyNotes,
}

impl Place {
    fn app(self) -> App {
        match self {
            Place::Board => BOARD,
            Place::MyNotes => MY_NOTES,
        }
    }
}

/// What the page is told when the person's own network is not on this
/// device yet. The page shows the set-up step for it, not an error.
pub(crate) const MY_NOTES_NOT_SET_UP: &str = "MY_NOTES_NOT_SET_UP";

async fn client(state: &Arc<AppState>, place: Place) -> Result<AppClient, String> {
    let slot = match place {
        Place::Board => state.board.lock().await,
        Place::MyNotes => state.my_notes.lock().await,
    };
    slot.clone().ok_or_else(|| match place {
        Place::Board => "Holochain is not ready yet".to_string(),
        Place::MyNotes => MY_NOTES_NOT_SET_UP.to_string(),
    })
}

/// A note as the zomes return it (`NoteView` in both coordinators).
#[derive(serde::Deserialize, Debug, Clone)]
struct ZomeNote {
    id: ActionHash,
    author: AgentPubKey,
    text: String,
    created_at: i64,
    edited_at: Option<i64>,
    /// Private notes only: the id a restored note had in the backup.
    #[serde(default)]
    restored_from: Option<ActionHash>,
}

/// A note as the page shows it.
#[derive(serde::Serialize, Debug, Clone, PartialEq)]
pub struct Note {
    /// The note's first record: what an edit and a delete name.
    pub id: String,
    /// The key that wrote it. The page compares it with the person's keys
    /// (`get_my_agent_set`) to say "yours", and with this device's key to
    /// offer Edit and Delete on the board.
    pub author: String,
    pub text: String,
    /// Microseconds since 1970.
    pub created_at: i64,
    pub edited_at: Option<i64>,
    /// For a note restored from a Vault backup: the id it had there.
    pub restored_from: Option<String>,
}

impl From<ZomeNote> for Note {
    fn from(n: ZomeNote) -> Self {
        Note { id: n.id.to_string(), author: n.author.to_string(), text: n.text, created_at: n.created_at, edited_at: n.edited_at, restored_from: n.restored_from.map(|h| h.to_string()) }
    }
}

/// The notes of one tab, newest first. Shows what this device holds when
/// the network does not answer within a few seconds.
#[tauri::command]
pub async fn get_notes(state: tauri::State<'_, Arc<AppState>>, place: Place) -> Result<Vec<Note>, String> {
    let client = client(state.inner(), place).await?;
    let bytes = read_or_local(&client, place.app(), NOTES_ZOME, "get_notes", crate::hc::encode(&())?).await?;
    let notes: Vec<ZomeNote> = crate::hc::decode(&bytes)?;
    Ok(notes.into_iter().map(Note::from).collect())
}

#[tauri::command]
pub async fn create_note(state: tauri::State<'_, Arc<AppState>>, place: Place, text: String) -> Result<String, String> {
    require_identity_link(state.inner()).await?;
    let client = client(state.inner(), place).await?;
    let bytes = call_zome(&client, place.app(), NOTES_ZOME, "create_note", crate::hc::encode(&text)?).await?;
    let id: ActionHash = crate::hc::decode(&bytes)?;
    Ok(id.to_string())
}

#[tauri::command]
pub async fn edit_note(state: tauri::State<'_, Arc<AppState>>, place: Place, id: String, text: String) -> Result<(), String> {
    require_identity_link(state.inner()).await?;
    #[derive(serde::Serialize, Debug)]
    struct EditNoteInput {
        id: ActionHash,
        text: String,
    }
    let client = client(state.inner(), place).await?;
    let input = EditNoteInput { id: crate::hc::action_hash(&id)?, text };
    call_zome(&client, place.app(), NOTES_ZOME, "edit_note", crate::hc::encode(&input)?).await.map(|_| ())
}

#[tauri::command]
pub async fn delete_note(state: tauri::State<'_, Arc<AppState>>, place: Place, id: String) -> Result<(), String> {
    require_identity_link(state.inner()).await?;
    let client = client(state.inner(), place).await?;
    call_zome(&client, place.app(), NOTES_ZOME, "delete_note", crate::hc::encode(&crate::hc::action_hash(&id)?)?).await.map(|_| ())
}

/// A private note as a Vault backup holds it (`build_backup` wrote it).
#[derive(serde::Deserialize, serde::Serialize, Debug, Clone)]
pub struct BackedUpNote {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub restored_from: Option<String>,
}

/// Of the notes a backup holds, the ones a restore would write: the notes
/// this device has never seen. A note the person deleted is not offered
/// back, however old the backup.
#[tauri::command]
pub async fn restorable_notes(state: tauri::State<'_, Arc<AppState>>, notes: Vec<BackedUpNote>) -> Result<Vec<BackedUpNote>, String> {
    let client = client(state.inner(), Place::MyNotes).await?;
    let origin = |n: &BackedUpNote| crate::hc::action_hash(n.restored_from.as_deref().unwrap_or(&n.id));
    let ids = notes.iter().map(origin).collect::<Result<Vec<ActionHash>, String>>()?;
    let bytes = call_zome(&client, MY_NOTES, NOTES_ZOME, "restorable", crate::hc::encode(&ids)?).await?;
    let unseen: Vec<ActionHash> = crate::hc::decode(&bytes)?;
    Ok(notes.into_iter().filter(|n| origin(n).is_ok_and(|id| unseen.contains(&id))).collect())
}

/// Write private notes back from the person's Vault backup, and say how
/// many were written. The page reads the backup (`src/lib/restore.ts`) and
/// hands over its notes; a note that is already here, was restored before
/// or was deleted is left alone, so this can be run again at any time.
///
/// Only private notes are restored. Board notes are held by every peer and
/// come back from the network by themselves.
#[tauri::command]
pub async fn restore_my_notes(state: tauri::State<'_, Arc<AppState>>, notes: Vec<BackedUpNote>) -> Result<u32, String> {
    require_identity_link(state.inner()).await?;
    #[derive(serde::Serialize, Debug)]
    struct RestoreNoteInput {
        original: ActionHash,
        text: String,
    }
    let client = client(state.inner(), Place::MyNotes).await?;
    let mut restored = 0;
    for note in notes {
        // A note that was itself a restored copy keeps its first id, so one
        // note has one origin however many devices it has been through.
        let original = crate::hc::action_hash(note.restored_from.as_deref().unwrap_or(&note.id))?;
        let bytes = call_zome(&client, MY_NOTES, NOTES_ZOME, "restore_note", crate::hc::encode(&RestoreNoteInput { original, text: note.text })?).await?;
        if crate::hc::decode::<Option<ActionHash>>(&bytes)?.is_some() {
            restored += 1;
        }
    }
    log::info!("[restore] {restored} private note(s) written back from the Vault backup");
    Ok(restored)
}

/// Set the person's own network up on this device.
///
/// The Vault gives this app a secret that is the same on every one of the
/// person's devices and different for every person and every app
/// (`flowsta_vault_client::app_secret`). The private DNA is installed with
/// it as its network seed, so this device joins a network that only the
/// same person's devices can ever join. Needs the Vault unlocked, once per
/// device: after that the network is simply there at every start.
///
/// Holochain restarts once afterwards (an install keeps a lot of memory
/// until it does), which takes a few seconds.
#[tauri::command]
pub async fn set_up_my_notes(app: tauri::AppHandle, state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    if state.my_notes.lock().await.is_some() {
        return Ok(());
    }
    // The secret comes from whoever's Vault is open: it must be the
    // identity signed in here.
    require_identity_match(state.inner()).await?;
    let vault = crate::vault_probe::client();
    let presented = vault.link_token();
    let secret = flowsta_vault_client::app_secret::network_secret(vault, crate::commands::APP_NAME, flowsta_vault_client::app_secret::DEFAULT_LABEL).await.map_err(|e| {
        // A link the Vault no longer has (the person removed the app
        // there): the token is forgotten and the page offers to sign in
        // again.
        if let flowsta_vault_client::app_secret::AppSecretError::Refused(r) = &e {
            crate::link_token::note_refusal(&app, &state.data_dir, r.code(), presented.as_deref());
        }
        e.to_string()
    })?;
    let agent = state.agent_pub_key.lock().unwrap().clone();
    let agent = agent.and_then(|k| AgentPubKey::try_from(k).ok()).ok_or("Holochain is not ready yet")?;
    let resources = crate::resolve_resource_dir(&app, &state.device_root);
    let installed_now = crate::dna::ensure_installed(crate::conductor::admin_port(), &resources, &agent, MY_NOTES, Some(secret.hex())).await?;
    log::info!("[my notes] the person's own network is {} on this device (the secret was {:?})", if installed_now { "installed" } else { "already" }, secret.source);
    crate::conductor::restart_session(state.inner(), &app, "Setting up your private notes...").await
}

/// The person's own notes for their Vault backup: what they wrote on the
/// board (by any of their keys) and everything in their private notes.
///
/// `_summary.totalRecords` is what the SDK's backup reads to refuse writing
/// an empty backup over one that holds records (a new device that has not
/// received anything yet must not erase the last good backup).
#[tauri::command]
pub async fn build_backup(state: tauri::State<'_, Arc<AppState>>, my_agents: Vec<String>) -> Result<serde_json::Value, String> {
    require_identity_link(state.inner()).await?;
    let board: Vec<Note> = get_notes(state.clone(), Place::Board).await?.into_iter().filter(|n| my_agents.contains(&n.author)).collect();
    let mine: Vec<Note> = match get_notes(state.clone(), Place::MyNotes).await {
        Ok(notes) => notes,
        Err(e) if e == MY_NOTES_NOT_SET_UP => Vec::new(),
        Err(e) => return Err(e),
    };
    Ok(serde_json::json!({
        "_summary": { "app": crate::commands::APP_NAME, "totalRecords": board.len() + mine.len(), "board": board.len(), "my_notes": mine.len() },
        "board": board,
        "my_notes": mine,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_place_names_its_own_app() {
        assert_eq!(Place::Board.app(), BOARD);
        assert_eq!(Place::MyNotes.app(), MY_NOTES);
        assert_eq!(serde_json::from_str::<Place>("\"my_notes\"").unwrap(), Place::MyNotes);
        assert_eq!(serde_json::from_str::<Place>("\"board\"").unwrap(), Place::Board);
    }
}
