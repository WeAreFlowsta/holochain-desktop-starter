//! The kit cache (the lines library's `kit`): once a run, after the
//! conductor is up, this line's kit (its conductor, its key store and the
//! hApps it loads) is set aside compressed in `<data dir>/kits/`.
//!
//! It costs a few megabytes now and is for later: when Holochain's next
//! line arrives and your app moves to it, a release that no longer bundles
//! this line can still read a device's own data from the cached kit,
//! offline, after checking every file against the hashes compiled in here.
//!
//! `scripts/check-bundle-sync.mjs` checks these hashes against the files
//! in `resources/`, and rewrites them with `--write` after `dna/build.sh`.
//!
//! For a fork: when you add or remove a DNA, add or remove its `KitFile`
//! here (and its line in `tauri.conf.json`'s `bundle.resources`). The
//! hashes are written for you by the script above.

use flowsta_hc_lines::kit::{KitBinary, KitCache, KitDescriptor, KitFile};
use flowsta_hc_lines::Line;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// The hApps the app bundles (`resources/`), with the hash each must have.
pub const BOARD_HAPP: KitFile = KitFile { name: "starter_board_v1_happ.happ", sha256: "619206472fd45fccb285d50d5b165a30f5dc389fa676084b22d6180bca357fb9" };
pub const MY_NOTES_HAPP: KitFile = KitFile { name: "starter_my_notes_v1_happ.happ", sha256: "d61a565ea614ad9935749845bc74b745ae58ecd601d26070149d39448fe3a350" };

/// The Holochain 0.7.1 kit. `accepted` stays empty while a release bundles
/// the binaries: their hashes after code signing come out of each release's
/// build (`scripts/kit-hashes.mjs`) and are published with it.
pub const KIT: KitDescriptor = KitDescriptor {
    line: Line::V07,
    conductor: KitBinary { sidecar: crate::names::CONDUCTOR, version: "0.7.1", accepted: &[] },
    lair: KitBinary { sidecar: crate::names::LAIR, version: "0.7.1", accepted: &[] },
    files: &[BOARD_HAPP, MY_NOTES_HAPP],
};

/// Where the sidecars are: next to the app, or `src-tauri/binaries` in a
/// debug build.
pub fn sidecar_source() -> flowsta_hc_lines::SidecarSource {
    flowsta_hc_lines::SidecarSource {
        dev_dir: cfg!(debug_assertions).then(|| Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries")),
        exe_dir: None,
        kit_dirs: Vec::new(),
        allow_path_lookup: true,
    }
}

pub fn kits_dir(device_root: &Path) -> PathBuf {
    device_root.join("kits")
}

static REFRESHED: AtomicBool = AtomicBool::new(false);

/// `refresh`, once a run, on a blocking thread.
pub fn refresh_once(device_root: PathBuf, resources: PathBuf) {
    if REFRESHED.swap(true, Ordering::SeqCst) {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || refresh(&device_root, &resources));
}

pub fn refresh(device_root: &Path, resources: &Path) {
    let cache = KitCache::new(kits_dir(device_root));
    match cache.put(&KIT, &sidecar_source(), resources) {
        Ok(p) if p.written.is_empty() => log::debug!("[kit] the {} kit is cached as it is ({} KB)", p.line, p.packed / 1024),
        Ok(p) => log::info!("[kit] the {} kit cached: {} written, {} as before ({} KB)", p.line, p.written.join(", "), p.kept, p.packed / 1024),
        Err(e) => log::warn!("[kit] the {} kit not cached: {}", KIT.line, e),
    }
}

/// The kit by the cache's own record (for the test harness).
#[cfg(feature = "harness")]
pub fn status(device_root: &Path) -> serde_json::Value {
    match KitCache::new(kits_dir(device_root)).manifest(Line::V07) {
        Some(m) => serde_json::json!({ "entries": m.entries.iter().map(|e| e.name.clone()).collect::<Vec<_>>(), "packed": m.packed_bytes(), "target": m.target }),
        None => serde_json::Value::Null,
    }
}
