fn main() {
    println!("cargo:rerun-if-changed=../.env");
    let dotenv = std::fs::read_to_string("../.env").unwrap_or_default();
    // The Flowsta client id the page is built with, handed to the Rust side
    // as `STARTER_CLIENT_ID` so both name the same app to the Vault.
    let client_id = setting(&dotenv, "VITE_FLOWSTA_CLIENT_ID").unwrap_or_default();
    println!("cargo:rustc-env=STARTER_CLIENT_ID={client_id}");
    // Your servers (`conductor.rs` reads these with `option_env!`).
    for name in ["STARTER_BOOTSTRAP_URL", "STARTER_RELAY_URL", "STARTER_AUTH_MATERIAL"] {
        let value = setting(&dotenv, name);
        if name == "STARTER_AUTH_MATERIAL" {
            check_auth_material(value.as_deref().unwrap_or_default());
        }
        if let Some(value) = value {
            println!("cargo:rustc-env={name}={value}");
        }
    }
    tauri_build::build()
}

/// A build-time setting, read the way Vite reads its own: the environment
/// first (the release workflow and the test build set them there), then the
/// `.env` file beside `package.json`. `None` when neither has it, or it is
/// empty.
fn setting(dotenv: &str, name: &str) -> Option<String> {
    println!("cargo:rerun-if-env-changed={name}");
    let filled = |v: String| Some(v.trim().to_string()).filter(|v| !v.is_empty());
    std::env::var(name).ok().and_then(filled).or_else(|| dotenv_value(dotenv, name).and_then(filled))
}

/// The value of `name` in the text of a `.env` file: `NAME=value`, with
/// optional quotes around the value; comment lines are skipped.
fn dotenv_value(text: &str, name: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let (key, value) = line.trim().strip_prefix("export ").unwrap_or(line.trim()).split_once('=')?;
        if key.trim() != name {
            return None;
        }
        let value = value.trim();
        let unquoted = ['"', '\''].iter().find_map(|q| value.strip_prefix(*q)?.strip_suffix(*q)).unwrap_or(value);
        Some(unquoted.to_string())
    })
}

/// The conductor reads `STARTER_AUTH_MATERIAL` as padded standard base64:
/// a value without its `=` padding, or in the URL-safe alphabet, makes every
/// conductor start panic with "InvalidPadding". Refuse to build with one
/// rather than ship an app that cannot start.
fn check_auth_material(m: &str) {
    if m.is_empty() {
        return;
    }
    let body = m.trim_end_matches('=');
    let alphabet = |c: char| c.is_ascii_alphanumeric() || c == '+' || c == '/';
    if m.len() % 4 != 0 || m.len() - body.len() > 2 || !body.chars().all(alphabet) {
        panic!("STARTER_AUTH_MATERIAL is not padded standard base64 (length {}): the conductor would refuse it", m.len());
    }
}
