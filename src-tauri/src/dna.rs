//! The app's two DNAs on its conductor: installing them and talking to them.
//!
//! - **The board** (`dna/board`): one network shared by everyone running
//!   the app. Installed at the first start.
//! - **My notes** (`dna/my-notes`): a network per person. Installed the
//!   first time the person opens it signed in, with the secret their Flowsta
//!   Vault gives this app as its network seed, so only their own devices
//!   ever join it.
//!
//! Each is its own hApp, because a network seed given at install applies to
//! every DNA in a hApp. A fork that wants only one of the two deletes the
//! other's constant here, its folder under `dna/` and its tab.
//!
//! Both are installed under the device's own key (`device_seed.rs`): one
//! key per device, on both networks.
//!
//! For a fork: to add a DNA, add an `App` constant, install it in
//! `conductor.rs` (`setup`) the way the board is, connect to it in
//! [`connect`], and keep its client in `AppState` beside the other two.
//!
//! An installed app is never uninstalled by this app: its cell holds the
//! person's own records. When your DNA changes, install the new version
//! beside the old one (README, "When your DNA changes").

use crate::hc::AppClient;
use holochain_client::{AdminWebsocket, AllowedOrigins, AppStatusFilter, AppWebsocket, CellInfo, InstallAppPayload, IssueAppAuthenticationTokenPayload, LairAgentSigner};
use holochain_types::app::AppBundleSource;
use holochain_types::prelude::AgentPubKey;
use std::path::Path;

/// One of the app's hApps: what it is installed as, the file it comes from
/// and the role every zome call names (`happ.yaml`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct App {
    pub app_id: &'static str,
    pub happ: &'static str,
    pub role: &'static str,
}

pub const BOARD: App = App { app_id: "starter_board_v1", happ: crate::kits::BOARD_HAPP.name, role: "board" };
pub const MY_NOTES: App = App { app_id: "starter_my_notes_v1", happ: crate::kits::MY_NOTES_HAPP.name, role: "my_notes" };

/// The zome both DNAs keep their notes in, and the board's identity zome.
pub const NOTES_ZOME: &str = "notes";
pub const AGENT_LINKING_ZOME: &str = "agent_linking";

async fn admin(admin_port: u16) -> Result<AdminWebsocket, String> {
    AdminWebsocket::connect(format!("localhost:{}", admin_port), Some(crate::conductor::node_origin()))
        .await
        .map_err(|e| format!("Failed to connect to the conductor's admin interface: {}", e))
}

/// Whether `app` is installed on the conductor.
pub async fn is_installed(admin_port: u16, app: App) -> Result<bool, String> {
    let apps = admin(admin_port).await?.list_apps(None).await.map_err(|e| format!("Failed to list apps: {}", e))?;
    Ok(apps.iter().any(|a| a.installed_app_id == app.app_id))
}

/// Make sure `app` is installed and enabled, under the device's key.
/// `network_seed`: `None` for the shared network the DNA names itself, or
/// the person's secret for a network of their own.
///
/// Returns whether it was installed NOW. The caller then restarts the
/// conductor once: Holochain 0.7.1 keeps what an install used (about 2 GB)
/// until it restarts.
pub async fn ensure_installed(admin_port: u16, resource_dir: &Path, agent: &AgentPubKey, app: App, network_seed: Option<String>) -> Result<bool, String> {
    let admin = admin(admin_port).await?;
    let existing = admin.list_apps(None).await.map_err(|e| format!("Failed to list apps: {}", e))?;
    if existing.iter().any(|a| a.installed_app_id == app.app_id) {
        // An app already here keeps the network it was installed with: the
        // seed is not looked at again.
        admin.enable_app(app.app_id.to_string()).await.map_err(|e| format!("Failed to enable {}: {}", app.app_id, e))?;
        return Ok(false);
    }
    let happ_path = resource_dir.join(app.happ);
    if !happ_path.exists() {
        return Err(format!("The bundled file {} was not found at {:?}", app.happ, happ_path));
    }
    log::info!("Installing {} from {:?}{}", app.app_id, happ_path, if network_seed.is_some() { " on the person's own network" } else { "" });
    let payload = InstallAppPayload {
        source: AppBundleSource::Path(happ_path),
        agent_key: Some(agent.clone()),
        installed_app_id: Some(app.app_id.to_string()),
        network_seed,
        roles_settings: None,
        ignore_genesis_failure: false,
        restore_from_dht: false,
    };
    admin.install_app(payload).await.map_err(|e| format!("Failed to install {}: {}", app.app_id, e))?;
    admin.enable_app(app.app_id.to_string()).await.map_err(|e| format!("Failed to enable {}: {}", app.app_id, e))?;
    log::info!("{} installed and enabled", app.app_id);
    Ok(true)
}

/// The clients a session talks through.
pub struct Clients {
    pub app_port: u16,
    pub board: AppClient,
    /// `None` until the person's own network is set up on this device.
    pub my_notes: Option<AppClient>,
}

/// A function no zome has. Calling it asks whether a cell runs without
/// writing anything: a running cell answers that the function is missing,
/// one that is not running says so.
const IS_THE_CELL_RUNNING: &str = "__is_the_cell_running";
/// Tries of that question, 3 s apart: cells can take a few seconds after an
/// install or a restart.
const READY_TRIES: u32 = 6;

#[derive(Debug, PartialEq)]
enum CellAnswer {
    Runs,
    NotYet,
    Other(String),
}

fn cell_answer(result: &Result<Vec<u8>, String>) -> CellAnswer {
    use flowsta_hc_lines::client::{kind_of_message, ZomeErrorKind};
    match result {
        Ok(_) => CellAnswer::Runs,
        Err(e) => match kind_of_message(e) {
            ZomeErrorKind::MissingFunction => CellAnswer::Runs,
            ZomeErrorKind::CellNotRunning => CellAnswer::NotYet,
            _ => CellAnswer::Other(e.chars().take(200).collect()),
        },
    }
}

/// Open the conductor's app interface and connect to each installed app.
///
/// Zome calls are signed with the device's own key in the key store. No
/// signing grant is written to any chain, so starting the app adds nothing
/// to a person's history.
pub async fn connect(admin_port: u16, lair_client: &lair_keystore_api::LairClient) -> Result<Clients, String> {
    let admin = admin(admin_port).await?;
    let origin = crate::conductor::node_origin();
    let app_port = admin
        .attach_app_interface(0, None, AllowedOrigins::Origins(std::collections::HashSet::from([origin.clone()])), None)
        .await
        .map_err(|e| format!("Failed to open the app interface: {}", e))?;

    let mut signer = LairAgentSigner::new(std::sync::Arc::new(lair_client.clone()));
    let apps = admin.list_apps(Some(AppStatusFilter::Enabled)).await.map_err(|e| format!("Failed to list apps: {}", e))?;
    for app in &apps {
        for cell in app.cell_info.values().flatten() {
            if let CellInfo::Provisioned(provisioned) = cell {
                signer.add_credentials(provisioned.cell_id.clone(), provisioned.cell_id.agent_pubkey().clone());
            }
        }
    }
    let signer: std::sync::Arc<dyn holochain_client::AgentSigner + Send + Sync> = std::sync::Arc::new(signer);

    // One app websocket per app: a token names one installed app.
    let connect_to = |app: App| {
        let (admin, signer, origin) = (&admin, signer.clone(), origin.clone());
        async move {
            let token = admin
                .issue_app_auth_token(IssueAppAuthenticationTokenPayload::for_installed_app_id(app.app_id.into()).expiry_seconds(0).single_use(false))
                .await
                .map_err(|e| format!("Failed to issue a token for {}: {}", app.app_id, e))?;
            let ws = AppWebsocket::connect(format!("localhost:{}", app_port), token.token, signer, Some(origin))
                .await
                .map_err(|e| format!("Failed to connect to {}: {}", app.app_id, e))?;
            let client = AppClient(ws);
            for attempt in 1..=READY_TRIES {
                match cell_answer(&client.call_zome(app.role, NOTES_ZOME, IS_THE_CELL_RUNNING, vec![0xc0]).await) {
                    CellAnswer::Runs => break,
                    CellAnswer::NotYet if attempt < READY_TRIES => {
                        let _ = admin.enable_app(app.app_id.to_string()).await;
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    }
                    other => {
                        log::warn!("the {} cell did not say it runs ({:?})", app.app_id, other);
                        break;
                    }
                }
            }
            log::info!("{} connected on port {}", app.app_id, app_port);
            Ok::<_, String>(client)
        }
    };
    let board = connect_to(BOARD).await?;
    let my_notes = if apps.iter().any(|a| a.installed_app_id == MY_NOTES.app_id) {
        match connect_to(MY_NOTES).await {
            Ok(c) => Some(c),
            Err(e) => {
                log::warn!("my notes are not read this start: {}", e);
                None
            }
        }
    } else {
        None
    };
    Ok(Clients { app_port, board, my_notes })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_running_cell_is_told_from_one_that_is_not_yet() {
        assert_eq!(cell_answer(&Ok(vec![])), CellAnswer::Runs);
        assert!(matches!(cell_answer(&Err("connection reset".into())), CellAnswer::Other(_)));
    }

    #[test]
    fn the_two_apps_are_told_apart() {
        assert_ne!(BOARD.app_id, MY_NOTES.app_id);
        assert_ne!(BOARD.role, MY_NOTES.role);
        assert_ne!(BOARD.happ, MY_NOTES.happ);
    }
}
