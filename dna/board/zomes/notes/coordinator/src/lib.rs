//! The board's functions: what the app calls to write and read notes.
//!
//! Nothing here is a rule. The rules are the integrity zome's, and every
//! peer enforces them; this zome can be replaced in an app update without
//! starting a new network.
//!
//! Each list has a `_local` twin that answers from what this device holds
//! and asks no one. The app shows it when the network is slow to answer (a
//! conductor that has just started can wait minutes on its first read).

use board_notes_integrity::*;
use hdk::prelude::*;

#[hdk_dependent_entry_types]
enum EntryZomes {
    Integrity(board_notes_integrity::EntryTypes),
}

/// A note as the app shows it.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NoteView {
    /// The note's first record. This is its id: edits and the delete name it.
    pub id: ActionHash,
    /// The key that wrote it (the device's key on this network).
    pub author: AgentPubKey,
    pub text: String,
    /// When it was written, in microseconds since 1970.
    pub created_at: i64,
    /// When it was last edited, if it was.
    pub edited_at: Option<i64>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct EditNoteInput {
    pub id: ActionHash,
    pub text: String,
}

/// Write a note and list it on the board.
#[hdk_extern]
pub fn create_note(text: String) -> ExternResult<ActionHash> {
    let id = create_entry(&EntryZomes::Integrity(EntryTypes::Note(Note { text })))?;
    create_link(all_notes_anchor()?, id.clone(), LinkTypes::AllNotes, ())?;
    Ok(id)
}

/// Change a note's text. The rules refuse this from anyone but its author.
#[hdk_extern]
pub fn edit_note(input: EditNoteInput) -> ExternResult<ActionHash> {
    // Always an edit of the first record, whatever edits came before.
    update_entry(input.id, &EntryZomes::Integrity(EntryTypes::Note(Note { text: input.text })))
}

/// Take a note off the board and delete it. Author only, by the rules.
#[hdk_extern]
pub fn delete_note(id: ActionHash) -> ExternResult<()> {
    for link in get_links(LinkQuery::try_new(all_notes_anchor()?, LinkTypes::AllNotes)?, GetStrategy::default())? {
        if link.target.clone().into_action_hash().as_ref() == Some(&id) {
            delete_link(link.create_link_hash, GetOptions::default())?;
        }
    }
    delete_entry(id)?;
    Ok(())
}

/// Every note on the board, newest first.
#[hdk_extern]
pub fn get_notes(_: ()) -> ExternResult<Vec<NoteView>> {
    notes(GetStrategy::default())
}

/// The board from what this device holds, without asking the network.
#[hdk_extern]
pub fn get_notes_local(_: ()) -> ExternResult<Vec<NoteView>> {
    notes(GetStrategy::Local)
}

fn options(strategy: GetStrategy) -> GetOptions {
    match strategy {
        GetStrategy::Local => GetOptions::local(),
        _ => GetOptions::default(),
    }
}

fn notes(strategy: GetStrategy) -> ExternResult<Vec<NoteView>> {
    let mut found = Vec::new();
    for link in get_links(LinkQuery::try_new(all_notes_anchor()?, LinkTypes::AllNotes)?, strategy)? {
        let Some(id) = link.target.into_action_hash() else { continue };
        if let Some(note) = note_view(id, strategy)? {
            found.push(note);
        }
    }
    found.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    found.dedup_by(|a, b| a.id == b.id);
    Ok(found)
}

/// One note with its latest text, or `None` when it is deleted or not here.
fn note_view(id: ActionHash, strategy: GetStrategy) -> ExternResult<Option<NoteView>> {
    let Some(Details::Record(details)) = get_details(id.clone(), options(strategy))? else { return Ok(None) };
    if !details.deletes.is_empty() {
        return Ok(None);
    }
    let first = details.record;
    let author = first.action().author().clone();
    let created_at = first.action().timestamp().as_micros();
    // The newest edit by the author. The rules already refuse anyone
    // else's; checking again costs nothing and keeps this honest if it is
    // ever read without them.
    let newest_edit = details.updates.iter().filter(|u| *u.action().author() == author).max_by_key(|u| u.action().timestamp());
    let (record, edited_at) = match newest_edit {
        Some(edit) => match get(edit.as_hash().clone(), options(strategy))? {
            Some(record) => (record, Some(edit.action().timestamp().as_micros())),
            // The edit's record has not arrived yet: show the text held.
            None => (first, None),
        },
        None => (first, None),
    };
    let Some(note) = record.entry().to_app_option::<Note>().map_err(|e| wasm_error!(e))? else { return Ok(None) };
    Ok(Some(NoteView { id, author, text: note.text, created_at, edited_at }))
}
