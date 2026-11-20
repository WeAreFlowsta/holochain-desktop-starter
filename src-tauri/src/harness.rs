//! The test door (cargo feature `harness`, never in a release build): a
//! localhost server whose `/dev` routes drive this instance through the
//! same commands the page calls, with no window and nobody clicking. On
//! only when `STARTER_HARNESS_PORT` is set.
//!
//! `scripts/check-test-features.mjs` refuses a release that would carry it.
//!
//! For a fork: when you add a command to `notes.rs`, add its operation in
//! `op` below. A script can then start two copies of the app
//! (`scripts/run-test-instance.sh`) and check a second device, an offline
//! start or a restart by calling them.

use axum::{
    extract::State as Ax,
    http::StatusCode,
    routing::{get, post},
    Json, Router,
};
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::Manager;

use crate::commands::{self, AppState};
use crate::notes::{self, Place};

pub fn spawn(app: tauri::AppHandle) {
    let Some(port) = std::env::var("STARTER_HARNESS_PORT").ok().and_then(|v| v.trim().parse::<u16>().ok()) else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let router = Router::new().route("/dev/status", get(status)).route("/dev/op", post(op)).with_state(app);
        match tokio::net::TcpListener::bind(("127.0.0.1", port)).await {
            Ok(listener) => {
                log::warn!("[harness] /dev routes on 127.0.0.1:{}", port);
                if let Err(e) = axum::serve(listener, router).await {
                    log::error!("[harness] server stopped: {}", e);
                }
            }
            Err(e) => log::error!("[harness] could not bind 127.0.0.1:{}: {}", port, e),
        }
    });
}

type Reply = (StatusCode, Json<Value>);

fn ok(v: Value) -> Reply {
    (StatusCode::OK, Json(v))
}

fn failed(e: impl std::fmt::Display) -> Reply {
    (StatusCode::BAD_REQUEST, Json(json!({ "error": e.to_string() })))
}

fn to_value<T: serde::Serialize>(r: Result<T, String>) -> Reply {
    match r {
        Ok(v) => ok(serde_json::to_value(v).unwrap_or(Value::Null)),
        Err(e) => failed(e),
    }
}

fn s(body: &Value, key: &str) -> String {
    body.get(key).and_then(|v| v.as_str()).unwrap_or_default().to_string()
}

fn place(body: &Value) -> Result<Place, String> {
    serde_json::from_value(body.get("place").cloned().unwrap_or(Value::Null)).map_err(|_| "place is \"board\" or \"my_notes\"".to_string())
}

/// Resident memory of a process in MB (Linux; the UI suite runs there).
fn rss_mb(pid: u32) -> Option<u64> {
    let status = std::fs::read_to_string(format!("/proc/{}/status", pid)).ok()?;
    let kb = status.lines().find(|l| l.starts_with("VmRSS:"))?.split_whitespace().nth(1)?.parse::<u64>().ok()?;
    Some(kb / 1024)
}

async fn status(Ax(app): Ax<tauri::AppHandle>) -> Reply {
    let state = app.state::<Arc<AppState>>();
    let app_status = commands::get_app_status(state.clone()).await.ok();
    let pid = crate::conductor::conductor_pid();
    let config_has_auth = std::fs::read_to_string(state.data_dir.join(crate::conductor::CONDUCTOR_DIR).join("conductor-config.yaml")).map(|c| c.contains("base64_auth_material")).unwrap_or(false);
    ok(json!({
        "harness": true,
        "version": app.package_info().version.to_string(),
        "app": app_status,
        "started_offline": crate::conductor::started_offline(),
        "config_has_auth": config_has_auth,
        "admin_port": crate::conductor::admin_port(),
        "app_port": crate::conductor::ports().map(|p| p.1),
        "conductor_pid": pid,
        "rss_mb": pid.and_then(rss_mb),
        "identity_link": commands::get_identity_link(state.clone()),
        "kit": crate::kits::status(&state.device_root),
        "data_dir": state.data_dir,
    }))
}

async fn op(Ax(app): Ax<tauri::AppHandle>, Json(body): Json<Value>) -> Reply {
    let state = app.state::<Arc<AppState>>();
    match s(&body, "op").as_str() {
        // ── Notes: the same commands the page calls ───────────────────
        "notes" => match place(&body) {
            Ok(p) => to_value(notes::get_notes(state, p).await),
            Err(e) => failed(e),
        },
        "create_note" => match place(&body) {
            Ok(p) => to_value(notes::create_note(state, p, s(&body, "text")).await),
            Err(e) => failed(e),
        },
        "edit_note" => match place(&body) {
            Ok(p) => to_value(notes::edit_note(state, p, s(&body, "id"), s(&body, "text")).await),
            Err(e) => failed(e),
        },
        "delete_note" => match place(&body) {
            Ok(p) => to_value(notes::delete_note(state, p, s(&body, "id")).await),
            Err(e) => failed(e),
        },
        "restorable_notes" => match serde_json::from_value::<Vec<notes::BackedUpNote>>(body.get("notes").cloned().unwrap_or(Value::Null)) {
            Ok(list) => to_value(notes::restorable_notes(state, list).await),
            Err(e) => failed(format!("notes: {}", e)),
        },
        "restore_my_notes" => match serde_json::from_value::<Vec<notes::BackedUpNote>>(body.get("notes").cloned().unwrap_or(Value::Null)) {
            Ok(list) => to_value(notes::restore_my_notes(state, list).await),
            Err(e) => failed(format!("notes: {}", e)),
        },
        "set_up_my_notes" => to_value(notes::set_up_my_notes(app.clone(), state).await),
        // ── Flowsta ───────────────────────────────────────────────────
        "identity" => ok(serde_json::to_value(commands::get_identity_link(state)).unwrap_or(Value::Null)),
        "link" => link(state).await,
        "disconnect" => to_value(commands::revoke_identity_link(state).await),
        "agent_set" => to_value(commands::get_my_agent_set(state).await),
        "linked" => {
            let agent = state.agent_pub_key.lock().unwrap().clone();
            match agent {
                Some(agent) => to_value(commands::identity_linked_on_network(state.clone(), agent).await),
                None => failed("no local agent yet"),
            }
        }
        "backup" => backup(state).await,
        // ── The start screen as a state shows it, without living through
        //    it (the UI suite; the app's own state is put back by showing
        //    its `ready` again) ─────────────────────────────────────────
        "show_status" => match serde_json::from_value::<crate::conductor::ConductorStatus>(body.get("status").cloned().unwrap_or(Value::Null)) {
            Ok(status) => {
                *state.conductor_status.lock().unwrap() = status.clone();
                let _ = tauri::Emitter::emit(&app, "conductor-status", status);
                ok(json!({ "shown": true }))
            }
            Err(e) => failed(format!("status: {}", e)),
        },
        other => failed(format!("unknown op: {}", other)),
    }
}

fn test_vault() -> Result<String, String> {
    crate::vault_probe::test_vault_port().map(|p| format!("http://127.0.0.1:{}", p)).ok_or_else(|| "no STARTER_TEST_VAULT_PORT".to_string())
}

fn client_id() -> Result<&'static str, String> {
    crate::vault_probe::client_id().ok_or_else(|| "this build was given no VITE_FLOWSTA_CLIENT_ID".to_string())
}

/// The sign-in the Identity page does through the SDK: the Vault's
/// `/link-identity` (the test Vault the instance is pinned to shows its
/// dialog, which the UI suite approves through the Vault's own test door),
/// then the commit, then the link token kept in the profile.
async fn link(state: tauri::State<'_, Arc<AppState>>) -> Reply {
    let agent = state.agent_pub_key.lock().unwrap().clone();
    let Some(agent) = agent else {
        return failed("no local agent yet");
    };
    let (base, client_id) = match (test_vault(), client_id()) {
        (Ok(b), Ok(c)) => (b, c),
        (Err(e), _) | (_, Err(e)) => return failed(e),
    };
    let vault = crate::vault_probe::client();
    let body = json!({ "app_name": crate::names::APP_NAME, "client_id": client_id, "app_agent_pub_key": agent, "require_link_token": true });
    let answer: Value = match vault.post(&format!("{}/link-identity", base), body).timeout(std::time::Duration::from_secs(120)).send().await {
        Ok(r) if r.status().is_success() => r.json().await.unwrap_or(Value::Null),
        Ok(r) => return failed(format!("link-identity {}: {}", r.status(), r.text().await.unwrap_or_default())),
        Err(e) => return failed(e),
    };
    let text = |name: &str| answer.get(name).and_then(|x| x.as_str()).filter(|x| !x.is_empty()).map(String::from);
    // Named by its fields, never printed whole: the answer holds a token.
    let (Some(key), Some(signature)) = (text("vault_agent_pub_key"), text("vault_signature")) else {
        return failed("link-identity answered without a key and signature");
    };
    let committed = match commands::commit_identity_link(state.clone(), key.clone(), signature).await {
        Ok(hash) => hash,
        Err(e) => return failed(e),
    };
    let token = text("link_token");
    let kept = match token.as_deref() {
        Some(t) => crate::link_token::keep(vault, &state.data_dir, t),
        None => {
            crate::link_token::forget(vault, &state.data_dir);
            Ok(())
        }
    };
    match kept {
        Ok(()) => ok(json!({ "vault_agent_pub_key": key, "link": committed, "link_token": token.is_some() })),
        Err(e) => failed(e),
    }
}

/// The backup the page makes: the person's notes, written to their Vault
/// under the label the page uses.
async fn backup(state: tauri::State<'_, Arc<AppState>>) -> Reply {
    let (base, client_id) = match (test_vault(), client_id()) {
        (Ok(b), Ok(c)) => (b, c),
        (Err(e), _) | (_, Err(e)) => return failed(e),
    };
    let expected = commands::get_identity_link(state.clone()).map(|l| l.vault_agent_pub_key);
    let mine = match commands::get_my_agent_set(state.clone()).await {
        Ok(m) => m,
        Err(e) => return failed(e),
    };
    let data = match notes::build_backup(state, mine).await {
        Ok(d) => d,
        Err(e) => return failed(format!("build_backup: {}", e)),
    };
    let summary = data["_summary"].clone();
    let body = json!({ "client_id": client_id, "app_name": crate::names::APP_NAME, "label": "latest", "data": data, "expected_identity": expected });
    match crate::vault_probe::client().post(&format!("{}/backup", base), body).timeout(std::time::Duration::from_secs(60)).send().await {
        Ok(r) if r.status().is_success() => ok(json!({ "saved": true, "summary": summary })),
        Ok(r) => failed(format!("backup {}: {}", r.status(), r.text().await.unwrap_or_default())),
        Err(e) => failed(e),
    }
}
