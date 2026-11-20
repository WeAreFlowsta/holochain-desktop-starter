//! The conductor's life: starting it, watching it, restarting it, stopping it.
//!
//! The app runs one Holochain 0.7.1 conductor and its key store as child
//! processes. The processes themselves (their configs, their clean stop,
//! whether they still run) belong to `flowsta-hc-lines`: its `Supervisor`
//! owns them, and this file tells it what this app's line needs
//! (`StarterLine`, the library's `LineHooks`).
//!
//! ## For a fork
//!
//! This file is reusable as it stands. What you might change:
//!   - the bootstrap and relay URLs and the optional auth material, set at
//!     build time (see "Bootstrap configuration" below). The defaults are
//!     the Holochain ecosystem's public test servers, so a fresh fork
//!     builds and runs with no server of its own. They are for trying
//!     things out: run your own before you release (README, "Servers").
//!   - what a start installs: `setup` calls `dna.rs`.

use crate::hc::{Line, LINE};
use crate::lair;
use crate::sidecar::sidecar_path;
use flowsta_hc_lines::conductor::NetworkTuning;
use flowsta_hc_lines::keystore::SocketPlan;
use flowsta_hc_lines::rendezvous::Rendezvous;
use flowsta_hc_lines::supervisor::{self, LineHooks, LineProcess, LineStart, Role, Setup, StartStep, Supervisor, Timeouts};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, LazyLock};
use tauri::Emitter;

/// The conductor's admin port.
pub fn admin_port() -> u16 {
    crate::names::ADMIN_PORT + test_port_offset()
}

/// A debug build adds `STARTER_TEST_PORT_OFFSET` to the admin port, so test
/// instances run beside each other and beside an installed copy. A release
/// build never reads it.
fn test_port_offset() -> u16 {
    #[cfg(debug_assertions)]
    if let Some(n) = std::env::var("STARTER_TEST_PORT_OFFSET").ok().and_then(|v| v.trim().parse::<u16>().ok()) {
        return n;
    }
    0
}

/// The conductor's and the key store's folders in a profile.
pub const CONDUCTOR_DIR: &str = "conductor";
pub const LAIR_DIR: &str = "lair";
/// Every folder that belongs to the line. A wipe names both: a reset that
/// left the key store behind kept it encrypted under the old passphrase,
/// and the line failed to start.
pub const LINE_DIRS: &[&str] = &[CONDUCTOR_DIR, LAIR_DIR];

// ── Your servers ────────────────────────────────────────────────────
//
// Read at build time: from the environment (the release workflow sets them
// from repository secrets) or from `.env` (`build.rs` passes them on).
// Unset, the app uses the public Holochain test servers.
//
//   STARTER_BOOTSTRAP_URL=https://bootstrap.example.org
//   STARTER_RELAY_URL=https://bootstrap.example.org./
//   STARTER_AUTH_MATERIAL=<standard base64, with = padding>
//
// `STARTER_AUTH_MATERIAL` is only for a bootstrap server that runs with an
// authentication hook. The same value goes to the bootstrap and to the
// relay: they authenticate separately even when one address serves both.
// It must be standard base64 (the `+/` alphabet) WITH its `=` padding, or
// the conductor refuses to start; `build.rs` checks it. Encode with
// `base64 -w0`.

/// The public Holochain test server: fine for trying things out, not for a
/// release. Set `STARTER_BOOTSTRAP_URL` before you release.
const DEFAULT_BOOTSTRAP_URL: &str = "https://dev-test-bootstrap2.holochain.org";

/// An empty value counts as unset: a workflow that names a secret nobody
/// set passes the empty string.
macro_rules! env_or {
    ($var:literal, $default:expr) => {
        match option_env!($var) {
            Some(s) if !s.is_empty() => s,
            _ => $default,
        }
    };
}

fn bootstrap_url() -> &'static str {
    env_or!("STARTER_BOOTSTRAP_URL", DEFAULT_BOOTSTRAP_URL)
}

/// The relay, when one is set. Unset, the lines library uses the bootstrap
/// server's own host (in Holochain 0.7 the bootstrap server is the relay
/// too), so an app that sets only `STARTER_BOOTSTRAP_URL` never relays
/// through, or sends its auth to, anyone else's server.
fn relay_url() -> Option<&'static str> {
    match option_env!("STARTER_RELAY_URL") {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
    }
}

fn auth_material() -> Option<&'static str> {
    match option_env!("STARTER_AUTH_MATERIAL") {
        Some(s) if !s.is_empty() => Some(s),
        _ => None,
    }
}

/// The library's supervisor: it owns the key store and the conductor.
static SUPERVISOR: LazyLock<Arc<Supervisor>> = LazyLock::new(|| Arc::new(Supervisor::new(crate::names::ORIGIN_PREFIX)));

pub fn supervisor() -> &'static Arc<Supervisor> {
    &SUPERVISOR
}

/// The conductor's pid and its admin and app ports, while it runs.
pub fn conductor_pid() -> Option<u32> {
    supervisor().conductor_pid(LINE)
}

pub fn ports() -> Option<(u16, u16)> {
    supervisor().ports(LINE)
}

/// Stop the conductor and its key store for good in this process, the
/// conductor asked to shut down before its key store (blocking): the app's
/// exit, an update's install. Each ends with the app closing or starting
/// again as a new process, so nothing here starts them again: the watch
/// stands down and a restart is refused.
pub fn stop_lines() {
    log::info!("Shutting down the conductor and its key store...");
    CLOSING.store(true, Ordering::SeqCst);
    if supervisor().stop() {
        log::info!("The conductor and its key store stopped");
    }
}

/// Set once the app has stopped its lines on purpose (`stop_lines`).
static CLOSING: AtomicBool = AtomicBool::new(false);

/// What a restart says when the app has stopped its lines for good.
const CLOSING_NO_RESTART: &str = "the app is closing: the conductor stays stopped";

/// Conductor status reported to the frontend.
#[derive(Clone, serde::Serialize, serde::Deserialize)]
#[serde(tag = "status")]
pub enum ConductorStatus {
    #[serde(rename = "stopped")]
    Stopped,
    #[serde(rename = "starting")]
    Starting { message: String },
    #[serde(rename = "ready")]
    Ready { admin_port: u16, app_port: u16 },
    #[serde(rename = "error")]
    Error { message: String },
}

/// The one origin the conductor's admin and app interfaces accept: a random
/// value made new at every start of the conductor (the library's supervisor keeps it). It is
/// written into the conductor's config file, which only this OS account can
/// read, and presented by every connection this app opens. A web page always
/// presents its own address as its origin, and another account on the device
/// cannot read the file, so neither can open these interfaces.
pub fn node_origin() -> String {
    supervisor().origin_or_fresh()
}

/// Where the key store's socket goes when its own folder's path is over
/// the Unix-socket limit (a short folder under the system's temp place).
pub fn socket_plan() -> SocketPlan {
    SocketPlan::new(crate::names::ORIGIN_PREFIX, "lair")
}

/// The key store's and the conductor's folders in the profile.
pub fn line_dirs(data_dir: &Path) -> (PathBuf, PathBuf) {
    (data_dir.join(LAIR_DIR), data_dir.join(CONDUCTOR_DIR))
}

/// The conductor's settings. `request_timeout_s: 60` and `db_sync_level:
/// Normal` are settings Flowsta's own apps have run with.
///
/// NO gossip cap: the conductor this app ships checks what a peer offers
/// in chunks (github.com/WeAreFlowsta/holochain-build, patches on 0.7.1),
/// so Kitsune2's own limit applies. The official 0.7.1 binary needs a cap
/// instead (its check fails above about 10.9k offered ids,
/// holochain/holochain#6062): if you ship that one, set
/// `gossip_max_op_bytes` here (README, "The conductor you ship").
fn tuning() -> NetworkTuning {
    let mut t = NetworkTuning::for_line(LINE);
    t.request_timeout_s = Some(60);
    t.db_sync_level = Some("Normal".into());
    t.gossip_max_op_bytes = None;
    t.connect_timeout_s = Some(CONNECT_TIMEOUT_S);
    t
}

/// How long the conductor waits to connect to one peer (Kitsune2's own wait
/// is 60 s). Every conductor start has a new network address, and the one
/// before it stays in other peers' lists for a while: each try at it held a
/// peer's sync for the whole wait. Measured with two devices of one identity
/// in Flowsta Vault: after one restarted, a record written on
/// the other arrived in 40 to 214 s and once not within ten minutes at 60 s;
/// in 2 to 111 s at 15 s. A peer that is there answers in under a second.
const CONNECT_TIMEOUT_S: u32 = 15;

/// The rendezvous as this start uses it: with its auth when it answers (or
/// there is none to carry), without it when nothing answers.
async fn rendezvous() -> Rendezvous {
    let with_auth = rendezvous_answers(bootstrap_url()).await;
    supervisor().set_rendezvous(LINE, Some(bootstrap_url()));
    Rendezvous {
        signal_url: None,
        auth_material: auth_material().filter(|_| with_auth).map(str::to_string),
        relay_url: relay_url().map(str::to_string),
        ..Rendezvous::new(bootstrap_url())
    }
}

fn step_message(step: StartStep) -> &'static str {
    match step {
        StartStep::KeyStore => "Starting the key store...",
        StartStep::Connect | StartStep::Agents => "Connecting to the key store...",
        StartStep::Conductor => "Starting Holochain...",
        _ => "Waiting for Holochain...",
    }
}

/// What a start gives the app.
pub struct StartupResult {
    pub admin_port: u16,
    pub app_port: u16,
    /// The device's key, on both networks.
    pub agent_key: String,
    pub clients: crate::dna::Clients,
    pub lair_client: lair_keystore_api::LairClient,
}

/// What the line leaves for the app once it has joined.
#[derive(Default)]
struct Joined {
    agent: Option<holochain_types::prelude::AgentPubKey>,
    clients: Option<crate::dna::Clients>,
    lair_client: Option<lair_keystore_api::LairClient>,
}

/// What this app's line needs from the app (the library's `LineHooks`).
struct StarterLine {
    app: tauri::AppHandle,
    data_dir: PathBuf,
    resource_dir: PathBuf,
    passphrase: String,
    out: tokio::sync::Mutex<Joined>,
}

impl StarterLine {
    fn say(&self, message: &str) {
        let _ = self.app.emit("conductor-status", ConductorStatus::Starting { message: message.into() });
    }
}

/// A key store that just came up may take a moment to accept a connection
/// (on Windows the named pipe registers a second or two after the process
/// starts).
async fn connect_retrying<C, F, Fut>(mut connect: F) -> Result<C, String>
where
    F: FnMut() -> Fut,
    Fut: std::future::Future<Output = Result<C, String>>,
{
    let mut last = String::new();
    for _ in 0..40 {
        match connect().await {
            Ok(c) => return Ok(c),
            Err(e) => last = e,
        }
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
    }
    Err(last)
}

#[async_trait::async_trait]
impl LineHooks for StarterLine {
    async fn start(&self, line: Line, _role: Role) -> Result<LineProcess, String> {
        // The conductor port must be free. Anything answering on it now is a
        // conductor that is not ours (a second running copy of the app, or
        // one an earlier launch left behind that the startup sweep could
        // not stop). Attaching to it would run this profile on another
        // profile's data. Refuse instead; before the spawn is the only
        // moment this is certain.
        let port = admin_port();
        if let Ok(Ok(_)) = tokio::time::timeout(std::time::Duration::from_millis(400), tokio::net::TcpStream::connect(("127.0.0.1", port))).await {
            return Err(format!("Another {} is already running on this computer (port {} is in use). Quit it and open the app again.", crate::names::APP_NAME, port));
        }
        let (lair_bin, conductor_bin) = (sidecar_path(crate::names::LAIR), sidecar_path(crate::names::CONDUCTOR));
        let (lair_dir, conductor_dir) = line_dirs(&self.data_dir);
        let rendezvous = rendezvous().await;
        let origin = supervisor().fresh_origin();
        supervisor::start_line(
            &LineStart {
                line,
                lair_bin: &lair_bin,
                conductor_bin: &conductor_bin,
                lair_dir: &lair_dir,
                conductor_dir: &conductor_dir,
                passphrase: &self.passphrase,
                sockets: &socket_plan(),
                admin_ports: &[port],
                origin: &origin,
                rendezvous: &rendezvous,
                tuning: &tuning(),
                // The device's key is put into the key store by `setup`
                // (`device_seed`), from the seed the app keeps.
                agents: &[],
                timeouts: Timeouts::default(),
            },
            |step| self.say(step_message(step)),
        )
        .await
        .map_err(|e| e.to_string())
    }

    /// Once the conductor is up: the device's key, the board, and my notes
    /// when this device already has them. The conductor restarts once when
    /// this start installed anything (Holochain 0.7.1 keeps about 2 GB
    /// after a first install until it restarts, holochain#6064); the
    /// library calls `setup` again after it.
    async fn setup(&self, _line: Line, _role: Role, process: &mut LineProcess) -> Result<Setup, String> {
        self.say("Setting up...");
        let lair_client = connect_retrying(|| lair::connect_to_lair(&process.lair_url, &self.passphrase)).await?;
        let agent = crate::device_seed::ensure_device_agent(&lair_client, &self.data_dir).await.map_err(|e| format!("The device's key could not be set up: {}", e))?;
        let installed_now = crate::dna::ensure_installed(process.admin_port, &self.resource_dir, &agent, crate::dna::BOARD, Some(crate::names::BOARD_NETWORK.to_string())).await?;
        if installed_now {
            log::info!("installed this start: the conductor restarts once to give back the memory the install kept");
            self.say("Restarting Holochain once after setup...");
            return Ok(Setup { app_port: 0, restart: true });
        }
        // My notes, when this device has them: enabled again. They are
        // first installed from the page, once the Vault has given the
        // person's secret (`notes::set_up_my_notes`).
        if crate::dna::is_installed(process.admin_port, crate::dna::MY_NOTES).await? {
            crate::dna::ensure_installed(process.admin_port, &self.resource_dir, &agent, crate::dna::MY_NOTES, None).await?;
        }
        let clients = crate::dna::connect(process.admin_port, &lair_client).await?;
        let app_port = clients.app_port;
        let mut out = self.out.lock().await;
        out.agent = Some(agent);
        out.clients = Some(clients);
        out.lair_client = Some(lair_client);
        Ok(app_port.into())
    }

    async fn joined(&self, line: Line, _role: Role, _session: u64, admin_port: u16, app_port: u16) {
        log::info!("[{line}] Holochain is ready (admin: {}, app: {})", admin_port, app_port);
    }

    async fn secondary_failed(&self, line: Line, error: &str) {
        log::warn!("[{line}] did not start: {error}");
    }

    /// A start still coming up when the app stops for good stops at its
    /// next step.
    fn wanted(&self) -> bool {
        !CLOSING.load(Ordering::SeqCst)
    }
}

/// Start Holochain: one full startup; on failure, the right recovery for
/// the kind of error, and one more try.
///
/// 1. The key store or the conductor's databases cannot be opened with the
///    passphrase on disk (SQLCipher's "hmac check failed": typical after a
///    partial uninstall left some files behind). Nothing in those folders
///    can be read again, so they are set aside by a wipe and the device
///    starts fresh under a new key (`commands::reset_local_state` says what
///    that means for the person's notes).
/// 2. Anything else: usually a brief network or file-lock hiccup at a first
///    start. Stop what is left, wait, try once more on fresh processes.
pub async fn start_holochain(
    app_handle: tauri::AppHandle,
    app_state: std::sync::Arc<crate::commands::AppState>,
    data_dir: PathBuf,
    resource_dir: PathBuf,
    passphrase: String,
) -> Result<StartupResult, String> {
    let first_err = match start_holochain_attempt(app_handle.clone(), data_dir.clone(), resource_dir.clone(), passphrase.clone()).await {
        Ok(result) => return Ok(result),
        Err(e) => e,
    };

    let is_hmac_error = first_err.contains("hmac check failed") || first_err.contains("SQL logic error") || first_err.contains("error decrypting page");

    let retry_passphrase = if is_hmac_error {
        log::warn!("[start] the local databases cannot be opened with the passphrase on disk: resetting local state: {}", first_err);
        let _ = app_handle.emit("conductor-status", ConductorStatus::Starting { message: "Recovering from corrupted state. Setting up again...".into() });
        crate::commands::reset_local_state(&data_dir, &app_state)
    } else {
        log::warn!("[start] the first attempt failed: {}: trying once more", first_err);
        let _ = app_handle.emit("conductor-status", ConductorStatus::Starting { message: "First-run setup needs a quick restart...".into() });
        passphrase
    };

    // Brief pause so the admin ports are released and any process tear-down
    // completes before the second attempt binds the same resources.
    tokio::time::sleep(std::time::Duration::from_secs(2)).await;

    start_holochain_attempt(app_handle, data_dir, resource_dir, retry_passphrase).await
}

/// One full startup attempt.
async fn start_holochain_attempt(app_handle: tauri::AppHandle, data_dir: PathBuf, resource_dir: PathBuf, passphrase: String) -> Result<StartupResult, String> {
    STARTED_OFFLINE.store(false, Ordering::SeqCst);
    let hooks = Arc::new(StarterLine { app: app_handle.clone(), data_dir, resource_dir, passphrase, out: tokio::sync::Mutex::new(Joined::default()) });
    if let Err(e) = supervisor().start_lines(LINE, None, hooks.clone()).await {
        let _ = tokio::task::spawn_blocking(|| supervisor().stop()).await;
        return Err(e);
    }
    let mut out = hooks.out.lock().await;
    let agent = out.agent.take().ok_or("Holochain started without the device's key")?;
    let clients = out.clients.take().ok_or("Holochain started without its clients")?;
    let lair_client = out.lair_client.take().ok_or("Holochain started without its key store client")?;
    drop(out);
    // The library's keeper (once a process): each minute it sees that this
    // device's own address is on the rendezvous, puts it back when the
    // conductor's own registration did not reach it, and hands the
    // conductor the other peers' addresses it lacks. A device that was
    // offline is found again without waiting out an address's life.
    supervisor().start_keeper([Vec::new(), vec![(bootstrap_url().to_string(), auth_material().map(str::to_string))]]);

    let (admin_port, app_port) = ports().ok_or("Holochain is not running")?;
    let _ = app_handle.emit("conductor-status", ConductorStatus::Ready { admin_port, app_port });
    log::info!("Holochain ready (admin {}, app {}; this device's key {}; my notes {})", admin_port, app_port, agent, if clients.my_notes.is_some() { "set up" } else { "not set up on this device yet" });
    Ok(StartupResult { admin_port, app_port, agent_key: agent.to_string(), clients, lair_client })
}

/// Whether this session's conductor started with no rendezvous answering,
/// and so without its auth. Holochain 0.7.1 authenticates with the
/// relay while it starts, and a conductor that cannot (no network) refuses
/// to start at all ("Authenticate Failed", exit 101). Started without the
/// auth, everything local works; the conductors restart with it once the
/// rendezvous answers again.
static STARTED_OFFLINE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn started_offline() -> bool {
    STARTED_OFFLINE.load(std::sync::atomic::Ordering::SeqCst)
}

/// Whether the config carries the auth on this start: always when there is
/// none to carry, otherwise only when the rendezvous answers.
async fn rendezvous_answers(bootstrap: &str) -> bool {
    if auth_material().is_none() || bootstrap_alive(bootstrap).await {
        return true;
    }
    log::warn!("no rendezvous answers ({}): starting without its auth; Holochain restarts with it once it answers", bootstrap);
    STARTED_OFFLINE.store(true, std::sync::atomic::Ordering::SeqCst);
    false
}

/// Whether a bootstrap server answers its health check.
async fn bootstrap_alive(url: &str) -> bool {
    #[cfg(debug_assertions)]
    if test_offline_now() {
        return false;
    }
    let client = match reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(2500))
        .build()
    {
        Ok(c) => c,
        Err(_) => return false,
    };
    let health = format!("{}/health", url.trim_end_matches('/'));
    matches!(client.get(&health).send().await, Ok(r) if r.status().is_success())
}

/// A debug build takes `STARTER_TEST_OFFLINE_UNTIL=<unix seconds>`: every
/// rendezvous check fails until then ("offline, then back" in a test). A
/// release build never reads it.
#[cfg(debug_assertions)]
fn test_offline_now() -> bool {
    std::env::var("STARTER_TEST_OFFLINE_UNTIL")
        .ok()
        .and_then(|v| v.trim().parse::<u64>().ok())
        .is_some_and(|until| {
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_secs() < until)
                .unwrap_or(false)
        })
}


/// Hand a start's results to the app: the clients, the key, Ready. From the
/// first start (`lib.rs`) and from every start after it (`restart_session`).
pub async fn apply_started(state: &std::sync::Arc<crate::commands::AppState>, app_handle: &tauri::AppHandle, result: StartupResult) {
    let ready = ConductorStatus::Ready { admin_port: result.admin_port, app_port: result.app_port };
    *state.agent_pub_key.lock().unwrap() = Some(result.agent_key);
    *state.board.lock().await = Some(result.clients.board);
    *state.my_notes.lock().await = result.clients.my_notes;
    *state.lair_client.lock().await = Some(result.lair_client);
    *state.conductor_status.lock().unwrap() = ready.clone();
    let _ = app_handle.emit("conductor-status", ready);
}

/// One start at a time after the first: the watch and the reconnect both
/// come here.
static RESTART: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Stop Holochain cleanly and start the session again from the app's
/// state: with the network's auth once the rendezvous answers, after the
/// conductor died, to give back memory, or after an install.
pub(crate) async fn restart_session(state: &std::sync::Arc<crate::commands::AppState>, app_handle: &tauri::AppHandle, message: &str) -> Result<(), String> {
    let _one = RESTART.lock().await;
    if CLOSING.load(Ordering::SeqCst) {
        return Err(CLOSING_NO_RESTART.into());
    }
    // Not Ready while it stops: nothing reads the stop as a failure.
    let starting = ConductorStatus::Starting { message: message.into() };
    *state.conductor_status.lock().unwrap() = starting.clone();
    let _ = app_handle.emit("conductor-status", starting);
    let _ = tokio::task::spawn_blocking(|| supervisor().stop()).await;
    let data_dir = state.data_dir.clone();
    let passphrase = state.passphrase.lock().unwrap().clone();
    let resource_dir = crate::resolve_resource_dir(app_handle, &state.device_root);
    let result = start_holochain(app_handle.clone(), state.clone(), data_dir, resource_dir, passphrase).await?;
    if CLOSING.load(Ordering::SeqCst) {
        // Stopped for good while this start ran: what it started goes too.
        let _ = tokio::task::spawn_blocking(|| supervisor().stop()).await;
        return Err(CLOSING_NO_RESTART.into());
    }
    apply_started(state, app_handle, result).await;
    Ok(())
}

const STOPPED_MESSAGE: &str = "Holochain stopped unexpectedly. Restart the app to reconnect.";

fn say_stopped(state: &std::sync::Arc<crate::commands::AppState>, app_handle: &tauri::AppHandle) {
    let status = ConductorStatus::Error { message: STOPPED_MESSAGE.into() };
    *state.conductor_status.lock().unwrap() = status.clone();
    let _ = app_handle.emit("conductor-status", status);
}

/// A session that started offline: once the rendezvous answers (checked
/// each minute), restart Holochain with the auth.
pub fn spawn_reconnect_when_online(state: std::sync::Arc<crate::commands::AppState>, app_handle: tauri::AppHandle) {
    if !started_offline() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(60)).await;
            if !started_offline() {
                break;
            }
            if !bootstrap_alive(bootstrap_url()).await {
                continue;
            }
            log::info!("[network] the rendezvous answers again: restarting Holochain with its auth");
            match restart_session(&state, &app_handle, "Connecting to the network...").await {
                Ok(()) => log::info!("[network] Holochain is back with the network's auth"),
                Err(e) => {
                    log::error!("[network] Holochain did not start again: {}", e);
                    say_stopped(&state, &app_handle);
                }
            }
            break;
        }
    });
}

// ── The watch ────────────────────────────────────────────────────────────

/// A conductor that died is started again (the whole session: the page's
/// clients are replaced with it), at most three times in ten minutes; after
/// that the app says so and waits for a restart.
const RECOVERIES_MOST: usize = 3;
const RECOVERIES_WITHIN: std::time::Duration = std::time::Duration::from_secs(10 * 60);

/// Restart Holochain for its memory: Holochain 0.7.1 keeps every reloaded
/// module's machine code until a restart (holochain#6064). Above 1 GiB
/// resident, after 20 minutes running, at most once in 6 hours.
const MEMORY_POLICY: flowsta_hc_lines::watch::MemoryPolicy = flowsta_hc_lines::watch::MemoryPolicy {
    over_bytes: 1 << 30,
    min_uptime: std::time::Duration::from_secs(20 * 60),
    min_gap: std::time::Duration::from_secs(6 * 60 * 60),
};

/// `MEMORY_POLICY`, or in a debug build
/// `STARTER_TEST_MEMORY_RESTART=<MB>,<uptime secs>,<gap secs>`.
fn memory_policy() -> flowsta_hc_lines::watch::MemoryPolicy {
    #[cfg(debug_assertions)]
    if let Some(p) = test_memory_policy(std::env::var("STARTER_TEST_MEMORY_RESTART").ok().as_deref()) {
        return p;
    }
    MEMORY_POLICY
}

#[cfg_attr(not(debug_assertions), allow(dead_code))]
fn test_memory_policy(v: Option<&str>) -> Option<flowsta_hc_lines::watch::MemoryPolicy> {
    let mut parts = v?.split(',').map(|x| x.trim().parse::<u64>().ok());
    let (mb, uptime, gap) = (parts.next()??, parts.next()??, parts.next()??);
    Some(flowsta_hc_lines::watch::MemoryPolicy { over_bytes: mb << 20, min_uptime: std::time::Duration::from_secs(uptime), min_gap: std::time::Duration::from_secs(gap) })
}

/// Whether one more recovery fits the limit, counting it when it does.
fn recovery_allowed(recoveries: &mut std::collections::VecDeque<std::time::Instant>, now: std::time::Instant) -> bool {
    while recoveries.front().is_some_and(|t| now.duration_since(*t) >= RECOVERIES_WITHIN) {
        recoveries.pop_front();
    }
    if recoveries.len() >= RECOVERIES_MOST {
        return false;
    }
    recoveries.push_back(now);
    true
}

/// Whether the conductor is down.
fn conductor_is_down() -> bool {
    use flowsta_hc_lines::watch::{decide, LinesNow, WatchAction, WatchPolicy};
    decide(&LinesNow::of(supervisor()), &WatchPolicy { current: LINE, limit: None }) != WatchAction::Nothing
}

static WATCHING: AtomicBool = AtomicBool::new(false);

/// Watch the conductor while the app runs (one task a process): recover it
/// when it stopped, and restart it at most once in six hours when it holds
/// over 1 GiB.
pub fn spawn_watch(state: std::sync::Arc<crate::commands::AppState>, app_handle: tauri::AppHandle) {
    if WATCHING.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut recoveries = std::collections::VecDeque::new();
        let mut last_memory_restart: Option<std::time::Instant> = None;
        let mut tick: u64 = 0;
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(3)).await;
            tick += 1;
            // Only a session the page was told is Ready: a start, a restart
            // and an intended stop are not failures.
            let ready = matches!(*state.conductor_status.lock().unwrap(), ConductorStatus::Ready { .. });
            if !ready || CLOSING.load(Ordering::SeqCst) || RESTART.try_lock().is_err() {
                continue;
            }
            if conductor_is_down() {
                if !recovery_allowed(&mut recoveries, std::time::Instant::now()) {
                    log::error!("[watch] the conductor stopped again after {} recoveries in {} min: held", RECOVERIES_MOST, RECOVERIES_WITHIN.as_secs() / 60);
                    say_stopped(&state, &app_handle);
                    continue;
                }
                log::warn!("[watch] the conductor stopped: starting it again");
                match restart_session(&state, &app_handle, "Reconnecting to Holochain...").await {
                    Ok(()) => log::info!("[watch] Holochain is back"),
                    Err(e) if e == CLOSING_NO_RESTART => {}
                    Err(e) => {
                        log::error!("[watch] Holochain did not start again: {}", e);
                        say_stopped(&state, &app_handle);
                    }
                }
                continue;
            }
            // Memory, once a minute.
            if tick % 20 != 0 {
                continue;
            }
            let policy = memory_policy();
            let since = last_memory_restart.map(|t| t.elapsed());
            let heavy = conductor_pid().and_then(flowsta_hc_lines::watch::conductor_memory).filter(|m| flowsta_hc_lines::watch::memory_restart_due(m, since, crate::commands::quiet_now(), &policy));
            if let Some(m) = heavy {
                log::info!("[memory] the conductor holds {} MB: restarting it at a quiet moment to give it back", m.resident_bytes >> 20);
                last_memory_restart = Some(std::time::Instant::now());
                if let Err(e) = restart_session(&state, &app_handle, "Restarting Holochain to free memory...").await {
                    log::error!("[memory] Holochain did not start again: {}", e);
                    say_stopped(&state, &app_handle);
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The settings the config carries, and no gossip cap (see `tuning`).
    #[test]
    fn the_conductor_keeps_its_settings() {
        let t = tuning();
        assert_eq!((t.gossip_max_op_bytes, t.request_timeout_s, t.db_sync_level.as_deref()), (None, Some(60), Some("Normal")));
        assert_eq!(t.connect_timeout_s, Some(15));
    }

    #[test]
    fn the_line_has_its_folders_in_the_profile() {
        assert_eq!(line_dirs(Path::new("/p")), (PathBuf::from("/p/lair"), PathBuf::from("/p/conductor")));
    }

    #[test]
    fn a_fourth_recovery_in_ten_minutes_is_held_and_an_old_one_stops_counting() {
        let mut r = std::collections::VecDeque::new();
        let t0 = std::time::Instant::now();
        for i in 0..RECOVERIES_MOST {
            assert!(recovery_allowed(&mut r, t0 + std::time::Duration::from_secs(i as u64)));
        }
        assert!(!recovery_allowed(&mut r, t0 + std::time::Duration::from_secs(60)), "the fourth is held");
        assert!(recovery_allowed(&mut r, t0 + RECOVERIES_WITHIN + std::time::Duration::from_secs(1)), "the first has left the window");
    }

    #[test]
    fn the_test_memory_policy_reads_three_numbers_or_nothing() {
        let p = test_memory_policy(Some("300, 60,120")).unwrap();
        assert_eq!((p.over_bytes, p.min_uptime.as_secs(), p.min_gap.as_secs()), (300 << 20, 60, 120));
        assert!(test_memory_policy(Some("300,60")).is_none() && test_memory_policy(None).is_none());
    }
}
