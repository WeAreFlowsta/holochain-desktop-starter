//! What any Holochain desktop app keeps: the app's state, zome calls, the
//! status the page reads, Flowsta sign-in, and the Vault backup.
//!
//! The page talks to the Rust side through Tauri commands and never to the
//! conductor itself. What is about NOTES (the commands the two tabs call)
//! is in `notes.rs`: that is the part to replace with your own.
//!
//! For a fork: keep this file. Your own commands go in a file like
//! `notes.rs` and use three things from here: `call_zome` (or
//! `read_or_local` for a list), `require_identity_link` before every write,
//! and `friendly_error` for what the page shows. After adding a command,
//! register it in `lib.rs` (`invoke_handler`).

use crate::conductor::ConductorStatus;
use crate::dna::{App, AGENT_LINKING_ZOME, BOARD};
use crate::hc::AppClient;
use holochain_types::prelude::{ActionHash, AgentPubKey};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

// ── The app's state ───────────────────────────────────────────────────

pub struct AppState {
    /// This profile's folder: key store, conductor, device seed, link files.
    /// One profile per Flowsta identity (`profiles.rs`), so two people on
    /// one computer never share keys or data.
    pub data_dir: PathBuf,
    /// The app's data folder: holds `profiles.json` and `profiles/`.
    pub device_root: PathBuf,
    /// This launch came from "Open as this identity" (the page starts the
    /// sign-in for a profile that is not linked yet).
    pub relaunched_into_identity: std::sync::atomic::AtomicBool,
    /// This start brings the window to the front once the app is ready: it
    /// follows "Open as this identity" or an update's own restart.
    pub raise_when_ready: std::sync::atomic::AtomicBool,
    pub conductor_status: Mutex<ConductorStatus>,
    /// The device's key, the same on both networks.
    pub agent_pub_key: Mutex<Option<String>>,
    /// The board: the shared network.
    pub board: tokio::sync::Mutex<Option<AppClient>>,
    /// My notes: the person's own network. `None` until it is set up on
    /// this device (`notes::set_up_my_notes`).
    pub my_notes: tokio::sync::Mutex<Option<AppClient>>,
    /// The key store's passphrase (random, kept in the profile).
    pub passphrase: Mutex<String>,
    pub lair_client: tokio::sync::Mutex<Option<lair_keystore_api::LairClient>>,
    /// What the last Vault backup attempt did, for the Identity page and
    /// the log.
    pub last_backup_outcome: Mutex<Option<BackupOutcome>>,
}

impl AppState {
    pub fn new(data_dir: PathBuf, device_root: PathBuf) -> Self {
        let passphrase_path = data_dir.join("lair-passphrase");
        let lair_dir = data_dir.join(crate::conductor::LAIR_DIR);
        // These three belong together: the passphrase derives the key, the
        // config holds its salts, the store is encrypted under both. Either
        // all are there (a working install) or none (a new one). Anything
        // else is what a partial uninstall leaves, and the key store cannot
        // open it ("hmac check failed" at every start). It is already
        // unreadable, so it is cleared here and the device starts fresh.
        let present = [passphrase_path.exists(), lair_dir.join("lair-keystore-config.yaml").exists(), lair_dir.join("store_file").exists()];
        if present.iter().any(|p| *p) && !present.iter().all(|p| *p) {
            log::warn!("The key store's files do not belong together (passphrase, config, store: {:?}): clearing local state to start fresh", present);
            clear_local_state(&data_dir);
        }
        let passphrase = match std::fs::read_to_string(&passphrase_path) {
            Ok(p) if !p.is_empty() => p,
            _ => write_new_passphrase(&passphrase_path),
        };
        Self {
            data_dir,
            device_root,
            relaunched_into_identity: std::sync::atomic::AtomicBool::new(false),
            raise_when_ready: std::sync::atomic::AtomicBool::new(false),
            conductor_status: Mutex::new(ConductorStatus::Stopped),
            agent_pub_key: Mutex::new(None),
            board: tokio::sync::Mutex::new(None),
            my_notes: tokio::sync::Mutex::new(None),
            passphrase: Mutex::new(passphrase),
            lair_client: tokio::sync::Mutex::new(None),
            last_backup_outcome: Mutex::new(None),
        }
    }
}

fn write_new_passphrase(path: &Path) -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    let passphrase: String = (0..32).map(|_| rng.sample(rand::distributions::Alphanumeric) as char).collect();
    match std::fs::write(path, &passphrase) {
        Ok(()) => log::info!("A new key store passphrase was written to {:?}", path),
        Err(e) => log::error!("The key store passphrase could not be written to {:?}: {}", path, e),
    }
    passphrase
}

/// Remove the passphrase, the key store and the conductor from a profile,
/// and set the device's seed file aside.
///
/// Only ever called when those files can no longer be opened. What it
/// means for the person, said plainly because it is not nothing:
///   - this device gets a NEW key. A conductor that starts again under the
///     old key with an empty history would write a second, conflicting
///     history under it, so the old seed is kept aside (never deleted) and
///     not used again;
///   - notes this device wrote on the board stay on the board under the old
///     key, and still show as the person's once they sign in again (the
///     identity link is per person, not per key). This device can no
///     longer edit or delete them;
///   - their private notes come back from their other devices, or from
///     their Vault backup when no other device has them (the Notes page
///     offers it: `notes::restore_my_notes`).
fn clear_local_state(data_dir: &Path) {
    let _ = std::fs::remove_file(data_dir.join("lair-passphrase"));
    for dir in crate::conductor::LINE_DIRS {
        if let Err(e) = std::fs::remove_dir_all(data_dir.join(dir)) {
            if e.kind() != std::io::ErrorKind::NotFound {
                log::warn!("could not remove {}: {}", dir, e);
            }
        }
    }
    let seed = data_dir.join(crate::names::RECOVERY_FILE);
    if seed.exists() {
        let aside = data_dir.join(flowsta_vault_client::device_seed::replaced_name(crate::names::RECOVERY_FILE, unix_secs()));
        match std::fs::rename(&seed, &aside) {
            Ok(()) => log::warn!("The device's seed is set aside as {:?}: this device now makes a new key", aside),
            Err(e) => log::error!("The device's seed could not be set aside ({}): the old key would be used again", e),
        }
    }
}

/// [`clear_local_state`], then a new passphrase on disk and in memory.
/// Called by `conductor::start_holochain` when the first start fails
/// because the local databases cannot be opened.
pub fn reset_local_state(data_dir: &Path, app_state: &AppState) -> String {
    clear_local_state(data_dir);
    let passphrase = write_new_passphrase(&data_dir.join("lair-passphrase"));
    *app_state.passphrase.lock().unwrap() = passphrase.clone();
    passphrase
}

// ── Zome calls ────────────────────────────────────────────────────────

pub(crate) const APP_NAME: &str = crate::names::APP_NAME;

/// When the app last asked the conductor to write (unix seconds), and how
/// many calls are waiting for their answer now.
pub(crate) static LAST_WRITE_SECS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
pub(crate) static CALLS_IN_FLIGHT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);

/// A call that only reads: the coordinators name every read `get_...`. The
/// page reads by itself every few seconds, so a read is no sign that anyone
/// is at work.
pub(crate) fn only_reads(fn_name: &str) -> bool {
    fn_name.starts_with("get_")
}

/// Whether this is a quiet moment: no call waiting for its answer, and the
/// last write at least a minute ago.
pub(crate) fn quiet_at(now_secs: u64, last_write_secs: u64, in_flight: u64) -> bool {
    in_flight == 0 && now_secs.saturating_sub(last_write_secs) >= 60
}

/// One call waiting for its answer, until dropped.
struct InFlight;
impl InFlight {
    fn new() -> Self {
        CALLS_IN_FLIGHT.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        InFlight
    }
}
impl Drop for InFlight {
    fn drop(&mut self) {
        CALLS_IN_FLIGHT.fetch_sub(1, std::sync::atomic::Ordering::SeqCst);
    }
}

pub(crate) fn unix_secs() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

/// A quiet moment: nothing written for a minute and no call waiting. A
/// restart of the conductor for its memory waits for one
/// (`conductor::spawn_watch`).
pub(crate) fn quiet_now() -> bool {
    use std::sync::atomic::Ordering::SeqCst;
    quiet_at(unix_secs(), LAST_WRITE_SECS.load(SeqCst), CALLS_IN_FLIGHT.load(SeqCst))
}

/// Call a zome function of `app`. Every command goes through here: it
/// names the role, brings a cell that is not running yet back up and tries
/// once more, logs the raw error and returns one a person can read.
pub(crate) async fn call_zome(client: &AppClient, app: App, zome: &str, fn_name: &str, payload: Vec<u8>) -> Result<Vec<u8>, String> {
    let _waiting = InFlight::new();
    if !only_reads(fn_name) {
        LAST_WRITE_SECS.store(unix_secs(), std::sync::atomic::Ordering::SeqCst);
    }
    match client.call_zome(app.role, zome, fn_name, payload.clone()).await {
        Ok(r) => Ok(r),
        Err(raw) if raw.contains("CellNotRunning") || raw.contains("CellDisabled") => {
            log::warn!("[zome] the {} cell is not running: enabling it and trying once more", app.app_id);
            if let Err(e) = enable_app(app).await {
                log::error!("[zome] {} could not be enabled: {}", app.app_id, e);
                return Err(friendly_error(&raw));
            }
            client.call_zome(app.role, zome, fn_name, payload).await.map_err(|raw| {
                log::warn!("[zome] {}.{} failed after enabling {}: {}", zome, fn_name, app.app_id, raw);
                friendly_error(&raw)
            })
        }
        Err(raw) => {
            log::warn!("[zome] {}.{} failed: {}", zome, fn_name, raw);
            Err(friendly_error(&raw))
        }
    }
}

/// [`call_zome`], waiting at most `secs` for the answer.
pub(crate) async fn call_zome_within(client: &AppClient, app: App, zome: &str, fn_name: &str, payload: Vec<u8>, secs: u64) -> Result<Vec<u8>, String> {
    match tokio::time::timeout(std::time::Duration::from_secs(secs), call_zome(client, app, zome, fn_name, payload)).await {
        Ok(r) => r,
        Err(_) => Err(format!("{}.{} did not answer within {} s", zome, fn_name, secs)),
    }
}

/// How long a list waits on the network before it shows what this device
/// holds.
pub(crate) const LIST_WAIT_SECS: u64 = 15;

/// A read that waits at most [`LIST_WAIT_SECS`] on the network, then shows
/// what this device holds (the coordinator's `<fn_name>_local`). A read
/// that asks the network can wait minutes just after a start; a list shows
/// what it has instead of a spinner.
pub(crate) async fn read_or_local(client: &AppClient, app: App, zome: &str, fn_name: &str, payload: Vec<u8>) -> Result<Vec<u8>, String> {
    match call_zome_within(client, app, zome, fn_name, payload.clone(), LIST_WAIT_SECS).await {
        Ok(r) => Ok(r),
        Err(e) => {
            log::warn!("[zome] {} did not come from the network ({}): showing what this device holds", fn_name, e);
            call_zome(client, app, zome, &format!("{}_local", fn_name), payload).await
        }
    }
}

async fn enable_app(app: App) -> Result<(), String> {
    let admin = holochain_client::AdminWebsocket::connect(format!("localhost:{}", crate::conductor::admin_port()), Some(crate::conductor::node_origin()))
        .await
        .map_err(|e| format!("could not reach the conductor's admin interface: {}", e))?;
    admin.enable_app(app.app_id.to_string()).await.map(|_| ()).map_err(|e| e.to_string())
}

/// A raw Holochain error as something a person can read.
pub(crate) fn friendly_error(raw: &str) -> String {
    if raw.contains("CellNotRunning") || raw.contains("CellDisabled") {
        "This part of the app is still starting. Give it a moment and try again.".into()
    } else if raw.contains("WebsocketError") || raw.contains("ConnectionReset") || raw.contains("Io(") {
        "Lost the connection to Holochain. It may have stopped unexpectedly.".into()
    } else if raw.contains("timeout") || raw.contains("Timeout") {
        "The request timed out. The network may be slow or unreachable.".into()
    } else if let Some(reason) = refused_by_the_rules(raw) {
        reason
    } else {
        format!("Something went wrong: {}", raw)
    }
}

/// The reason a DNA's rules gave for refusing a write (`validate` returned
/// `Invalid("...")`), when the error is one. The conductor words it
/// `InvalidCommit error: <the reason>`, inside its own wrapping.
fn refused_by_the_rules(raw: &str) -> Option<String> {
    let after = raw.split("InvalidCommit error: ").nth(1)?;
    let reason = after[..after.find(['"', '\\', '\n']).unwrap_or(after.len())].trim();
    (!reason.is_empty()).then(|| reason.to_string())
}

/// An agent key from its text. Keeps the exact 39 bytes, so a key the Vault
/// gave as text matches what the Vault signed.
pub(crate) fn parse_agent_pub_key_string(s: &str) -> Result<AgentPubKey, String> {
    Ok(AgentPubKey::from_raw_39(flowsta_vault_client::identity::parse_agent_key(s)?))
}

// ── Status ────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct AppStatus {
    pub ready: bool,
    /// This device's key.
    pub agent_pub_key: Option<String>,
    pub conductor_status: ConductorStatus,
    /// The person's own network is set up on this device.
    pub my_notes_ready: bool,
    /// This launch was asked for by "Open as this identity".
    pub relaunched_into_identity: bool,
}

#[tauri::command]
pub async fn get_app_status(state: tauri::State<'_, Arc<AppState>>) -> Result<AppStatus, String> {
    let status = state.conductor_status.lock().unwrap().clone();
    let agent_pub_key = state.agent_pub_key.lock().unwrap().clone();
    let my_notes_ready = state.my_notes.lock().await.is_some();
    Ok(AppStatus {
        ready: matches!(status, ConductorStatus::Ready { .. }),
        agent_pub_key,
        conductor_status: status,
        my_notes_ready,
        relaunched_into_identity: state.relaunched_into_identity.load(std::sync::atomic::Ordering::Relaxed),
    })
}

/// Open Flowsta Vault when it is installed and not running, so the person
/// does not have to go and find it during sign-in.
#[tauri::command]
pub fn launch_vault() -> Result<(), String> {
    // The Vault decides its own window's drawing: it never inherits what
    // this app's webview fix set.
    flowsta_vault_client::vault::launch_vault(crate::webview_fix::set_here())
}

// ── Flowsta sign-in ───────────────────────────────────────────────────
//
// Signing in links this device's key to the person's Flowsta identity: the
// Vault signs the pair of keys, this device signs it too, and the record
// goes on the board's network (the agent-linking zome), where anyone can
// check it with two signature checks and no server. From then on every
// device the person signs in on reads as the same person.
//
// Two files in the profile remember it on this device
// (`flowsta_vault_client::identity`):
//   - identity-link.json: which identity, and the link record's hash;
//   - profile-cache.json: the display name and picture, so the page can
//     show them with the Vault closed.

pub use flowsta_vault_client::identity::{CachedProfile, IdentityLinkData};
pub(crate) use flowsta_vault_client::identity::{delete_identity_link, load_cached_profile, load_identity_link, save_cached_profile, save_identity_link};

// Every command that writes goes through one of these two checks. Route
// your own write commands through them too.
//
// `require_identity_link`, for everyday writes (a note, an edit, a backup).
// A person should not have to unlock their Vault for everyday use on a
// device they already signed in on:
//   - not signed in on this device               -> refused
//   - the Vault is unlocked as ANOTHER identity  -> refused (someone else
//     is demonstrably at this computer)
//   - the Vault is closed or locked              -> allowed, as the
//     signed-in identity
//
// `require_identity_match`, for the few things that COPY FROM the live
// Vault (the profile cache, the private network's secret). Closed or
// locked also refuses: what they take comes from whoever is there.

pub(crate) const ERR_NOT_LINKED: &str = "Sign in with Flowsta first";
pub(crate) const ERR_VAULT_UNCONFIRMED: &str = "Flowsta Vault is not running. Open it, then try again.";
pub(crate) const ERR_VAULT_LOCKED: &str = "Your Flowsta Vault is locked. Unlock it, then try again.";
pub(crate) const ERR_IDENTITY_MISMATCH: &str =
    "Your Flowsta Vault holds a different identity than the one signed in here. Switch identity in your Vault, or disconnect here and sign in again.";

/// `(unlocked, identity key)` from this user's Vault right now, or None
/// when none answers.
pub(crate) async fn vault_live_identity() -> Option<(bool, Option<String>)> {
    crate::vault_probe::client().live_identity().await
}

fn refusal(why: flowsta_vault_client::identity::Refusal) -> String {
    use flowsta_vault_client::identity::Refusal;
    match why {
        Refusal::NotLinked => ERR_NOT_LINKED,
        Refusal::VaultNotRunning => ERR_VAULT_UNCONFIRMED,
        Refusal::VaultLocked => ERR_VAULT_LOCKED,
        Refusal::OtherIdentity => ERR_IDENTITY_MISMATCH,
    }
    .to_string()
}

pub(crate) async fn require_identity_match(state: &Arc<AppState>) -> Result<IdentityLinkData, String> {
    flowsta_vault_client::identity::require_identity_match(crate::vault_probe::client(), &state.data_dir).await.map_err(refusal)
}

pub(crate) async fn require_identity_link(state: &Arc<AppState>) -> Result<IdentityLinkData, String> {
    flowsta_vault_client::identity::require_identity_link(crate::vault_probe::client(), &state.data_dir).await.map_err(refusal)
}

#[tauri::command]
pub fn get_cached_profile(state: tauri::State<'_, Arc<AppState>>) -> Option<CachedProfile> {
    load_cached_profile(&state.data_dir)
}

#[tauri::command]
pub async fn save_profile_cache(state: tauri::State<'_, Arc<AppState>>, display_name: Option<String>, profile_picture: Option<String>) -> Result<(), String> {
    // Checked here, not left to the page: another identity's name or
    // picture must never be kept as this profile's.
    require_identity_match(&state).await?;
    save_cached_profile(&state.data_dir, &CachedProfile { display_name, profile_picture });
    Ok(())
}

/// The last step of sign-in: write the link record the Vault signed.
#[tauri::command]
pub async fn commit_identity_link(state: tauri::State<'_, Arc<AppState>>, vault_agent_pub_key: String, vault_signature: String) -> Result<String, String> {
    // Never rebind this profile to another identity than the one it is
    // signed in as. Disconnecting first is the explicit way.
    let previous = load_identity_link(&state.data_dir);
    if previous.as_ref().is_some_and(|p| p.vault_agent_pub_key != vault_agent_pub_key) {
        return Err(ERR_IDENTITY_MISMATCH.into());
    }
    // And the identity being linked is the one that is there.
    let (unlocked, live) = vault_live_identity().await.ok_or(ERR_VAULT_UNCONFIRMED)?;
    if !unlocked {
        return Err(ERR_VAULT_LOCKED.into());
    }
    if live.as_deref() != Some(vault_agent_pub_key.as_str()) {
        return Err(ERR_IDENTITY_MISMATCH.into());
    }

    let client = state.board.lock().await;
    let client = client.as_ref().ok_or("Holochain is not ready yet")?;

    #[derive(serde::Serialize, Debug)]
    struct CreateExternalLinkInput {
        external_agent: AgentPubKey,
        external_signature: Vec<u8>,
    }
    use base64::Engine;
    let input = CreateExternalLinkInput {
        external_agent: parse_agent_pub_key_string(&vault_agent_pub_key)?,
        external_signature: base64::engine::general_purpose::STANDARD.decode(&vault_signature).map_err(|e| format!("Invalid signature: {}", e))?,
    };
    let result = call_zome(client, BOARD, AGENT_LINKING_ZOME, "create_external_link", crate::hc::encode(&input)?).await?;
    let link_hash: ActionHash = crate::hc::decode(&result)?;
    let link_hash = link_hash.to_string();

    // Signing in again replaces the link: the one before it is revoked, so
    // links do not pile up (the file remembers only the newest).
    if let Some(old) = previous.filter(|p| p.entry_action_hash != link_hash) {
        if let Ok(old_hash) = ActionHash::try_from(old.entry_action_hash) {
            if let Err(e) = call_zome(client, BOARD, AGENT_LINKING_ZOME, "revoke_link", crate::hc::encode(&old_hash)?).await {
                log::warn!("the earlier identity link was not revoked: {}", e);
            }
        }
    }

    save_identity_link(&state.data_dir, &IdentityLinkData { vault_agent_pub_key: vault_agent_pub_key.clone(), entry_action_hash: link_hash.clone(), linked_at: unix_secs() as i64 });
    // The profile this install runs in now belongs to that identity.
    crate::profiles::bind_profile(&state.device_root, &state.data_dir, &vault_agent_pub_key);
    Ok(link_hash)
}

#[tauri::command]
pub fn get_identity_link(state: tauri::State<'_, Arc<AppState>>) -> Option<IdentityLinkData> {
    load_identity_link(&state.data_dir)
}

/// Disconnect (`disconnect.rs`). It always completes on this device: the
/// link and the cached profile go first, then the link record is revoked on
/// the network; a revoke the network does not take is tried again at the
/// next starts and never leaves the person signed in with an error.
#[tauri::command]
pub async fn revoke_identity_link(state: tauri::State<'_, Arc<AppState>>) -> Result<(), String> {
    if let Some(link) = load_identity_link(&state.data_dir) {
        crate::disconnect::owe(&state.data_dir, crate::disconnect::Owed { entry_action_hash: link.entry_action_hash });
        // This device first, the cached profile included: the next sign-in
        // may be another person's.
        delete_identity_link(&state.data_dir);
        flowsta_vault_client::identity::delete_cached_profile(&state.data_dir);
        log::info!("[disconnect] this device no longer holds the link to the identity");
    }
    crate::disconnect::settle(state.inner()).await;
    // Telling the Vault is the page's part (the SDK's
    // `revokeFlowstaIdentity`): it waits for the Vault's answer and says
    // what it did, then clears the link token (`clear_vault_link_token`).
    Ok(())
}

/// The keys linked to `agent` on the board's network.
pub(crate) async fn linked_agent_keys(state: &Arc<AppState>, agent: &AgentPubKey) -> Result<Vec<AgentPubKey>, String> {
    let client = state.board.lock().await;
    let client = client.as_ref().ok_or("Holochain is not ready yet")?;
    let result = call_zome(client, BOARD, AGENT_LINKING_ZOME, "get_linked_agents", crate::hc::encode(agent)?).await?;
    crate::hc::decode(&result)
}

/// By the key itself: the saved identity key comes from the Vault as text,
/// and its location bytes need not match the network's copy.
pub(crate) fn links_this_identity(linked: &[AgentPubKey], identity: Option<&AgentPubKey>) -> bool {
    match identity {
        Some(identity) => linked.iter().any(|k| k.get_raw_32() == identity.get_raw_32()),
        None => !linked.is_empty(),
    }
}

/// Whether the network links this device's key to the identity signed in
/// here. The page asks after a start: a profile whose link file says
/// "signed in" but whose record is not on the network (a wiped device, a
/// link revoked from another device) signs in again.
#[tauri::command]
pub async fn identity_linked_on_network(state: tauri::State<'_, Arc<AppState>>, agent_pub_key: String) -> Result<bool, String> {
    let agent = AgentPubKey::try_from(agent_pub_key).map_err(|e| format!("Invalid agent key: {:?}", e))?;
    let linked = linked_agent_keys(state.inner(), &agent).await?;
    let identity = load_identity_link(&state.data_dir).and_then(|l| parse_agent_pub_key_string(&l.vault_agent_pub_key).ok());
    Ok(links_this_identity(&linked, identity.as_ref()))
}

/// The last set `get_my_agent_set` logged: it logs only a change.
static LAST_AGENT_SET: Mutex<Option<Vec<String>>> = Mutex::new(None);

/// Every key that is THIS person on the board: this device's, and those of
/// their other devices signed in as the same identity. For recognition
/// only ("is this note mine?"), never for permission: the rules let only
/// the key that wrote a note change it.
///
/// Two hops through the links: this device's key -> the identity it is
/// linked to -> every key linked to that identity. The other devices' links
/// arrive over the network, so the set can grow in the first minutes after
/// a start: the page asks again on its interval.
#[tauri::command]
pub async fn get_my_agent_set(state: tauri::State<'_, Arc<AppState>>) -> Result<Vec<String>, String> {
    let local = state.agent_pub_key.lock().unwrap().clone();
    let Some(local) = local.and_then(|k| AgentPubKey::try_from(k).ok()) else {
        return Ok(Vec::new());
    };
    let mut set = vec![local.clone()];
    match linked_agent_keys(state.inner(), &local).await {
        Ok(identities) => {
            for identity in identities {
                match linked_agent_keys(state.inner(), &identity).await {
                    Ok(siblings) => set.extend(siblings.into_iter().filter(|s| *s != local)),
                    Err(e) => log::warn!("[identity] the identity's other keys were not read: {}", e),
                }
            }
        }
        Err(e) => log::warn!("[identity] this device's links were not read: {}", e),
    }
    let mut out: Vec<String> = set.iter().map(|a| a.to_string()).collect();
    out.sort();
    out.dedup();
    let mut last = LAST_AGENT_SET.lock().unwrap();
    if last.as_deref() != Some(out.as_slice()) {
        log::info!("[identity] this person's keys on the board: {} ({:?})", out.len(), out);
        *last = Some(out.clone());
    }
    Ok(out)
}

// ── The Vault backup ──────────────────────────────────────────────────
//
// The page backs the person's own notes up to their Vault (the SDK's
// `startAutoBackup`, with `notes::build_backup` as its data). The Vault
// keeps it encrypted on the person's devices; nothing goes to a server.
// What the last attempt did is kept here so the Identity page and the log
// can say it.

#[derive(serde::Serialize, serde::Deserialize, Clone, Debug)]
pub struct BackupOutcome {
    /// "saved" or "skipped".
    pub status: String,
    /// The reason, when it was not saved.
    pub detail: Option<String>,
    pub at: u64,
}

#[tauri::command]
pub fn report_backup_outcome(state: tauri::State<'_, Arc<AppState>>, status: String, detail: Option<String>) {
    match &detail {
        Some(d) => log::info!("[backup] {}: {}", status, d),
        None => log::info!("[backup] {}", status),
    }
    *state.last_backup_outcome.lock().unwrap() = Some(BackupOutcome { status, detail, at: unix_secs() });
}

#[tauri::command]
pub fn get_last_backup_outcome(state: tauri::State<'_, Arc<AppState>>) -> Option<BackupOutcome> {
    state.last_backup_outcome.lock().unwrap().clone()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_quiet_moment_is_a_minute_after_the_last_write_with_no_call_waiting() {
        assert!(quiet_at(1000, 900, 0));
        assert!(!quiet_at(1000, 950, 0), "a write 50 s ago");
        assert!(!quiet_at(1000, 0, 1), "a call is waiting");
        assert!(only_reads("get_notes") && only_reads("get_notes_local"));
        assert!(!only_reads("create_note") && !only_reads("edit_note"));
    }

    #[test]
    fn a_link_to_this_identity_is_told_by_the_key_itself() {
        let key = |n: u8| AgentPubKey::from_raw_32(vec![n; 32]);
        let other_location = AgentPubKey::from_raw_36(key(1).get_raw_32().iter().copied().chain([9, 9, 9, 9]).collect());
        assert!(links_this_identity(&[key(1)], Some(&other_location)), "the same key with other location bytes");
        assert!(!links_this_identity(&[key(2)], Some(&key(1))));
        assert!(!links_this_identity(&[], None) && links_this_identity(&[key(2)], None));
    }

    #[test]
    fn a_rule_s_refusal_is_shown_in_its_own_words() {
        let raw = r#"Conductor returned an error: InternalError("Source chain error: InvalidCommit error: Only a note's author can edit it")"#;
        assert!(friendly_error("CellNotRunning").contains("still starting"));
        assert!(friendly_error("request Timeout").contains("timed out"));
        assert_eq!(friendly_error(raw), "Only a note's author can edit it");
        assert_eq!(friendly_error("Source chain error: InvalidCommit error: A note cannot be empty"), "A note cannot be empty");
        assert!(friendly_error("something else entirely").starts_with("Something went wrong"));
    }

    #[test]
    fn files_that_do_not_belong_together_are_cleared_and_the_seed_is_kept_aside() {
        let dir = tempfile::tempdir().unwrap();
        let profile = dir.path().to_path_buf();
        std::fs::write(profile.join("lair-passphrase"), "old").unwrap();
        std::fs::create_dir_all(profile.join("conductor")).unwrap();
        std::fs::write(profile.join(crate::names::RECOVERY_FILE), "{}").unwrap();
        let state = AppState::new(profile.clone(), profile.clone());
        assert_ne!(*state.passphrase.lock().unwrap(), "old", "a passphrase with no key store is not kept");
        assert!(!profile.join("conductor").exists());
        assert!(!profile.join(crate::names::RECOVERY_FILE).exists(), "the old key is not used again");
        let kept = std::fs::read_dir(&profile).unwrap().flatten().filter(|e| e.file_name().to_string_lossy().contains(".replaced-")).count();
        assert_eq!(kept, 1, "and its seed is kept, not deleted");
    }
}
