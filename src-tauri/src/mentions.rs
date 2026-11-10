//! Speaker names inside a generated summary (issue #49).
//!
//! The summarizer writes speaker names into free text ("Sarah will send the
//! deck"). A rename has to reach those names, but find-and-replace would
//! also hit unrelated words, earlier mentions of the new name, and any text
//! a person wrote, and could not be undone exactly. So when a summary is
//! saved, every whole-word occurrence of a transcript speaker's name is
//! recorded as a mention: which string, which byte span, and who. Speaker
//! edits rewrite only recorded spans that still read the expected name.
//! Nothing else in the summary is ever touched.
//!
//! The store keeps one invariant: every mention names a speaker the
//! transcript currently has, or `Unknown`. `rename_speaker` refuses a name
//! the transcript already uses, so a rename never lands on a span that
//! already reads the new name, and renaming back restores the summary
//! byte for byte.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::llm::SummaryDoc;
use crate::store::Speaker;

/// Which string of a [`SummaryDoc`] a mention sits in.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SummaryField {
    Summary,
    TopicTitle(usize),
    TopicSummary(usize),
    Decision(usize),
    ActionItem(usize),
}

/// One speaker name in a summary: `text(field)[start..end]` reads
/// `speaker.display()`. Offsets are UTF-8 byte offsets.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerMention {
    pub field: SummaryField,
    pub start: usize,
    pub end: usize,
    pub speaker: Speaker,
}

fn fields(doc: &SummaryDoc) -> Vec<SummaryField> {
    let mut out = vec![SummaryField::Summary];
    for i in 0..doc.topics.len() {
        out.push(SummaryField::TopicTitle(i));
        out.push(SummaryField::TopicSummary(i));
    }
    out.extend((0..doc.decisions.len()).map(SummaryField::Decision));
    out.extend((0..doc.action_items.len()).map(SummaryField::ActionItem));
    out
}

fn text(doc: &SummaryDoc, field: SummaryField) -> Option<&str> {
    Some(match field {
        SummaryField::Summary => &doc.summary,
        SummaryField::TopicTitle(i) => &doc.topics.get(i)?.title,
        SummaryField::TopicSummary(i) => &doc.topics.get(i)?.summary,
        SummaryField::Decision(i) => doc.decisions.get(i)?,
        SummaryField::ActionItem(i) => &doc.action_items.get(i)?.text,
    })
}

fn text_mut(doc: &mut SummaryDoc, field: SummaryField) -> Option<&mut String> {
    Some(match field {
        SummaryField::Summary => &mut doc.summary,
        SummaryField::TopicTitle(i) => &mut doc.topics.get_mut(i)?.title,
        SummaryField::TopicSummary(i) => &mut doc.topics.get_mut(i)?.summary,
        SummaryField::Decision(i) => doc.decisions.get_mut(i)?,
        SummaryField::ActionItem(i) => &mut doc.action_items.get_mut(i)?.text,
    })
}

/// Scripts that write words without spaces between them (kana, CJK
/// ideographs, Thai): a name next to one of these still stands alone, as in
/// "Speaker 1が資料を送る".
fn runs_words_together(c: char) -> bool {
    matches!(
        c as u32,
        0x0E00..=0x0E7F | 0x3040..=0x30FF | 0x3400..=0x4DBF | 0x4E00..=0x9FFF | 0xF900..=0xFAFF
    )
}

/// Whether `c` makes the text beside a name part of a longer word, so
/// "Ann" is not a mention inside "Ann-Marie" or "Annual".
fn continues_word(c: Option<char>) -> bool {
    c.is_some_and(|c| (c.is_alphanumeric() || c == '-') && !runs_words_together(c))
}

/// Every whole-word, case-sensitive occurrence of each speaker's display
/// name, longest name first so "Priya Shah" wins over "Priya", and never
/// two mentions over the same bytes. "Speaker 1" does not match inside
/// "Speaker 12". A name followed by a capitalized word ("Sarah Chen") is
/// skipped: that is usually someone else's full name, and a mention missed
/// only means one rename doesn't reach it, while a wrong one corrupts text.
pub fn find(doc: &SummaryDoc, speakers: &[Speaker]) -> Vec<SpeakerMention> {
    let mut by_length: Vec<&Speaker> = speakers.iter().collect();
    by_length.sort_by_key(|speaker| std::cmp::Reverse(speaker.display().len()));
    let mut mentions = Vec::new();
    for field in fields(doc) {
        let haystack = text(doc, field).unwrap_or_default();
        let mut taken: Vec<(usize, usize)> = Vec::new();
        for speaker in &by_length {
            let needle = speaker.display();
            if needle.is_empty() {
                continue;
            }
            for (start, _) in haystack.match_indices(needle) {
                let end = start + needle.len();
                let before = haystack[..start].chars().next_back();
                let after = haystack[end..].chars().next();
                let surname = haystack[end..]
                    .strip_prefix(' ')
                    .and_then(|rest| rest.chars().next())
                    .is_some_and(char::is_uppercase);
                let overlaps = taken.iter().any(|&(s, e)| start < e && s < end);
                if !continues_word(before) && !continues_word(after) && !surname && !overlaps {
                    taken.push((start, end));
                    mentions.push(SpeakerMention {
                        field,
                        start,
                        end,
                        speaker: (*speaker).clone(),
                    });
                }
            }
        }
    }
    mentions.sort_by_key(|m| (m.field, m.start));
    mentions
}

/// Rewrites mention `index` to name `to`, keeping later spans in the same
/// string aligned. Returns `false`, changing nothing, when the span no
/// longer reads the mention's name.
fn rewrite(
    doc: &mut SummaryDoc,
    mentions: &mut [SpeakerMention],
    index: usize,
    to: &Speaker,
) -> bool {
    let SpeakerMention {
        field, start, end, ..
    } = mentions[index];
    let Some(target) = text_mut(doc, field) else {
        return false;
    };
    if target.get(start..end) != Some(mentions[index].speaker.display()) {
        return false;
    }
    target.replace_range(start..end, to.display());
    let new_end = start + to.display().len();
    for later in mentions.iter_mut() {
        if later.field == field && later.start >= end {
            later.start = later.start + new_end - end;
            later.end = later.end + new_end - end;
        }
    }
    mentions[index].end = new_end;
    mentions[index].speaker = to.clone();
    true
}

/// Points every mention of `from` at `to` and rewrites its text. `only`
/// limits the rewrite to those mention indices (undo). A mention whose span
/// no longer reads `from`'s name is skipped, never forced. Returns the
/// rewritten indices.
pub fn retarget(
    doc: &mut SummaryDoc,
    from: &Speaker,
    to: &Speaker,
    only: Option<&[usize]>,
) -> Vec<usize> {
    let mut mentions = std::mem::take(&mut doc.speaker_mentions);
    let mut changed = Vec::new();
    for index in 0..mentions.len() {
        let chosen = only.map_or(true, |only| only.contains(&index));
        if mentions[index].speaker == *from && chosen && rewrite(doc, &mut mentions, index, to) {
            changed.push(index);
        }
    }
    doc.speaker_mentions = mentions;
    changed
}

/// Carries the mentions across a change in who spoke each turn: `before`
/// and `after` give each turn's speaker. A mention follows the turns its
/// speaker spoke. When all of them now belong to one speaker, the mention
/// names that speaker; when they are split, or the turn count changed, the
/// mention is dropped and its text stays as written. This is what keeps a
/// summary right when the transcript changed while the model was writing
/// it, or when a re-run renumbers the speakers.
pub fn follow_turns(doc: &mut SummaryDoc, before: &[Speaker], after: &[Speaker]) {
    if before.len() != after.len() {
        doc.speaker_mentions.clear();
        return;
    }
    let successor = |speaker: &Speaker| -> Option<Speaker> {
        let mut now = before.iter().zip(after).filter(|(was, _)| *was == speaker);
        let (_, first) = now.next()?;
        now.all(|(_, other)| other == first).then(|| first.clone())
    };
    let mut mentions = std::mem::take(&mut doc.speaker_mentions);
    let mut keep = vec![false; mentions.len()];
    for index in 0..mentions.len() {
        if let Some(to) = successor(&mentions[index].speaker) {
            keep[index] = rewrite(doc, &mut mentions, index, &to);
        }
    }
    let mut kept = keep.into_iter();
    mentions.retain(|_| kept.next().unwrap_or(false));
    doc.speaker_mentions = mentions;
}

/// Identifies a summary's text and mentions, ignoring action-item check
/// state: ticking a box after a merge must not block that merge's undo.
pub fn fingerprint(doc: &SummaryDoc) -> String {
    let mut unticked = doc.clone();
    for item in &mut unticked.action_items {
        item.done = false;
    }
    let payload = serde_json::to_vec(&unticked).unwrap_or_default();
    Sha256::digest(payload)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::{ActionItem, SummaryTopic};

    fn named(name: &str) -> Speaker {
        Speaker::Named(name.to_string())
    }

    fn doc() -> SummaryDoc {
        SummaryDoc {
            summary: "Speaker 1 and Speaker 12 agreed. Will Speaker 1 ship?".to_string(),
            topics: vec![SummaryTopic {
                title: "Priya Shah's design pass".to_string(),
                summary: "Priya Shah trims the screens.".to_string(),
            }],
            decisions: vec!["Ship on the 14th.".to_string()],
            action_items: vec![ActionItem {
                text: "Speaker 1 sends notes to Priya Shah.".to_string(),
                done: false,
            }],
            ..Default::default()
        }
    }

    fn with_mentions(mut doc: SummaryDoc, speakers: &[Speaker]) -> SummaryDoc {
        doc.speaker_mentions = find(&doc, speakers);
        doc
    }

    #[test]
    fn find_matches_whole_names_only() {
        let doc = doc();
        let mentions = find(
            &doc,
            &[named("Speaker 1"), named("Priya"), named("Priya Shah")],
        );
        let hits: Vec<(SummaryField, &str)> = mentions
            .iter()
            .map(|m| (m.field, &text(&doc, m.field).unwrap()[m.start..m.end]))
            .collect();
        assert_eq!(
            hits,
            vec![
                (SummaryField::Summary, "Speaker 1"),
                (SummaryField::Summary, "Speaker 1"),
                (SummaryField::TopicTitle(0), "Priya Shah"),
                (SummaryField::TopicSummary(0), "Priya Shah"),
                (SummaryField::ActionItem(0), "Speaker 1"),
                (SummaryField::ActionItem(0), "Priya Shah"),
            ]
        );
        assert!(mentions.iter().all(|m| m.speaker != named("Priya")));
    }

    #[test]
    fn retarget_rewrites_only_recorded_spans_and_keeps_later_spans_aligned() {
        let mut doc = with_mentions(doc(), &[named("Speaker 1"), named("Priya Shah")]);
        retarget(&mut doc, &named("Speaker 1"), &named("Sam"), None);
        assert_eq!(doc.summary, "Sam and Speaker 12 agreed. Will Sam ship?");
        assert_eq!(doc.action_items[0].text, "Sam sends notes to Priya Shah.");

        retarget(&mut doc, &named("Priya Shah"), &named("Priya"), None);
        assert_eq!(doc.action_items[0].text, "Sam sends notes to Priya.");
        assert_eq!(doc.topics[0].title, "Priya's design pass");
    }

    #[test]
    fn renaming_back_restores_the_summary_exactly() {
        let original = with_mentions(doc(), &[named("Speaker 1"), named("Priya Shah")]);
        let mut doc = original.clone();
        retarget(
            &mut doc,
            &named("Speaker 1"),
            &named("Samantha Okafor"),
            None,
        );
        retarget(
            &mut doc,
            &named("Samantha Okafor"),
            &named("Speaker 1"),
            None,
        );
        assert_eq!(doc, original);
    }

    #[test]
    fn retarget_never_touches_text_that_no_longer_reads_the_name() {
        let mut doc = with_mentions(doc(), &[named("Speaker 1")]);
        doc.summary = "Someone rewrote this line by hand entirely.".to_string();
        let changed = retarget(&mut doc, &named("Speaker 1"), &named("Sam"), None);
        assert_eq!(doc.summary, "Someone rewrote this line by hand entirely.");
        assert_eq!(changed, vec![2]);
        assert_eq!(doc.action_items[0].text, "Sam sends notes to Priya Shah.");
    }

    #[test]
    fn retarget_to_unknown_writes_the_unknown_label_and_undo_reverses_it() {
        let original = with_mentions(doc(), &[named("Speaker 1")]);
        let mut doc = original.clone();
        let changed = retarget(&mut doc, &named("Speaker 1"), &Speaker::Unknown, None);
        assert_eq!(
            doc.action_items[0].text,
            "Unknown speaker sends notes to Priya Shah."
        );
        retarget(
            &mut doc,
            &Speaker::Unknown,
            &named("Speaker 1"),
            Some(&changed),
        );
        assert_eq!(doc, original);
    }

    #[test]
    fn find_skips_hyphenated_names_and_other_peoples_full_names_but_reads_cjk() {
        let doc = SummaryDoc {
            summary: "Ann-Marie and Sarah Chen met Sarah. Speaker 1が資料を送る。".to_string(),
            ..Default::default()
        };
        let mentions = find(&doc, &[named("Ann"), named("Sarah"), named("Speaker 1")]);
        let hits: Vec<&str> = mentions
            .iter()
            .map(|m| &doc.summary[m.start..m.end])
            .collect();
        assert_eq!(hits, vec!["Sarah", "Speaker 1"]);
        assert_eq!(
            &doc.summary[..mentions[0].end],
            "Ann-Marie and Sarah Chen met Sarah"
        );
    }

    #[test]
    fn follow_turns_renames_mentions_whose_turns_moved_together_and_drops_split_ones() {
        let mut doc = with_mentions(doc(), &[named("Speaker 1"), named("Priya Shah")]);
        let before = [named("Speaker 1"), named("Priya Shah"), named("Speaker 1")];
        let after = [named("Sam"), named("Priya Shah"), named("Sam")];
        follow_turns(&mut doc, &before, &after);
        assert_eq!(doc.summary, "Sam and Speaker 12 agreed. Will Sam ship?");
        assert_eq!(doc.speaker_mentions.len(), 6);

        let split = [named("Sam"), named("Priya"), named("Dana")];
        follow_turns(&mut doc, &after, &split);
        assert_eq!(doc.action_items[0].text, "Sam sends notes to Priya.");
        assert_eq!(doc.summary, "Sam and Speaker 12 agreed. Will Sam ship?");
        assert_eq!(doc.speaker_mentions.len(), 3);
        assert!(doc
            .speaker_mentions
            .iter()
            .all(|m| m.speaker == named("Priya")));
    }

    #[test]
    fn follow_turns_swaps_labels_without_collapsing_them() {
        let mut doc = SummaryDoc {
            summary: "Speaker 1 asked Speaker 2.".to_string(),
            ..Default::default()
        };
        doc.speaker_mentions = find(&doc, &[named("Speaker 1"), named("Speaker 2")]);
        follow_turns(
            &mut doc,
            &[named("Speaker 1"), named("Speaker 2")],
            &[named("Speaker 2"), named("Speaker 1")],
        );
        assert_eq!(doc.summary, "Speaker 2 asked Speaker 1.");
    }

    #[test]
    fn fingerprint_ignores_ticked_action_items_but_not_text() {
        let doc = doc();
        let mut ticked = doc.clone();
        ticked.action_items[0].done = true;
        assert_eq!(fingerprint(&doc), fingerprint(&ticked));
        let mut edited = doc.clone();
        edited.decisions[0].push('!');
        assert_ne!(fingerprint(&doc), fingerprint(&edited));
    }
}
