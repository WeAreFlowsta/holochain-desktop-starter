//! The board: notes everyone running the app can read.
//!
//! This file is the whole set of rules for the shared network. Every peer
//! runs it on every record it is asked to hold, so a modified app cannot
//! get a record past them. A coordinator (the other zome) can be replaced
//! in an update; this file cannot, because it is part of what names the
//! network: change it and you have a new, empty network.
//!
//! Who may do what:
//!   - Anyone on the network writes a note.
//!   - A note is edited and deleted by its author only. "Author" is the key
//!     that signed it: each device has its own key, so a note is changed on
//!     the device that wrote it. (Which keys are one person is the
//!     agent-linking zome's record; the app uses it to show a name.)
//!   - A note is listed (a link from one well-known anchor) by its author
//!     only, and unlisted by whoever listed it.
//!
//! Making it yours: rename `Note` and its fields, and change `validate_note`
//! to say what a valid record of yours is. Keep the author checks.

use hdi::prelude::*;

/// The longest note, in characters. A limit every peer enforces: without
/// one, anyone can make every peer store whatever they like.
pub const MAX_NOTE_CHARS: usize = 2000;

/// A note on the board.
#[hdk_entry_helper]
#[derive(Clone, PartialEq)]
pub struct Note {
    pub text: String,
}

#[hdk_entry_types]
#[unit_enum(UnitEntryTypes)]
#[derive(Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum EntryTypes {
    Note(Note),
}

#[derive(Serialize, Deserialize)]
#[hdk_link_types]
pub enum LinkTypes {
    /// From the anchor to each note's first record: how the board is listed.
    AllNotes,
}

/// The one address every note is listed under.
pub fn all_notes_anchor() -> ExternResult<EntryHash> {
    hash_entry(&Note { text: "ALL_NOTES_ANCHOR".to_string() })
}

fn invalid(reason: impl Into<String>) -> ExternResult<ValidateCallbackResult> {
    Ok(ValidateCallbackResult::Invalid(reason.into()))
}

#[hdk_extern]
pub fn validate(op: Op) -> ExternResult<ValidateCallbackResult> {
    match op.flattened::<EntryTypes, LinkTypes>()? {
        // A new note: its content is checked wherever it is stored.
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry: EntryTypes::Note(note), .. })
        | FlatOp::CreateRecord(OpRecord::CreateEntry { app_entry: EntryTypes::Note(note), .. }) => validate_note(&note),

        // An edit: valid content, and only by the author of the note it edits.
        FlatOp::CreateEntry(OpEntry::UpdateEntry { app_entry: EntryTypes::Note(note), action })
        | FlatOp::CreateRecord(OpRecord::UpdateEntry { app_entry: EntryTypes::Note(note), action })
        | FlatOp::Update(OpUpdate::Entry { app_entry: EntryTypes::Note(note), action }) => {
            if let ValidateCallbackResult::Invalid(reason) = validate_note(&note)? {
                return invalid(reason);
            }
            validate_edit(action.author(), &action.data.original_action_address)
        }

        // A delete: only by the author of the record it deletes.
        FlatOp::CreateRecord(OpRecord::DeleteEntry { action }) | FlatOp::Delete(OpDelete { action }) => {
            validate_delete(action.author(), &action.data.deletes_address)
        }

        // Listing a note: from the anchor, to a note, by that note's author.
        FlatOp::Link(OpLink::CreateLink { link_type: LinkTypes::AllNotes, action }) => {
            if action.data.base_address != AnyLinkableHash::from(all_notes_anchor()?) {
                return invalid("A note is listed under the notes anchor");
            }
            let Some(target) = action.data.target_address.clone().into_action_hash() else {
                return invalid("A listing points at a note");
            };
            match first_record(target)? {
                Some(author) if author == *action.author() => Ok(ValidateCallbackResult::Valid),
                Some(_) => invalid("A note is listed by its own author"),
                None => invalid("A listing points at a note"),
            }
        }

        // Unlisting: only by whoever made the listing (the note's author).
        FlatOp::Link(OpLink::DeleteLink { original_action, action, .. }) => {
            if original_action.author() == action.author() {
                Ok(ValidateCallbackResult::Valid)
            } else {
                invalid("Only a note's author can remove it from the board")
            }
        }

        _ => Ok(ValidateCallbackResult::Valid),
    }
}

/// What a valid note is.
fn validate_note(note: &Note) -> ExternResult<ValidateCallbackResult> {
    if note.text.trim().is_empty() {
        return invalid("A note cannot be empty");
    }
    if note.text.chars().count() > MAX_NOTE_CHARS {
        return invalid(format!("A note is at most {MAX_NOTE_CHARS} characters"));
    }
    Ok(ValidateCallbackResult::Valid)
}

/// The record at `hash` when it belongs to this zome: its author, and
/// whether it is a note's FIRST record (a create, not an edit). `None` for
/// another zome's record (the agent-linking zome has rules of its own).
fn our_record(hash: ActionHash) -> ExternResult<Option<(AgentPubKey, bool)>> {
    let record = must_get_valid_record(hash)?;
    let ours = match (record.action().entry_type(), record.entry().as_option()) {
        (Some(EntryType::App(def)), Some(entry)) => EntryTypes::deserialize_from_type(def.zome_index, def.entry_index, entry)?.is_some(),
        _ => false,
    };
    Ok(ours.then(|| (record.action().author().clone(), matches!(record.action().data, ActionData::Create(_)))))
}

/// The author of a note's first record, or `None` when `hash` is not one.
fn first_record(hash: ActionHash) -> ExternResult<Option<AgentPubKey>> {
    Ok(our_record(hash)?.and_then(|(author, first)| first.then_some(author)))
}

/// An edit names a note's first record, and comes from that note's author.
/// Every edit points at the first record, never at another edit, so reading
/// the latest text is one lookup and no one can splice into a chain of edits.
fn validate_edit(editor: &AgentPubKey, edits: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    match first_record(edits.clone())? {
        Some(author) if author == *editor => Ok(ValidateCallbackResult::Valid),
        Some(_) => invalid("Only a note's author can edit it"),
        None => invalid("An edit names the note's first record"),
    }
}

/// A delete of a note (its first record or an edit) comes from the author
/// of the record it deletes.
fn validate_delete(deleter: &AgentPubKey, deletes: &ActionHash) -> ExternResult<ValidateCallbackResult> {
    match our_record(deletes.clone())? {
        Some((author, _)) if author != *deleter => invalid("Only a note's author can delete it"),
        _ => Ok(ValidateCallbackResult::Valid),
    }
}
