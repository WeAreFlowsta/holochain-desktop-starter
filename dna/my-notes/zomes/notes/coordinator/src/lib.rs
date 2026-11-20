//! My notes' functions: what the app calls to write and read the person's
//! own notes.
//!
//! The same calls as the board's, on purpose: the app's two tabs differ
//! only in which network they talk to. Here any of the person's devices
//! may edit or delete any note (see the integrity zome for why).
//!
//! One call the board does not have: `restore_note`, which writes a note
//! back from the person's Vault backup. A restored note is a new record
//! (a record cannot be written again under its old id), so its listing
//! carries the id it had before. That is how a note is never shown twice
//! when the original turns up after all, from a device that was only off.
//!
//! Each list has a `_local` twin that answers from what this device holds
//! and asks no one. With only the person's own devices as peers, that is
//! all there is whenever their other devices are off.

use my_notes_integrity::*;
use hdk::prelude::*;

#[hdk_dependent_entry_types]
enum EntryZomes {
    Integrity(my_notes_integrity::EntryTypes),
}

/// A note as the app shows it.
#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct NoteView {
    /// The note's first record. This is its id: edits and the delete name it.
    pub id: ActionHash,
    /// The key that wrote it: which of the person's devices.
    pub author: AgentPubKey,
    pub text: String,
    /// When it was written, in microseconds since 1970.
    pub created_at: i64,
    /// When it was last edited, if it was.
    pub edited_at: Option<i64>,
    /// For a note restored from a backup: the id it had when it was backed up.
    #[serde(default)]
    pub restored_from: Option<ActionHash>,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct RestoreNoteInput {
    /// The note's id in the backup.
    pub original: ActionHash,
    pub text: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct EditNoteInput {
    pub id: ActionHash,
    pub text: String,
}

/// Write a note and list it.
#[hdk_extern]
pub fn create_note(text: String) -> ExternResult<ActionHash> {
    let id = create_entry(&EntryZomes::Integrity(EntryTypes::Note(Note { text })))?;
    create_link(all_notes_anchor()?, id.clone(), LinkTypes::AllNotes, ())?;
    Ok(id)
}

/// Write a note back from a backup and list it under the id it had.
/// Nothing is written when this device knows the note: it is here, it was
/// restored before, or it was deleted (a deleted note stays deleted).
#[hdk_extern]
pub fn restore_note(input: RestoreNoteInput) -> ExternResult<Option<ActionHash>> {
    if known_here()?.contains(&input.original) {
        return Ok(None);
    }
    let id = create_entry(&EntryZomes::Integrity(EntryTypes::Note(Note { text: input.text })))?;
    create_link(all_notes_anchor()?, id.clone(), LinkTypes::AllNotes, LinkTag::new(input.original.get_raw_39().to_vec()))?;
    Ok(Some(id))
}

/// Of the note ids a backup holds, the ones this device has never seen:
/// what a restore would write. A note that was deleted is not among them.
#[hdk_extern]
pub fn restorable(ids: Vec<ActionHash>) -> ExternResult<Vec<ActionHash>> {
    let known = known_here()?;
    Ok(ids.into_iter().filter(|id| !known.contains(id)).collect())
}

/// Every note id this device has seen listed, deleted ones included: each
/// listing's note, and for a restored note the id it had before.
fn known_here() -> ExternResult<Vec<ActionHash>> {
    let mut known = Vec::new();
    let listings = get_links_details(LinkQuery::try_new(all_notes_anchor()?, LinkTypes::AllNotes)?, GetStrategy::Local)?;
    for (listing, _unlistings) in listings.into_inner() {
        let ActionData::CreateLink(link) = &listing.action().data else { continue };
        known.extend(link.target_address.clone().into_action_hash());
        known.extend(ActionHash::try_from_raw_39(link.tag.0.clone()).ok());
    }
    Ok(known)
}

/// Change a note's text, from any of the person's devices.
#[hdk_extern]
pub fn edit_note(input: EditNoteInput) -> ExternResult<ActionHash> {
    // Always an edit of the first record, whatever edits came before.
    update_entry(input.id, &EntryZomes::Integrity(EntryTypes::Note(Note { text: input.text })))
}

/// Unlist a note and delete it, from any of the person's devices. A note
/// and its restored copy are one note to the person: both go.
#[hdk_extern]
pub fn delete_note(id: ActionHash) -> ExternResult<()> {
    let all = listed(GetStrategy::default())?;
    let origin = all.iter().find(|n| n.id == id).and_then(|n| n.restored_from.clone()).unwrap_or_else(|| id.clone());
    let mut going: Vec<ActionHash> = all.iter().filter(|n| n.id == origin || n.restored_from.as_ref() == Some(&origin)).map(|n| n.id.clone()).collect();
    if !going.contains(&id) {
        going.push(id);
    }
    for link in get_links(LinkQuery::try_new(all_notes_anchor()?, LinkTypes::AllNotes)?, GetStrategy::default())? {
        if link.target.clone().into_action_hash().is_some_and(|target| going.contains(&target)) {
            delete_link(link.create_link_hash, GetOptions::default())?;
        }
    }
    for note in going {
        delete_entry(note)?;
    }
    Ok(())
}

/// Every note, newest first.
#[hdk_extern]
pub fn get_notes(_: ()) -> ExternResult<Vec<NoteView>> {
    notes(GetStrategy::default())
}

/// The notes this device holds, without asking the other devices.
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

/// The notes as the person sees them: a note and its restored copy are
/// shown once, as whichever of the two was changed last.
fn notes(strategy: GetStrategy) -> ExternResult<Vec<NoteView>> {
    let mut found = listed(strategy)?;
    let changed = |n: &NoteView| n.edited_at.unwrap_or(n.created_at);
    let origin = |n: &NoteView| n.restored_from.clone().unwrap_or_else(|| n.id.clone());
    // Latest change first, then keep the first of each note.
    found.sort_by(|a, b| changed(b).cmp(&changed(a)));
    let mut seen: Vec<ActionHash> = Vec::new();
    found.retain(|n| {
        let o = origin(n);
        let first = !seen.contains(&o);
        if first {
            seen.push(o);
        }
        first
    });
    found.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    Ok(found)
}

/// Every listed note that is not deleted, restored copies included.
fn listed(strategy: GetStrategy) -> ExternResult<Vec<NoteView>> {
    let mut found: Vec<NoteView> = Vec::new();
    for link in get_links(LinkQuery::try_new(all_notes_anchor()?, LinkTypes::AllNotes)?, strategy)? {
        let Some(id) = link.target.into_action_hash() else { continue };
        if found.iter().any(|n| n.id == id) {
            continue;
        }
        if let Some(mut note) = note_view(id, strategy)? {
            // A restored note's listing carries the id it had before.
            note.restored_from = ActionHash::try_from_raw_39(link.tag.0.clone()).ok();
            found.push(note);
        }
    }
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
    // The newest edit, whichever of the person's devices made it.
    let newest_edit = details.updates.iter().max_by_key(|u| u.action().timestamp());
    let (record, edited_at) = match newest_edit {
        Some(edit) => match get(edit.as_hash().clone(), options(strategy))? {
            Some(record) => (record, Some(edit.action().timestamp().as_micros())),
            // The edit's record has not arrived yet: show the text held.
            None => (first, None),
        },
        None => (first, None),
    };
    let Some(note) = record.entry().to_app_option::<Note>().map_err(|e| wasm_error!(e))? else { return Ok(None) };
    Ok(Some(NoteView { id, author, text: note.text, created_at, edited_at, restored_from: None }))
}
