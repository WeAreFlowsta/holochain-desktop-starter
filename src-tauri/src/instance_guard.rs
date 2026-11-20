//! Orphaned sidecars from an earlier launch.
//!
//! The app runs two child processes, its key store and its conductor, and
//! the conductor listens on a fixed local port. When the app dies without
//! running its exit path (a crash, a forced quit, macOS replacing a running
//! app, an installer), the library ends the children with it: a
//! parent-death signal on Linux, a job object on Windows, a watcher process
//! on macOS. This sweep is the second line, at the NEXT launch, before
//! anything of ours starts: a sidecar whose parent is gone belongs to
//! nobody and is stopped. A sidecar whose parent is a live copy of the app
//! that is not us belongs to that copy and is left alone (it owns the port;
//! our own conductor start reports it).
//!
//! Matching is by process NAME (the sidecar file names are ours alone,
//! `names.rs`), never by port or folder, and every kill names one pid.
//!
//! For a fork: nothing to change here. The names it sweeps are the ones in
//! `names.rs`, which the rename script sets.

const SIDECAR_STEMS: &[&str] = crate::names::SIDECARS;

/// Stop every orphaned sidecar of this app (the rule and the sweep live in
/// `flowsta-hc-lines`). Returns how many were stopped. Call before the
/// first sidecar of this launch spawns.
pub fn reap_orphaned_sidecars() -> u32 {
    flowsta_hc_lines::reap::reap_orphaned_sidecars(SIDECAR_STEMS)
}

#[cfg(test)]
mod tests {
    use super::*;
    use flowsta_hc_lines::reap::{is_sidecar_name, should_reap, Parent};

    use crate::names::{CONDUCTOR, LAIR};

    #[test]
    fn only_our_sidecar_names_match_with_or_without_exe() {
        let ours = |name: &str| is_sidecar_name(name, SIDECAR_STEMS);
        assert!(ours(CONDUCTOR));
        assert!(ours(&format!("{LAIR}.exe")));
        assert!(ours(&format!("{}.EXE", CONDUCTOR.to_uppercase())));
        assert!(!ours("holochain"));
        assert!(!ours("lair-keystore"));
        assert!(!ours(&format!("another-{CONDUCTOR}")));
        assert!(!ours(CONDUCTOR.trim_end_matches("-holochain")), "the app itself is not a sidecar");
    }

    #[test]
    fn a_sidecar_is_reaped_only_when_no_live_copy_of_the_app_holds_it() {
        assert!(should_reap(CONDUCTOR, Parent::Gone, SIDECAR_STEMS));
        assert!(should_reap(LAIR, Parent::Foreign, SIDECAR_STEMS), "adopted by a subreaper = its app is gone");
        assert!(!should_reap(CONDUCTOR, Parent::Us, SIDECAR_STEMS));
        assert!(!should_reap("holochain", Parent::Gone, SIDECAR_STEMS), "never anything but our own sidecars");
    }

    /// Live: a process NAMED like our sidecar, double-forked so its parent is
    /// gone, is stopped by the sweep; one we spawned ourselves is kept.
    /// Ignored because it stops any orphaned sidecar of the app on the box
    /// (that is its job); run it by hand with the app closed.
    #[test]
    #[ignore = "kills real orphaned sidecars on this machine"]
    #[cfg(unix)]
    fn live_sweep_stops_a_parentless_sidecar_and_keeps_our_own_child() {
        let dir = tempfile::tempdir().unwrap();
        let fake = dir.path().join(CONDUCTOR);
        std::fs::copy("/bin/sleep", &fake).unwrap();
        // orphan: sh spawns it in the background and exits
        std::process::Command::new("sh")
            .arg("-c")
            .arg(format!("nohup {} 300 >/dev/null 2>&1 &", fake.display()))
            .status()
            .unwrap();
        // our own child
        let mut mine = std::process::Command::new(&fake).arg("300").spawn().unwrap();
        std::thread::sleep(std::time::Duration::from_millis(300));

        let reaped = reap_orphaned_sidecars();
        assert!(reaped >= 1, "the parentless one is stopped ({} reaped)", reaped);
        std::thread::sleep(std::time::Duration::from_millis(300));
        assert!(mine.try_wait().unwrap().is_none(), "our own child is kept");
        let _ = mine.kill();
        let _ = mine.wait();
        let left = std::process::Command::new("pgrep").arg("-f").arg(fake.to_string_lossy().as_ref()).output().unwrap();
        assert!(String::from_utf8_lossy(&left.stdout).trim().is_empty(), "no fake sidecar left: {:?}", left);
    }
}
