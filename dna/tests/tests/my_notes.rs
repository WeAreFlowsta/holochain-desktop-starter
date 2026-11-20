//! My notes, on real conductors: two devices of one person share a network
//! made from one secret, either may change any note, and another person's
//! secret is another network.

use holochain::prelude::*;
use holochain::sweettest::*;
use my_notes_coordinator::{EditNoteInput, NoteView, RestoreNoteInput};
use std::path::Path;

const ZOME: &str = "notes";

/// The DNA as the app installs it: with the person's secret as its seed.
async fn my_notes(secret: &str) -> DnaFile {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../my-notes/workdir/starter_my_notes_v1.dna");
    let dna = SweetDnaFile::from_bundle(&path).await.expect("my-notes/workdir/starter_my_notes_v1.dna loads");
    dna.with_network_seed(secret.to_string()).await
}

#[tokio::test(flavor = "multi_thread")]
async fn two_devices_of_one_person_share_their_notes_and_either_changes_any() {
    let dna = my_notes("11".repeat(32).as_str()).await;
    let mut conductors = SweetConductorBatch::standard(2).await;
    let apps = conductors.setup_app("starter", [&dna]).await.unwrap();
    conductors.exchange_peer_info().await;
    let ((laptop,), (desktop,)) = apps.into_tuples();
    let (a, b) = (conductors.get(0).unwrap(), conductors.get(1).unwrap());
    let (az, bz) = (laptop.zome(ZOME), desktop.zome(ZOME));
    assert_ne!(laptop.agent_pubkey(), desktop.agent_pubkey(), "each device has its own key");

    let first: ActionHash = a.call(&az, "create_note", "Written on the laptop".to_string()).await;
    let second: ActionHash = a.call(&az, "create_note", "Also from the laptop".to_string()).await;
    await_consistency([&laptop, &desktop]).await.expect("the notes reach the desktop");

    // The other device edits one and deletes the other.
    let _: ActionHash = b.call(&bz, "edit_note", EditNoteInput { id: first.clone(), text: "Changed on the desktop".into() }).await;
    let _: () = b.call(&bz, "delete_note", second.clone()).await;
    await_consistency([&laptop, &desktop]).await.expect("the changes reach the laptop");

    let notes: Vec<NoteView> = a.call(&az, "get_notes", ()).await;
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert_eq!((&notes[0].id, notes[0].text.as_str()), (&first, "Changed on the desktop"));
    assert_eq!(&notes[0].author, laptop.agent_pubkey(), "still the device that wrote it");
    let local: Vec<NoteView> = a.call(&az, "get_notes_local", ()).await;
    assert_eq!(local.len(), 1, "the same from what the laptop holds");

    // What a note is, is still checked, in a new note and in an edit.
    refused(a, &az, "create_note", "  ".to_string(), "A note cannot be empty").await;
    refused(a, &az, "create_note", "x".repeat(20_001), "at most 20000 characters").await;
    refused(b, &bz, "edit_note", EditNoteInput { id: first.clone(), text: String::new() }, "A note cannot be empty").await;
    refused(b, &bz, "edit_note", EditNoteInput { id: first.clone(), text: "x".repeat(20_001) }, "at most 20000 characters").await;
    let _: ActionHash = a.call(&az, "create_note", "x".repeat(20_000)).await;
}

async fn refused<I: serde::Serialize + std::fmt::Debug>(conductor: &SweetConductor, zome: &SweetZome, f: &str, input: I, expect: &str) {
    let r: Result<serde::de::IgnoredAny, _> = conductor.call_fallible(zome, f, input).await;
    let e = format!("{:?}", r.expect_err(f));
    assert!(e.contains(expect), "{f}: expected \"{expect}\", got {e}");
}

/// A note written back from the Vault backup is a new record that names
/// the id it had. When the original turns up after all (its device was only
/// off), the person still sees one note, and deleting it removes both.
#[tokio::test(flavor = "multi_thread")]
async fn a_restored_note_and_its_original_are_one_note() {
    let dna = my_notes(&"11".repeat(32)).await;
    // The old device writes two notes and is then switched off, before the
    // new device exists. Both use one rendezvous, as devices in the field do.
    let rendezvous = SweetLocalRendezvous::new().await;
    let mut a = SweetConductor::from_config_rendezvous(SweetConductorConfig::rendezvous(true), rendezvous.clone()).await;
    let old = a.setup_app("starter", [&dna]).await.unwrap().into_cells().remove(0);
    let az = old.zome(ZOME);
    let kept: ActionHash = a.call(&az, "create_note", "Kept".to_string()).await;
    let changed: ActionHash = a.call(&az, "create_note", "Before".to_string()).await;
    a.shutdown().await;

    let mut b = SweetConductor::from_config_rendezvous(SweetConductorConfig::rendezvous(true), rendezvous.clone()).await;
    let new = b.setup_app("starter", [&dna]).await.unwrap().into_cells().remove(0);
    let bz = new.zome(ZOME);
    let nothing: Vec<NoteView> = b.call(&bz, "get_notes_local", ()).await;
    assert!(nothing.is_empty());

    // The new device restores both from the backup, and edits one.
    let copy_kept: Option<ActionHash> = b.call(&bz, "restore_note", RestoreNoteInput { original: kept.clone(), text: "Kept".into() }).await;
    let copy_changed: Option<ActionHash> = b.call(&bz, "restore_note", RestoreNoteInput { original: changed.clone(), text: "Before".into() }).await;
    let (copy_kept, copy_changed) = (copy_kept.expect("written"), copy_changed.expect("written"));
    let again: Option<ActionHash> = b.call(&bz, "restore_note", RestoreNoteInput { original: kept.clone(), text: "Kept".into() }).await;
    assert_eq!(again, None, "a second restore of the same note writes nothing");
    let _: ActionHash = b.call(&bz, "edit_note", EditNoteInput { id: copy_changed.clone(), text: "After".into() }).await;
    let restored: Vec<NoteView> = b.call(&bz, "get_notes_local", ()).await;
    assert_eq!(restored.len(), 2);
    assert!(restored.iter().all(|n| n.restored_from.is_some()), "{restored:?}");

    // The old device comes on: both devices hold originals and copies.
    a.startup().await;
    let (a, b) = (&a, &b);
    SweetConductor::exchange_peer_info([a, b]).await;
    await_consistency_s(180, [&old, &new]).await.expect("the two devices sync");
    for (conductor, zome) in [(a, &az), (b, &bz)] {
        let notes: Vec<NoteView> = conductor.call(zome, "get_notes", ()).await;
        assert_eq!(notes.len(), 2, "each note is shown once: {notes:?}");
        let texts: Vec<&str> = notes.iter().map(|n| n.text.as_str()).collect();
        assert!(texts.contains(&"Kept") && texts.contains(&"After"), "the newest change of each is what shows: {texts:?}");
    }

    // Deleting the one that shows removes its other half too.
    let _: () = a.call(&az, "delete_note", copy_changed).await;
    await_consistency([&old, &new]).await.expect("the delete reaches both");
    let notes: Vec<NoteView> = b.call(&bz, "get_notes", ()).await;
    assert_eq!(notes.len(), 1, "{notes:?}");
    assert_eq!(notes[0].text, "Kept");
    assert!(notes[0].id == kept || notes[0].id == copy_kept);

    // A deleted note stays deleted: an old backup does not bring it back,
    // on either device.
    let unseen = ActionHash::from_raw_36(vec![9; 36]);
    for (conductor, zome) in [(a, &az), (b, &bz)] {
        let offered: Vec<ActionHash> = conductor.call(zome, "restorable", vec![changed.clone(), kept.clone(), unseen.clone()]).await;
        assert_eq!(offered, vec![unseen.clone()], "only a note this device has never seen");
        let back: Option<ActionHash> = conductor.call(zome, "restore_note", RestoreNoteInput { original: changed.clone(), text: "After".into() }).await;
        assert_eq!(back, None);
    }
}

/// A device running other code than the app's (a faulty build, a tampered
/// one) is still held to what a note is and where notes are listed. It may
/// delete and edit: on this network every key is the same person.
#[tokio::test(flavor = "multi_thread")]
async fn other_code_on_the_persons_network_is_held_to_the_same_rules() {
    let ours = my_notes(&"11".repeat(32)).await;
    let mut theirs = ours.clone();
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("hostile/target/wasm32-unknown-unknown/release/board_hostile_test.wasm");
    let wasm = DnaWasm::from(std::fs::read(&file).expect("board_hostile_test.wasm is built (see dna/tests/README.md)"));
    let hash = holo_hash::WasmHash::with_data(&wasm).await;
    let def = ZomeDef::Wasm(WasmZomeDef::new(hash, Some(vec!["notes_integrity".into()])));
    theirs.update_coordinators(vec![(ZomeName::from("hostile"), def.into())], vec![wasm]).await.unwrap();
    assert_eq!(ours.dna_hash(), theirs.dna_hash(), "the same network");

    let mut conductor = SweetConductor::standard().await;
    let laptop = conductor.setup_app("laptop", [&ours]).await.unwrap().into_cells().remove(0);
    let other = conductor.setup_app("other", [&theirs]).await.unwrap().into_cells().remove(0);
    let (lz, oh) = (laptop.zome(ZOME), other.zome("hostile"));
    let note: ActionHash = conductor.call(&lz, "create_note", "From the laptop".to_string()).await;
    await_consistency([&laptop, &other]).await.expect("the note reaches the other device");

    refused(&conductor, &oh, "write_raw", String::new(), "A note cannot be empty").await;
    refused(&conductor, &oh, "write_raw", "x".repeat(20_001), "at most 20000 characters").await;
    refused(&conductor, &oh, "list_elsewhere", note.clone(), "A note is listed under the notes anchor").await;
    // What the board refuses and this network allows: another device's note.
    let _: ActionHash = conductor.call(&oh, "rewrite", note.clone()).await;
    let _: ActionHash = conductor.call(&oh, "delete_record", note).await;
}

#[tokio::test(flavor = "multi_thread")]
async fn another_persons_secret_is_another_network() {
    let (mine, theirs) = (my_notes(&"11".repeat(32)).await, my_notes(&"22".repeat(32)).await);
    assert_ne!(mine.dna_hash(), theirs.dna_hash(), "a different seed is a different DNA hash: a different network");
    assert_eq!(mine.dna_hash(), my_notes(&"11".repeat(32)).await.dna_hash(), "the same secret is the same network on every device");

    let mut conductor = SweetConductor::standard().await;
    let me = conductor.setup_app("me", [&mine]).await.unwrap().into_cells().remove(0);
    let them = conductor.setup_app("them", [&theirs]).await.unwrap().into_cells().remove(0);
    let _: ActionHash = conductor.call(&me.zome(ZOME), "create_note", "Mine".to_string()).await;
    let seen: Vec<NoteView> = conductor.call(&them.zome(ZOME), "get_notes", ()).await;
    assert!(seen.is_empty(), "nothing of mine is on their network: {seen:?}");
}
