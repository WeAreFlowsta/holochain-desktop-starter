//! The board, on real conductors: what its author may do with a note, what
//! another person sees, and what the rules refuse from someone else.

use board_notes_coordinator::{EditNoteInput, NoteView};
use holochain::prelude::*;
use holochain::sweettest::*;
use std::path::Path;

const ZOME: &str = "notes";

async fn board() -> DnaFile {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../board/workdir/starter_board_v1.dna");
    SweetDnaFile::from_bundle(&path).await.expect("board/workdir/starter_board_v1.dna loads")
}

/// The board with a stranger's own coordinator added beside the real ones.
/// Coordinators are not part of the DNA hash: it is the same network.
async fn board_with_a_strangers_coordinator() -> DnaFile {
    let mut dna = board().await;
    let file = Path::new(env!("CARGO_MANIFEST_DIR")).join("hostile/target/wasm32-unknown-unknown/release/board_hostile_test.wasm");
    let wasm = DnaWasm::from(std::fs::read(&file).expect("board_hostile_test.wasm is built (see dna/tests/README.md)"));
    let hash = holo_hash::WasmHash::with_data(&wasm).await;
    let def = ZomeDef::Wasm(WasmZomeDef::new(hash, Some(vec!["notes_integrity".into()])));
    dna.update_coordinators(vec![(ZomeName::from("hostile"), def.into())], vec![wasm]).await.unwrap();
    dna
}

async fn refused<I: serde::Serialize + std::fmt::Debug>(conductor: &SweetConductor, zome: &SweetZome, f: &str, input: I, expect: &str) {
    let r: Result<serde::de::IgnoredAny, _> = conductor.call_fallible(zome, f, input).await;
    let e = format!("{:?}", r.expect_err(f));
    assert!(e.contains(expect), "{f}: expected \"{expect}\", got {e}");
}

#[tokio::test(flavor = "multi_thread")]
async fn an_author_writes_edits_and_deletes_their_note() {
    let dna = board().await;
    let mut conductor = SweetConductor::standard().await;
    let alice = conductor.setup_app("alice", [&dna]).await.unwrap().into_cells().remove(0);
    let zome = alice.zome(ZOME);

    let id: ActionHash = conductor.call(&zome, "create_note", "First words".to_string()).await;
    let notes: Vec<NoteView> = conductor.call(&zome, "get_notes", ()).await;
    assert_eq!(notes.len(), 1);
    assert_eq!((&notes[0].id, notes[0].text.as_str(), notes[0].edited_at), (&id, "First words", None));
    assert_eq!(&notes[0].author, alice.agent_pubkey());

    // Two edits, each of the first record: the newest text is what shows.
    let _: ActionHash = conductor.call(&zome, "edit_note", EditNoteInput { id: id.clone(), text: "Second thoughts".into() }).await;
    let _: ActionHash = conductor.call(&zome, "edit_note", EditNoteInput { id: id.clone(), text: "Third time".into() }).await;
    let notes: Vec<NoteView> = conductor.call(&zome, "get_notes", ()).await;
    assert_eq!(notes.len(), 1, "an edited note is still one note");
    assert_eq!(notes[0].text, "Third time");
    assert!(notes[0].edited_at.is_some_and(|t| t > notes[0].created_at));
    let local: Vec<NoteView> = conductor.call(&zome, "get_notes_local", ()).await;
    assert_eq!(local[0].text, "Third time", "the same answer without asking the network");

    // What a note is.
    refused(&conductor, &zome, "create_note", "   ".to_string(), "A note cannot be empty").await;
    refused(&conductor, &zome, "create_note", "x".repeat(2001), "at most 2000 characters").await;
    refused(&conductor, &zome, "edit_note", EditNoteInput { id: id.clone(), text: String::new() }, "A note cannot be empty").await;
    refused(&conductor, &zome, "edit_note", EditNoteInput { id: id.clone(), text: "x".repeat(2001) }, "at most 2000 characters").await;

    let _: () = conductor.call(&zome, "delete_note", id).await;
    let notes: Vec<NoteView> = conductor.call(&zome, "get_notes", ()).await;
    assert!(notes.is_empty(), "a deleted note is off the board: {notes:?}");
}

#[tokio::test(flavor = "multi_thread")]
async fn another_person_reads_a_note_and_cannot_change_it() {
    let dna = board().await;
    let mut conductors = SweetConductorBatch::standard(2).await;
    let apps = conductors.setup_app("starter", [&dna]).await.unwrap();
    conductors.exchange_peer_info().await;
    let ((alice,), (bob,)) = apps.into_tuples();
    let (a, b) = (conductors.get(0).unwrap(), conductors.get(1).unwrap());
    let (az, bz) = (alice.zome(ZOME), bob.zome(ZOME));

    let id: ActionHash = a.call(&az, "create_note", "Alice's".to_string()).await;
    let _: ActionHash = b.call(&bz, "create_note", "Bob's".to_string()).await;
    await_consistency([&alice, &bob]).await.expect("both notes reach both");

    let seen: Vec<NoteView> = b.call(&bz, "get_notes", ()).await;
    assert_eq!(seen.len(), 2);
    let hers = seen.iter().find(|n| n.id == id).expect("Bob sees Alice's note");
    assert_eq!((hers.text.as_str(), &hers.author), ("Alice's", alice.agent_pubkey()));

    // Through the real coordinator: the rules refuse, on Bob's own conductor.
    refused(b, &bz, "edit_note", EditNoteInput { id: id.clone(), text: "Bob was here".into() }, "Only a note's author can edit it").await;
    refused(b, &bz, "delete_note", id.clone(), "Only a note's author can").await;

    let seen: Vec<NoteView> = a.call(&az, "get_notes", ()).await;
    assert_eq!(seen.iter().find(|n| n.id == id).map(|n| n.text.as_str()), Some("Alice's"), "unchanged");
}

#[tokio::test(flavor = "multi_thread")]
async fn a_strangers_own_coordinator_is_refused_every_write() {
    let (ours, theirs) = (board().await, board_with_a_strangers_coordinator().await);
    assert_eq!(ours.dna_hash(), theirs.dna_hash(), "the same network");
    let mut conductor = SweetConductor::standard().await;
    let alice = conductor.setup_app("alice", [&ours]).await.unwrap().into_cells().remove(0);
    let mallory = conductor.setup_app("mallory", [&theirs]).await.unwrap().into_cells().remove(0);
    let (az, mz, mh) = (alice.zome(ZOME), mallory.zome(ZOME), mallory.zome("hostile"));

    let hers: ActionHash = conductor.call(&az, "create_note", "Alice's".to_string()).await;
    let her_edit: ActionHash = conductor.call(&az, "edit_note", EditNoteInput { id: hers.clone(), text: "Alice's, edited".into() }).await;
    let mine: ActionHash = conductor.call(&mz, "create_note", "Mallory's".to_string()).await;
    let my_edit: ActionHash = conductor.call(&mz, "edit_note", EditNoteInput { id: mine.clone(), text: "Mallory's, edited".into() }).await;
    await_consistency([&alice, &mallory]).await.expect("both see each other's records");

    // Someone else's note: no delete, no rewrite, no listing, no unlisting.
    refused(&conductor, &mh, "delete_record", hers.clone(), "Only a note's author can delete it").await;
    refused(&conductor, &mh, "delete_record", her_edit.clone(), "Only a note's author can delete it").await;
    refused(&conductor, &mh, "rewrite", hers.clone(), "Only a note's author can edit it").await;
    refused(&conductor, &mh, "rewrite", her_edit.clone(), "An edit names the note's first record").await;
    refused(&conductor, &mh, "list", hers.clone(), "A note is listed by its own author").await;
    refused(&conductor, &mh, "unlist_everything", (), "Only a note's author can remove it from the board").await;
    // Their own records, in shapes the rules do not allow.
    refused(&conductor, &mh, "rewrite", my_edit.clone(), "An edit names the note's first record").await;
    refused(&conductor, &mh, "list", my_edit.clone(), "A listing points at a note").await;
    refused(&conductor, &mh, "list_an_entry", (), "A listing points at a note").await;
    refused(&conductor, &mh, "list_elsewhere", mine.clone(), "A note is listed under the notes anchor").await;
    refused(&conductor, &mh, "write_raw", String::new(), "A note cannot be empty").await;
    refused(&conductor, &mh, "write_raw", "x".repeat(2001), "at most 2000 characters").await;

    // Alice reads the board as it was.
    let notes: Vec<NoteView> = conductor.call(&az, "get_notes", ()).await;
    assert_eq!(notes.len(), 2, "{notes:?}");
    assert_eq!(notes.iter().find(|n| n.id == hers).map(|n| n.text.as_str()), Some("Alice's, edited"));
}
