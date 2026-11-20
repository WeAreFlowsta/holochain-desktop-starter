//! Holochain Desktop Starter: where the app starts.
//!
//! ## The modules
//!
//! Yours to change:
//! - `notes`: the commands the two tabs call. Replace with your own.
//! - `names`: the app's name, identifier, sidecars and port, in one place.
//! - `dna`: which hApps are installed, and when.
//!
//! Kept as they are by most forks:
//! - `conductor`: Holochain's life (start, watch, restart, stop), on the
//!   `flowsta-hc-lines` library.
//! - `commands`: the app's state, zome calls, the status the page reads,
//!   Flowsta sign-in, the backup's outcome.
//! - `vault_probe`, `link_token`, `profiles`, `disconnect`, `device_seed`:
//!   the Flowsta side, on the `flowsta-vault-client` library.
//! - `updater`: the app's own updates, from signed releases.
//! - `lair`, `hc`, `kits`, `sidecar`, `instance_guard`, `webview_fix`.
//! - `harness` (test builds only): the local test door the UI suite drives.
//!
//! ## A start, in order
//!
//! 1. Sweep sidecars a dead earlier launch left behind.
//! 2. Pick the profile: the one of the identity the Vault holds, else the
//!    last one used.
//! 3. In the background: the key store, the conductor, the board's hApp,
//!    the app interface. The page shows each step and then the board.
//! 4. Watch the conductor for as long as the app runs.

mod commands;
mod conductor;
mod device_seed;
mod disconnect;
mod dna;
mod hc;
mod instance_guard;
mod kits;
mod lair;
mod link_token;
mod names;
mod notes;
mod profiles;
mod sidecar;
#[cfg(test)]
mod spawn_guard;
mod updater;
mod vault_probe;
mod webview_fix;
#[cfg(feature = "harness")]
mod harness;

use commands::AppState;
use std::sync::Arc;
use tauri::Manager;

/// A debug build takes `STARTER_DATA_DIR`: a test instance's own data
/// folder on every platform (the harness runs several on one machine). A
/// release build never reads it.
fn test_data_dir() -> Option<std::path::PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(dir) = std::env::var_os("STARTER_DATA_DIR").filter(|d| !d.is_empty()) {
        return Some(std::path::PathBuf::from(dir));
    }
    None
}

/// Where the log is written: Tauri's log folder, except on macOS, where it
/// goes to `~/Library/Logs/<the app's name>` (the folder people and support
/// tools look in). Returns the target and, when older logs were moved there,
/// a line saying so.
fn log_target(app: &tauri::App) -> (tauri_plugin_log::TargetKind, Option<String>) {
    let file_name = Some(names::LOG_FILE_NAME.to_string());
    #[cfg(target_os = "macos")]
    if let Some((old, new)) = app.path().app_log_dir().ok().and_then(|old| {
        let new = old.parent()?.join(names::LOG_FOLDER_NAME);
        Some((old, new))
    }) {
        let moved = (old.is_dir() && !new.exists()).then(|| match std::fs::rename(&old, &new) {
            Ok(()) => format!("[log] the older logs moved from {:?} to {:?}", old, new),
            Err(e) => format!("[log] the older logs stay in {:?}: {}", old, e),
        });
        return (tauri_plugin_log::TargetKind::Folder { path: new, file_name }, moved);
    }
    let _ = app;
    (tauri_plugin_log::TargetKind::LogDir { file_name }, None)
}

static WEBVIEW_FIX: std::sync::OnceLock<webview_fix::Outcome> = std::sync::OnceLock::new();

/// Whether the main window has had the focus since this launch.
static WINDOW_HAD_FOCUS: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// Show the main window, in front and with the focus, and say so in the log.
fn bring_to_front(app: &tauri::AppHandle, when: &str) {
    if let Some(win) = app.get_webview_window("main") {
        let had_focus = WINDOW_HAD_FOCUS.load(std::sync::atomic::Ordering::Relaxed);
        let _ = win.show();
        let _ = win.unminimize();
        let _ = win.set_focus();
        log::info!("[window] brought to the front {when} (it had {} the focus since launch)", if had_focus { "had" } else { "not had" });
    }
}

pub fn run() {
    // Started as the library's stop helper (`--hc-lines-interrupt <pid>`,
    // Windows): raise Ctrl-C in that sidecar's console and exit, before
    // anything of the app starts. Otherwise this notes that the executable
    // can be that helper, and a conductor is asked to shut down before it
    // is ended on Windows too.
    flowsta_hc_lines::process::interrupt_helper_or_continue();
    // Started as a sidecar's watcher (`--watch-sidecar <app pid> <sidecar
    // pid>`, macOS): wait for either to end, stop the sidecar if the app
    // went first, and exit, before anything of the app starts. Otherwise
    // this turns the watchers on: on a Mac nothing else ends the conductor
    // and the key store when the app is force-quit or crashes.
    flowsta_hc_lines::sidecar_watcher::run_as_sidecar_watcher_if_asked();

    // First, before anything starts a thread: on Linux with the NVIDIA driver
    // loaded, WebKitGTK 2.52 segfaults on a page change when NVIDIA's EGL
    // draws the window. The fix sets environment variables for the webview
    // only (the sidecars never inherit them).
    let _ = WEBVIEW_FIX.set(webview_fix::apply());
    let builder = tauri::Builder::default();
    // The embedded WebDriver the UI suite drives: the `e2e` feature only,
    // never a release build (scripts/check-test-features.mjs).
    #[cfg(feature = "e2e")]
    let builder = builder.plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .plugin(tauri_plugin_shell::init())
        .on_window_event(|_window, event| {
            if let tauri::WindowEvent::Focused(true) = event {
                WINDOW_HAD_FOCUS.store(true, std::sync::atomic::Ordering::Relaxed);
            }
        })
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let data_dir = match test_data_dir() {
                Some(dir) => dir,
                None => app.path().app_data_dir().expect("Failed to get app data directory"),
            };
            std::fs::create_dir_all(&data_dir).expect("Failed to create data directory");

            // Log to file (and stdout in dev) at INFO level in both dev and
            // release builds. Release-build silence would make any startup
            // failure invisible to users (and to us); the cost of a small
            // rolling log file is worth the diagnosability.
            let (log_file, log_moved) = log_target(app);
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    // The plugin's defaults are a 40 KB file that is DELETED
                    // when full: half an hour of status lines erased the
                    // start. 2 MB, and the two previous files kept.
                    .max_file_size(2_000_000)
                    .rotation_strategy(tauri_plugin_log::RotationStrategy::KeepSome(2))
                    .targets([
                        tauri_plugin_log::Target::new(log_file),
                        tauri_plugin_log::Target::new(tauri_plugin_log::TargetKind::Stdout),
                    ])
                    .build(),
            )?;

            log::info!("{} starting up (v{})", names::APP_NAME, env!("CARGO_PKG_VERSION"));
            if let Some(moved) = log_moved {
                log::info!("{}", moved);
            }
            log::info!("Data dir: {:?}", data_dir);

            // Sidecars a dead earlier launch left behind (a crash, a forced
            // quit, macOS replacing a running app) would still hold the
            // conductor's port. Stop them before anything of ours starts. A
            // second running copy of the app keeps its own.
            let reaped = instance_guard::reap_orphaned_sidecars();
            if reaped > 0 {
                log::warn!("[instance] {} orphaned sidecar(s) from an earlier launch stopped", reaped);
            }

            let live = tauri::async_runtime::block_on(commands::vault_live_identity());
            let live_identity = live.clone().and_then(|(unlocked, key)| if unlocked { key } else { None });
            // "Open as this identity" asked for this start (read once).
            let relaunched = vault_probe::take_relaunch_marker(&data_dir);
            // One profile per Flowsta identity: the one of the identity the
            // Vault holds now, else the last one used. Must be chosen before
            // `AppState::new`, which checks the profile's key store files.
            //
            // The Vault names its identity only to an app connected under
            // it. Unlocked and naming nobody, it holds an identity this app
            // was never connected under: asked to open as that identity
            // ("Open as this identity"), the app opens a profile no identity
            // is bound to, beside the others, and starts its sign-in. On
            // any other start it stays on the profile in use and says so.
            let unnamed = matches!(live, Some((true, None)));
            let profile_root = if relaunched && unnamed {
                log::info!("The Vault holds an identity this app is not connected under: opening a profile for it");
                profiles::select_unbound_profile_root(&data_dir)
            } else {
                profiles::select_profile_root(&data_dir, live_identity.as_deref())
            };
            log::info!("Profile root: {:?}", profile_root);
            if let Some(fix) = WEBVIEW_FIX.get() {
                log::info!("[webview] {:?}", fix);
            }

            // The profile's link token, if it has one: from here on the
            // Vault is asked as this profile's link.
            link_token::open_profile(vault_probe::client(), &profile_root);

            let app_state = Arc::new(AppState::new(profile_root, data_dir.clone()));
            let after_update = vault_probe::take_raise_marker(&data_dir);
            app_state
                .relaunched_into_identity
                .store(relaunched, std::sync::atomic::Ordering::Relaxed);
            app.manage(app_state.clone());
            #[cfg(feature = "harness")]
            harness::spawn(app.handle().clone());
            // The app's own updates: a first check after 90 s, then every
            // few hours.
            updater::spawn(app.handle().clone(), app_state.device_root.clone());
            app_state.raise_when_ready.store(relaunched || after_update, std::sync::atomic::Ordering::Relaxed);
            // A restart leaves the focus with whatever was behind the old
            // window (the Vault, mostly): come back to the front now and
            // again once Holochain is ready (below). On a Mac, at every
            // launch: opened from Launchpad, an app that starts child
            // processes can come up behind the other windows.
            if relaunched || after_update || cfg!(target_os = "macos") {
                bring_to_front(app.handle(), "at launch");
            }

            // SIGTERM / SIGINT (Ctrl+C, shutdown, `kill <pid>`, a package
            // upgrade) route through app.exit() so RunEvent::Exit below
            // stops the conductor and key store with the app.
            let signal_app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                #[cfg(unix)]
                {
                    use tokio::signal::unix::{signal, SignalKind};
                    let mut sigterm = match signal(SignalKind::terminate()) {
                        Ok(s) => s,
                        Err(e) => {
                            log::error!("Failed to register SIGTERM handler: {}", e);
                            return;
                        }
                    };
                    tokio::select! {
                        _ = sigterm.recv() => log::info!("SIGTERM received, exiting"),
                        _ = tokio::signal::ctrl_c() => log::info!("SIGINT received, exiting"),
                    }
                }
                #[cfg(not(unix))]
                {
                    if tokio::signal::ctrl_c().await.is_err() {
                        log::error!("Failed to register Ctrl+C handler");
                        return;
                    }
                    log::info!("Ctrl+C received, exiting");
                }
                signal_app_handle.exit(0);
            });

            let resource_dir = resolve_resource_dir(app.handle(), &app_state.device_root);
            let (kit_device_root, kit_resources) = (app_state.device_root.clone(), resource_dir.clone());

            // Auto-start the conductor in the background.
            let startup_state = app_state.clone();
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                {
                    let mut status = startup_state.conductor_status.lock().unwrap();
                    *status = conductor::ConductorStatus::Starting {
                        message: "Initializing...".into(),
                    };
                }

                let passphrase = startup_state.passphrase.lock().unwrap().clone();
                let data_dir = startup_state.data_dir.clone();

                let monitor_handle = app_handle.clone();
                match conductor::start_holochain(
                    app_handle,
                    startup_state.clone(),
                    data_dir,
                    resource_dir,
                    passphrase,
                )
                .await
                {
                    Ok(result) => {
                        log::info!("Holochain started; this device's key: {}", result.agent_key);

                        // On Windows the sidecars' hidden consoles can take
                        // the focus as they start: come back to the front.
                        // The same after "Open as this identity" and after
                        // an update's restart, on every system; and on a Mac
                        // when the window has not had the focus at all since
                        // this launch (a person who was in the app and went
                        // elsewhere is left there).
                        if cfg!(target_os = "windows")
                            || startup_state
                                .raise_when_ready
                                .load(std::sync::atomic::Ordering::Relaxed)
                            || (cfg!(target_os = "macos") && !WINDOW_HAD_FOCUS.load(std::sync::atomic::Ordering::Relaxed))
                        {
                            bring_to_front(&monitor_handle, "once ready");
                        }

                        conductor::apply_started(&startup_state, &monitor_handle, result).await;

                        // The kit, set aside once a run (kits.rs).
                        kits::refresh_once(kit_device_root.clone(), kit_resources.clone());

                        // Started with no network: reconnect by itself once
                        // the rendezvous answers.
                        conductor::spawn_reconnect_when_online(startup_state.clone(), monitor_handle.clone());

                        // Watched while the app runs: a conductor that stops
                        // is started again, and it restarts at a quiet
                        // moment when it holds too much memory.
                        conductor::spawn_watch(startup_state.clone(), monitor_handle);

                        // A Disconnect the network did not take last time is
                        // finished now (disconnect.rs).
                        disconnect::spawn(startup_state.clone());
                    }
                    Err(e) => {
                        log::error!("Holochain did not start: {}", e);
                        let mut status = startup_state.conductor_status.lock().unwrap();
                        *status = conductor::ConductorStatus::Error { message: e };
                    }
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // ── Your app's commands (notes.rs): replace these ─────
            notes::get_notes,
            notes::create_note,
            notes::edit_note,
            notes::delete_note,
            notes::set_up_my_notes,
            notes::build_backup,
            notes::restore_my_notes,
            notes::restorable_notes,
            // ── Status ────────────────────────────────────────────
            commands::get_app_status,
            // ── Flowsta sign-in ───────────────────────────────────
            commands::launch_vault,
            vault_probe::probe_vault,
            vault_probe::restart_app,
            vault_probe::vault_holds_another_identity,
            vault_probe::test_vault_url,
            commands::get_cached_profile,
            commands::save_profile_cache,
            commands::commit_identity_link,
            commands::get_identity_link,
            commands::revoke_identity_link,
            commands::identity_linked_on_network,
            commands::get_my_agent_set,
            link_token::get_vault_link_token,
            link_token::save_vault_link_token,
            link_token::clear_vault_link_token,
            // ── The Vault backup's outcome ────────────────────────
            commands::report_backup_outcome,
            commands::get_last_backup_outcome,
            // ── The app's own updates ─────────────────────────────
            updater::update_status,
            updater::set_update_prefs,
            updater::dismiss_updated,
            updater::restart_to_update,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            // Every way out (window close, Quit, a restart, the signal route
            // above) ends here: stop the conductor and its key store so
            // they never outlive the app. A crash or a forced quit is
            // covered by the library (a parent-death signal on Linux, a job
            // object on Windows, a watcher process on macOS) and by the
            // sweep at the next launch.
            if let tauri::RunEvent::Exit = event {
                // A downloaded update installs on quit (Windows, macOS); it
                // stops the conductor cleanly itself first.
                if let Some(state) = app_handle.try_state::<Arc<AppState>>() {
                    updater::install_on_quit(app_handle, &state.device_root);
                }
                conductor::stop_lines();
            }
        });
}

/// Where the bundled hApps are. In a debug build, the source `resources/`
/// folder (Tauri does not copy resources for `tauri dev`). In a release,
/// under the app's resource folder; when Tauri cannot say where that is
/// (seen on Windows with a custom install drive), next to the executable,
/// then the data folder, each said loudly in the log.
#[cfg(debug_assertions)]
pub(crate) fn resolve_resource_dir(
    _app_handle: &tauri::AppHandle,
    _data_dir: &std::path::Path,
) -> std::path::PathBuf {
    // Dev mode: Tauri doesn't copy resources to target/debug/, point at the
    // source resources/ folder.
    std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources")
}

#[cfg(not(debug_assertions))]
pub(crate) fn resolve_resource_dir(
    app_handle: &tauri::AppHandle,
    data_dir: &std::path::Path,
) -> std::path::PathBuf {
    use tauri::Manager;
    match app_handle.path().resource_dir() {
        Ok(d) => return d.join("resources"),
        Err(e) => log::warn!(
            "[resources] resource_dir() failed: {} - trying exe-relative resources",
            e
        ),
    }
    match std::env::current_exe() {
        Ok(exe) => {
            if let Some(dir) = exe.parent() {
                let candidate = dir.join("resources");
                if candidate.is_dir() {
                    log::warn!("[resources] using exe-relative resources at {:?}", candidate);
                    return candidate;
                }
                log::warn!(
                    "[resources] exe-relative resources missing at {:?}",
                    candidate
                );
            }
        }
        Err(e) => log::warn!("[resources] current_exe() failed: {}", e),
    }
    log::warn!(
        "[resources] falling back to data dir {:?} - bundled DNAs will only be found if copied there",
        data_dir
    );
    data_dir.to_path_buf()
}
