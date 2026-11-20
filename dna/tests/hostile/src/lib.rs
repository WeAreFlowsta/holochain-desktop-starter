//! Test only. What a stranger can try against the board with a coordinator
//! of their own (and what a faulty device can try on a person's own
//! network: the two DNAs' notes have the same shape, so the tests run this
//! one file against both): a coordinator is not part of what names the network, so
//! anyone can run any functions they like on it. Only the integrity zome's
//! rules stand between them and other people's notes. The tests run this
//! beside the real coordinator and expect every write here to be refused.

use board_notes_integrity::*;
use hdk::prelude::*;

#[hdk_dependent_entry_types]
enum EntryZomes {
    Integrity(board_notes_integrity::EntryTypes),
}

/// Delete any record.
#[hdk_extern]
pub fn delete_record(hash: ActionHash) -> ExternResult<ActionHash> {
    delete_entry(hash)
}

/// Rewrite any record by updating it.
#[hdk_extern]
pub fn rewrite(hash: ActionHash) -> ExternResult<ActionHash> {
    update_entry(hash, &EntryZomes::Integrity(EntryTypes::Note(Note { text: "Rewritten".into() })))
}

/// List any record on the board.
#[hdk_extern]
pub fn list(hash: ActionHash) -> ExternResult<ActionHash> {
    create_link(all_notes_anchor()?, hash, LinkTypes::AllNotes, ())
}

/// List something that is not a record at all (an entry's address).
#[hdk_extern]
pub fn list_an_entry(_: ()) -> ExternResult<ActionHash> {
    create_link(all_notes_anchor()?, all_notes_anchor()?, LinkTypes::AllNotes, ())
}

/// List a note somewhere other than the board's anchor.
#[hdk_extern]
pub fn list_elsewhere(hash: ActionHash) -> ExternResult<ActionHash> {
    create_link(hash.clone(), hash, LinkTypes::AllNotes, ())
}

/// Take every note off the board.
#[hdk_extern]
pub fn unlist_everything(_: ()) -> ExternResult<u32> {
    let mut removed = 0;
    for link in get_links(LinkQuery::try_new(all_notes_anchor()?, LinkTypes::AllNotes)?, GetStrategy::default())? {
        delete_link(link.create_link_hash, GetOptions::default())?;
        removed += 1;
    }
    Ok(removed)
}

/// A note that breaks the content rules, written without the real
/// coordinator in the way.
#[hdk_extern]
pub fn write_raw(text: String) -> ExternResult<ActionHash> {
    create_entry(&EntryZomes::Integrity(EntryTypes::Note(Note { text })))
}
