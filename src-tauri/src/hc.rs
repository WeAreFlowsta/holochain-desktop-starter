//! Zome calls: one small face over the Holochain client.
//!
//! Everything above this module sends calls through [`AppClient`] and works
//! with plain bytes (msgpack) and its own structs, so the Holochain client
//! crate is named in this file and `dna.rs`, with one admin call in `commands.rs`. When
//! Holochain's next line arrives, those are the files that change.
//!
//! For a fork: nothing to change here. Your commands call
//! `commands::call_zome` (see `notes.rs`), which calls this.

use holochain_types::prelude::ExternIO;

/// Which Holochain line a conductor speaks (the lines library's type). The
/// Starter runs one: `Line::V07`, Holochain 0.7.1.
pub use flowsta_hc_lines::Line;

/// The line this app runs.
pub const LINE: Line = Line::V07;

/// An app websocket to one installed app (a handle: clones share it).
#[derive(Clone)]
pub struct AppClient(pub holochain_client::AppWebsocket);

impl AppClient {
    /// Call a zome function. `payload` is the msgpack of the input (what
    /// [`encode`] produces); the result is the msgpack of the output.
    pub async fn call_zome(&self, role: &str, zome: &str, fn_name: &str, payload: Vec<u8>) -> Result<Vec<u8>, String> {
        use holochain_client::ZomeCallTarget;
        use holochain_types::prelude::{FunctionName, RoleName, ZomeName};
        self.0
            .call_zome(ZomeCallTarget::RoleName(RoleName::from(role)), ZomeName::from(zome), FunctionName::from(fn_name), ExternIO::from(payload))
            .await
            .map(|io| io.into_vec())
            .map_err(|e| format!("{}", e))
    }
}

/// Encode a zome input the way the zome decodes it (msgpack, named fields).
pub fn encode<T: serde::Serialize + std::fmt::Debug>(value: &T) -> Result<Vec<u8>, String> {
    ExternIO::encode(value).map(|io| io.into_vec()).map_err(|e| e.to_string())
}

/// Decode a zome output.
pub fn decode<T: serde::de::DeserializeOwned + std::fmt::Debug>(bytes: &[u8]) -> Result<T, String> {
    ExternIO::from(bytes.to_vec()).decode().map_err(|e| format!("Failed to decode zome output: {}", e))
}

/// Parse a `u…` hash string (an action hash, an agent key) into its 39 raw
/// bytes.
pub fn hash_bytes(s: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    let b64 = s.strip_prefix('u').ok_or("Hash must start with 'u'")?;
    let raw = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(b64).map_err(|e| format!("Invalid base64 in hash: {}", e))?;
    if raw.len() != 39 {
        return Err(format!("Hash wrong length: {} (expected 39)", raw.len()));
    }
    Ok(raw)
}

/// An `ActionHash` from its string.
pub fn action_hash(s: &str) -> Result<holochain_types::prelude::ActionHash, String> {
    Ok(holochain_types::prelude::ActionHash::from_raw_39(hash_bytes(s)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hash_strings_round_trip_through_raw_bytes() {
        let h = holochain_types::prelude::ActionHash::from_raw_32(vec![7u8; 32]);
        let s = h.to_string();
        assert!(s.starts_with("uhCkk"));
        assert_eq!(action_hash(&s).unwrap(), h);
        assert!(hash_bytes("not a hash").is_err());
        assert!(hash_bytes("uAAAA").is_err(), "the wrong length is refused");
    }
}
