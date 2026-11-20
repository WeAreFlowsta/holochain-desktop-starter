//! Resolve the on-disk path of a bundled Tauri sidecar binary.
//!
//! Sidecars carry the app's own prefix (`names.rs`) so they never collide
//! with another Holochain app's on the same computer.
//! The resolution itself lives in `flowsta-hc-lines`: `src-tauri/binaries`
//! in a debug build, next to the executable in a release, the bare name
//! (a PATH lookup) when neither has it.
//!
//! For a fork: nothing to change here.

use std::path::PathBuf;

pub fn sidecar_path(name: &str) -> PathBuf {
    flowsta_hc_lines::resolve_sidecar(name, &crate::kits::sidecar_source()).unwrap_or_else(|_| PathBuf::from(name))
}
