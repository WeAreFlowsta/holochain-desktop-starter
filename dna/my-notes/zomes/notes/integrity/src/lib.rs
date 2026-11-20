//! My notes: a person's own notes, on a network only their devices join.
//!
//! The app installs this DNA with a network seed that the person's Flowsta
//! Vault gives it: the same on every one of their devices, different for
//! every person. So each person has a network of their own, and the only
//! peers on it are that person's devices. Nobody else holds these notes,
//! not even as ciphertext.
//!
//! That is why there is no author rule here, where the board has one: every
//! key on this network is the same person on another device, and any of
//! their devices may edit or delete any note. What is still checked is
//! what a note is, so one faulty device cannot fill the others.
//!
//! Making it yours: rename `Note` and its fields, and change `validate_note`.

use hdi::prelude::*;

/// The longest note, in characters.
pub const MAX_NOTE_CHARS: usize = 20_000;

/// A private note.
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
    /// From the anchor to each note's first record: how the notes are listed.
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
        // A new note or an edit: its content is checked wherever it is stored.
        FlatOp::CreateEntry(OpEntry::CreateEntry { app_entry: EntryTypes::Note(note), .. })
        | FlatOp::CreateRecord(OpRecord::CreateEntry { app_entry: EntryTypes::Note(note), .. })
        | FlatOp::CreateEntry(OpEntry::UpdateEntry { app_entry: EntryTypes::Note(note), .. })
        | FlatOp::CreateRecord(OpRecord::UpdateEntry { app_entry: EntryTypes::Note(note), .. })
        | FlatOp::Update(OpUpdate::Entry { app_entry: EntryTypes::Note(note), .. }) => validate_note(&note),

        // A listing starts at the anchor.
        FlatOp::Link(OpLink::CreateLink { link_type: LinkTypes::AllNotes, action }) => {
            if action.data.base_address == AnyLinkableHash::from(all_notes_anchor()?) {
                Ok(ValidateCallbackResult::Valid)
            } else {
                invalid("A note is listed under the notes anchor")
            }
        }

        // Deletes and unlisting: any of the person's devices.
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
