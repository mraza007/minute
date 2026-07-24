//! On-device summarization engine (llama-cpp-2, Metal-accelerated on Apple
//! Silicon).
//!
//! Stage 3 Task 1 proved the integration end to end: the `llama-cpp-2`
//! dependency compiles with Metal support, a real Qwen3.5-4B GGUF (fetched
//! via the existing `catalog`/`download` machinery from Stage 2) loads
//! through it, and a trivial chat-templated generation produces real output
//! — see [`tests::real_llm_loads_and_generates`], run manually.
//!
//! Task 3 (this module's pure core) adds the two halves of the
//! summarization contract that don't need a loaded model to test:
//! [`build_summary_prompt`] renders a note's transcript into the user-role
//! prompt content the engine will chat-template and feed to generation, and
//! [`extract_summary_json`] tolerantly recovers a [`SummaryDoc`] from
//! whatever the model actually emits — clean JSON, fenced JSON,
//! prose-wrapped JSON, or JSON trailing a `<think>...</think>` reasoning
//! block (Qwen3.5 emits these, verified in Task 1). The lazily-loaded,
//! settings-keyed engine (`LlmEngine`, reload-on-model-change, the
//! `summarize_note` worker) is built out in Task 4 per
//! `docs/plans/2026-07-23-stage3-summaries.md`; `LlmEngine` here remains a
//! placeholder shape only, wired into `lib.rs` so that task has a module to
//! grow instead of introducing one from scratch mid-stage.

use serde::{Deserialize, Serialize};

use crate::error::{MinuteError, Result};
use crate::store::StoredSegment;

/// Placeholder for the lazily-loaded llama-cpp-2 engine. Real state (the
/// currently-loaded model id, its `LlamaModel`/`LlamaContext`, and
/// reload-when-the-id-changes logic — see the plan's Task 4) lands later;
/// this exists now purely so `lib.rs` can wire `mod llm;` and later tasks
/// have a concrete type to extend rather than introduce fresh.
#[allow(dead_code)]
pub(crate) struct LlmEngine;

impl LlmEngine {
    /// Placeholder constructor — no model is loaded yet. Real construction
    /// (managed Tauri state, mutex-guarded like `SharedStore`/
    /// `SharedRecorderState`) arrives with Task 4.
    #[allow(dead_code)]
    pub(crate) fn new() -> Self {
        Self
    }
}

/// One action item extracted from a summary: its text and whether the user
/// has checked it off. Models never produce `done: true` themselves — every
/// item extracted from a fresh generation starts `false` (see
/// [`extract_summary_json`]); `done` only ever flips via
/// `store::Store::toggle_action_item`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActionItem {
    pub text: String,
    pub done: bool,
}

/// A note's generated summary, persisted as `notes/<id>/summary.json` (see
/// `store::Store::write_summary`/`read_summary`) and rendered into
/// `note.md`'s `## Summary`/`## Decisions`/`## Action items` sections (see
/// `store::render_note_md`).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SummaryDoc {
    pub summary: String,
    pub decisions: Vec<String>,
    pub action_items: Vec<ActionItem>,
}

/// Formats a segment's start time as `mm:ss` for the transcript rendered
/// into the summary prompt — deliberately the same rounding rule as the
/// frontend's `formatMmSs` (`src/state/adapters.ts`): negative/NaN clamps
/// to 0, whole seconds only (fractional seconds truncate). `store.rs`'s
/// `note.md` transcript rendering uses an equivalent helper of its own —
/// duplicated rather than shared because the two call sites format the
/// timestamp into different surrounding punctuation (`[mm:ss]` here vs
/// `(mm:ss)` there) and neither module depends on the other.
fn format_mm_ss(total_seconds: f64) -> String {
    let whole_seconds = total_seconds.max(0.0).floor() as u64;
    let mm = whole_seconds / 60;
    let ss = whole_seconds % 60;
    format!("{mm:02}:{ss:02}")
}

/// Renders a transcript's segments as `[mm:ss] Speaker: text` lines, one per
/// segment, joined with newlines — the exact shape the summary prompt asks
/// the model to read.
fn format_transcript_lines(segments: &[StoredSegment]) -> String {
    segments
        .iter()
        .map(|seg| format!("[{}] {}: {}", format_mm_ss(seg.start), seg.speaker, seg.text))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Byte offset budget for the rendered transcript before
/// [`truncate_transcript_for_prompt`] kicks in — see that function's docs.
const TRANSCRIPT_CHAR_BUDGET: usize = 24_000;
/// How much of the transcript to keep from each end when truncating —
/// half the budget from the head, half from the tail.
const TRANSCRIPT_HALF_BUDGET: usize = 12_000;
const OMISSION_MARKER: &str = "\n[... middle of transcript omitted ...]\n";

/// Rounds a byte index down to the nearest UTF-8 char boundary at or before
/// it, so a fixed-size byte budget can be used to slice a `&str` without
/// risking a panic on a multi-byte character straddling the cut.
fn floor_char_boundary(s: &str, idx: usize) -> usize {
    let mut i = idx.min(s.len());
    while i > 0 && !s.is_char_boundary(i) {
        i -= 1;
    }
    i
}

/// Rounds a byte index up to the nearest UTF-8 char boundary at or after
/// it — the tail-truncation counterpart to [`floor_char_boundary`].
fn ceil_char_boundary(s: &str, idx: usize) -> usize {
    let mut i = idx.min(s.len());
    while i < s.len() && !s.is_char_boundary(i) {
        i += 1;
    }
    i
}

/// The first ~`budget` bytes of `s`, pulled back to the nearest preceding
/// line boundary so a line is never cut in half.
fn head_by_lines(s: &str, budget: usize) -> &str {
    let cut = floor_char_boundary(s, budget);
    let cut = &s[..cut];
    match cut.rfind('\n') {
        Some(idx) => &cut[..idx],
        None => cut,
    }
}

/// The last ~`budget` bytes of `s`, pushed forward past the first line
/// boundary so the kept tail never starts mid-line.
fn tail_by_lines(s: &str, budget: usize) -> &str {
    let start = ceil_char_boundary(s, s.len().saturating_sub(budget));
    let cut = &s[start..];
    match cut.find('\n') {
        Some(idx) => &cut[idx + 1..],
        None => cut,
    }
}

/// Applies the summary prompt's token budget: transcripts under
/// [`TRANSCRIPT_CHAR_BUDGET`] chars pass through untouched; longer ones are
/// cut down to their first and last [`TRANSCRIPT_HALF_BUDGET`] chars (each
/// snapped to a line boundary so no line is split mid-text), joined by
/// [`OMISSION_MARKER`]. This keeps the meeting's opening and closing —
/// where framing and wrap-up/decisions tend to land — in context even when
/// the middle has to give way.
fn truncate_transcript_for_prompt(full: &str) -> String {
    if full.len() <= TRANSCRIPT_CHAR_BUDGET {
        return full.to_string();
    }
    let head = head_by_lines(full, TRANSCRIPT_HALF_BUDGET);
    let tail = tail_by_lines(full, TRANSCRIPT_HALF_BUDGET);
    format!("{head}{OMISSION_MARKER}{tail}")
}

/// Builds the user-role prompt content for summarizing `segments` (a
/// transcript's stored segments) under the note's `title`. The chat
/// template itself (wrapping this as a `user` message, adding any
/// model-specific system framing) is applied later by the engine (Task 4)
/// — this is just the content.
///
/// Demands STRICT JSON matching
/// `{"summary": string, "decisions": [string], "action_items": [{"text": string}]}`
/// and explicitly forbids prose/fences/reasoning in the response, since
/// [`extract_summary_json`] — while tolerant — still needs *something*
/// resembling that shape to recover a useful summary from.
///
/// Not yet called from anywhere outside its own tests — `LlmEngine`'s real
/// generation path (Task 4) is the eventual caller; see that placeholder's
/// docs for why this module still carries `#[allow(dead_code)]` this stage.
#[allow(dead_code)]
pub fn build_summary_prompt(title: &str, segments: &[StoredSegment]) -> String {
    let full_transcript = format_transcript_lines(segments);
    let transcript = truncate_transcript_for_prompt(&full_transcript);
    format!(
        "You are a meeting summarizer. Read the transcript below and respond with STRICT JSON \
         matching this schema exactly:\n\
         {{\"summary\": string, \"decisions\": [string], \"action_items\": [{{\"text\": string}}]}}\n\
         \n\
         Rules:\n\
         - \"summary\": at most 3 sentences describing what the meeting was about.\n\
         - \"decisions\": things that were agreed or resolved during the meeting.\n\
         - \"action_items\": concrete follow-up tasks that came out of the meeting.\n\
         Respond with the JSON object only — no prose, no markdown fences, no reasoning.\n\
         \n\
         Meeting: {title}\n\
         \n\
         Transcript:\n\
         {transcript}"
    )
}

/// Strips `<think>...</think>` reasoning blocks Qwen3.5 (and similar
/// reasoning-tuned models) prepend to their actual answer.
///
/// - No `<think>` at all: `raw` is returned unchanged.
/// - At least one `</think>` present: everything after the *last*
///   `</think>` is returned — this also correctly handles a dangling,
///   never-closed trailing `<think>` that appears *after* the real answer
///   (e.g. the model started reasoning again post-JSON and got cut off);
///   that trailing junk is simply left in the returned tail for the
///   downstream JSON-object scan to skip over.
/// - `<think>` present with no `</think>` anywhere: the whole response is
///   reasoning with no recoverable answer — `Err`.
fn strip_reasoning(raw: &str) -> Result<String> {
    let has_open = raw.contains("<think>");
    let has_close = raw.contains("</think>");
    if has_open && !has_close {
        return Err(MinuteError::Other("model produced only reasoning".to_string()));
    }
    if has_close {
        return Ok(raw.rsplit("</think>").next().unwrap_or("").to_string());
    }
    Ok(raw.to_string())
}

/// Strips a single wrapping markdown code fence (` ```json\n...\n``` ` or
/// ` ```\n...\n``` `) if the trimmed input starts with one. Not load-bearing
/// for correctness — [`find_balanced_json_object`] would find the JSON
/// object through the fence markers regardless, since they're just
/// characters outside any brace — but stripping them first keeps the
/// extraction pipeline's steps matching the spec 1:1 and gives a cleaner
/// snippet in error messages when no fence is present.
fn strip_code_fence(s: &str) -> String {
    let trimmed = s.trim();
    let Some(after_open) = trimmed.strip_prefix("```") else {
        return trimmed.to_string();
    };
    // Skip an optional language tag (e.g. `json`) up to the first newline.
    let after_lang = match after_open.find('\n') {
        Some(idx) => &after_open[idx + 1..],
        None => after_open,
    };
    match after_lang.rfind("```") {
        Some(idx) => after_lang[..idx].trim().to_string(),
        None => after_lang.trim().to_string(),
    }
}

/// Finds the first balanced `{...}` object in `s` via a brace-depth scan
/// that respects JSON string contents (braces inside a quoted string, or an
/// escaped quote, never affect depth or terminate the string early). Returns
/// the matched slice (including both braces) or `None` if no `{` starts a
/// run that ever returns to depth 0.
fn find_balanced_json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let mut depth: i32 = 0;
    let mut in_string = false;
    let mut escape = false;

    for (i, c) in s[start..].char_indices() {
        let abs = start + i;
        if in_string {
            if escape {
                escape = false;
            } else if c == '\\' {
                escape = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    let end = abs + c.len_utf8();
                    return Some(&s[start..end]);
                }
            }
            _ => {}
        }
    }
    None
}

/// Truncates `raw` to at most 200 chars (char-safe) for embedding in an
/// extraction error message/event — long raw model output shouldn't blow up
/// the error surfaced to the frontend.
fn snippet(raw: &str) -> String {
    let trimmed = raw.trim();
    if trimmed.chars().count() <= 200 {
        trimmed.to_string()
    } else {
        let truncated: String = trimmed.chars().take(200).collect();
        format!("{truncated}…")
    }
}

/// One action item as it might appear in the model's raw JSON: either the
/// spec'd `{"text": "..."}` object, or a bare string — models vary, and both
/// are accepted. Untagged so serde tries `Object` first, falling back to
/// `String`.
#[derive(Deserialize)]
#[serde(untagged)]
enum RawActionItem {
    Object { text: String },
    Bare(String),
}

/// The tolerant shape `extract_summary_json` actually deserializes into:
/// every field optional (missing → default), `action_items` accepting
/// either object or bare-string entries per [`RawActionItem`]. Kept
/// separate from the wire-facing [`SummaryDoc`] (which has no `Option`s and
/// isn't `#[serde(default)]`) so `SummaryDoc`'s shape stays a strict,
/// unambiguous contract for every *other* caller (store.rs, the frontend)
/// while this one spot absorbs the model's unreliability.
// Deliberately no `rename_all = "camelCase"`: the *model's* schema (per
// `build_summary_prompt`) asks for snake_case `action_items`, distinct from
// the camelCase `actionItems` the wire-facing `SummaryDoc` uses for the
// frontend — this struct's field names already match the model's JSON keys
// as written.
#[derive(Deserialize, Default)]
#[serde(default)]
struct RawSummary {
    summary: String,
    decisions: Vec<String>,
    action_items: Vec<RawActionItem>,
}

/// Tolerantly extracts a [`SummaryDoc`] from a model's raw generation
/// output. Handles, in order:
///
/// 1. `<think>...</think>` reasoning blocks (see [`strip_reasoning`]) —
///    `Err` if the response is reasoning with no closed block at all.
/// 2. A wrapping markdown code fence (see [`strip_code_fence`]).
/// 3. The first balanced `{...}` JSON object anywhere in what remains (see
///    [`find_balanced_json_object`]) — tolerates prose before/after it
///    ("Here is the summary: {...} hope that helps").
///
/// Once a JSON object is found, it's parsed tolerantly: missing keys become
/// empty defaults, and `action_items` entries may be either `{"text": ...}`
/// objects or bare strings. Every extracted action item starts `done: false`
/// — the model has no channel to mark one already done.
///
/// `Err` (with a ≤200-char snippet of what was actually seen, for the
/// `summary-status` error event) when: the response is pure reasoning, no
/// `{...}` object can be found at all, or what looks like an object doesn't
/// actually parse as JSON.
///
/// Not yet called from anywhere outside its own tests — `LlmEngine`'s real
/// generation path (Task 4) is the eventual caller; see
/// [`build_summary_prompt`]'s docs for the same not-wired-in-yet note.
#[allow(dead_code)]
pub fn extract_summary_json(raw: &str) -> Result<SummaryDoc> {
    let after_reasoning = strip_reasoning(raw)?;
    let cleaned = strip_code_fence(&after_reasoning);

    let json_str = find_balanced_json_object(&cleaned).ok_or_else(|| {
        MinuteError::Other(format!(
            "no JSON object found in model output: {}",
            snippet(raw)
        ))
    })?;

    let parsed: RawSummary = serde_json::from_str(json_str).map_err(|e| {
        MinuteError::Other(format!(
            "failed to parse JSON from model output ({e}): {}",
            snippet(raw)
        ))
    })?;

    let action_items = parsed
        .action_items
        .into_iter()
        .map(|item| ActionItem {
            text: match item {
                RawActionItem::Object { text } => text,
                RawActionItem::Bare(text) => text,
            },
            done: false,
        })
        .collect();

    Ok(SummaryDoc {
        summary: parsed.summary,
        decisions: parsed.decisions,
        action_items,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn llm_engine_placeholder_constructs() {
        let _engine = LlmEngine::new();
    }

    // --- build_summary_prompt -------------------------------------------------

    fn seg(speaker: &str, start: f64, text: &str) -> StoredSegment {
        StoredSegment {
            speaker: speaker.to_string(),
            start,
            end: start + 1.0,
            text: text.to_string(),
        }
    }

    #[test]
    fn prompt_contains_the_strict_json_instruction_verbatim() {
        let prompt = build_summary_prompt("Standup", &[]);
        assert!(prompt.contains(
            "Respond with the JSON object only — no prose, no markdown fences, no reasoning."
        ));
    }

    #[test]
    fn prompt_contains_the_schema_shape() {
        let prompt = build_summary_prompt("Standup", &[]);
        assert!(prompt.contains(
            "{\"summary\": string, \"decisions\": [string], \"action_items\": [{\"text\": string}]}"
        ));
    }

    #[test]
    fn prompt_includes_the_meeting_title() {
        let prompt = build_summary_prompt("Client call — Acme", &[]);
        assert!(prompt.contains("Meeting: Client call — Acme"));
    }

    #[test]
    fn short_transcript_is_rendered_intact_with_exact_line_formatting() {
        let segments = vec![
            seg("Speaker 1", 41.0, "Thanks for making time."),
            seg("Speaker 2", 94.0, "Happy to be here."),
        ];
        let prompt = build_summary_prompt("Standup", &segments);

        assert!(prompt.contains("[00:41] Speaker 1: Thanks for making time."));
        assert!(prompt.contains("[01:34] Speaker 2: Happy to be here."));
        assert!(!prompt.contains("omitted"));
    }

    #[test]
    fn long_transcript_is_truncated_keeping_head_and_tail_with_marker() {
        // Each line is well over 100 bytes, so a few hundred segments blow
        // past the 24_000-char budget comfortably.
        let segments: Vec<StoredSegment> = (0..600)
            .map(|i| {
                seg(
                    "Speaker 1",
                    i as f64,
                    &format!("this is filler line number {i} padded out to be reasonably long"),
                )
            })
            .collect();
        let prompt = build_summary_prompt("Long meeting", &segments);

        assert!(prompt.contains(OMISSION_MARKER.trim()));
        // First line's content survives (head kept).
        assert!(prompt.contains("this is filler line number 0 "));
        // Last line's content survives (tail kept).
        assert!(prompt.contains("this is filler line number 599 "));
        // A middle line does not survive — proves the middle was actually cut.
        assert!(!prompt.contains("this is filler line number 300 "));
    }

    #[test]
    fn truncated_transcript_never_splits_a_line_in_half() {
        let segments: Vec<StoredSegment> = (0..600)
            .map(|i| seg("Speaker 1", i as f64, &format!("line {i} of filler text here")))
            .collect();
        let full = format_transcript_lines(&segments);
        let truncated = truncate_transcript_for_prompt(&full);

        for part in truncated.split(OMISSION_MARKER) {
            for line in part.lines() {
                if line.is_empty() {
                    continue;
                }
                // Every surviving line must be a complete, exact line from
                // the untruncated transcript — not a fragment of one.
                assert!(
                    full.lines().any(|full_line| full_line == line),
                    "line {line:?} is not a complete line from the original transcript"
                );
            }
        }
    }

    #[test]
    fn transcript_at_exactly_the_budget_is_not_truncated() {
        // Sanity-check the boundary condition itself rather than relying on
        // only "clearly under" / "clearly over" cases.
        let line = "x".repeat(TRANSCRIPT_CHAR_BUDGET);
        assert_eq!(truncate_transcript_for_prompt(&line), line);
    }

    // --- extract_summary_json: clean / fenced / prose-wrapped ------------------

    #[test]
    fn extracts_clean_json() {
        let raw = r#"{"summary": "Discussed Q3 roadmap.", "decisions": ["Ship by Friday"], "action_items": [{"text": "Write release notes"}]}"#;
        let doc = extract_summary_json(raw).unwrap();

        assert_eq!(doc.summary, "Discussed Q3 roadmap.");
        assert_eq!(doc.decisions, vec!["Ship by Friday".to_string()]);
        assert_eq!(doc.action_items.len(), 1);
        assert_eq!(doc.action_items[0].text, "Write release notes");
        assert!(!doc.action_items[0].done);
    }

    #[test]
    fn extracts_json_wrapped_in_a_json_language_fence() {
        let raw = "```json\n{\"summary\": \"Short sync.\", \"decisions\": [], \"action_items\": []}\n```";
        let doc = extract_summary_json(raw).unwrap();
        assert_eq!(doc.summary, "Short sync.");
    }

    #[test]
    fn extracts_json_wrapped_in_a_bare_fence() {
        let raw = "```\n{\"summary\": \"Short sync.\", \"decisions\": [], \"action_items\": []}\n```";
        let doc = extract_summary_json(raw).unwrap();
        assert_eq!(doc.summary, "Short sync.");
    }

    #[test]
    fn extracts_json_wrapped_in_prose() {
        let raw = "Here is the summary: {\"summary\": \"All good.\", \"decisions\": [], \"action_items\": []} hope that helps";
        let doc = extract_summary_json(raw).unwrap();
        assert_eq!(doc.summary, "All good.");
    }

    // --- extract_summary_json: reasoning blocks ---------------------------------

    #[test]
    fn strips_a_closed_think_block_before_the_json() {
        let raw = "<think>let me consider the transcript...</think>{\"summary\": \"Fine.\", \"decisions\": [], \"action_items\": []}";
        let doc = extract_summary_json(raw).unwrap();
        assert_eq!(doc.summary, "Fine.");
    }

    #[test]
    fn keeps_only_the_text_after_the_last_closed_think_block() {
        let raw = "<think>first pass</think><think>second pass</think>{\"summary\": \"Final.\", \"decisions\": [], \"action_items\": []}";
        let doc = extract_summary_json(raw).unwrap();
        assert_eq!(doc.summary, "Final.");
    }

    #[test]
    fn tolerates_a_dangling_unclosed_think_block_after_the_json() {
        let raw = "<think>reasoning</think>{\"summary\": \"Done.\", \"decisions\": [], \"action_items\": []}<think>starting to reconsider";
        let doc = extract_summary_json(raw).unwrap();
        assert_eq!(doc.summary, "Done.");
    }

    #[test]
    fn unclosed_think_block_with_no_json_at_all_is_an_error() {
        let raw = "<think>still thinking about this, never got to an answer";
        let err = extract_summary_json(raw).unwrap_err();
        assert!(err.to_string().contains("only reasoning"));
    }

    // --- extract_summary_json: structural edge cases ----------------------------

    #[test]
    fn braces_inside_json_strings_do_not_confuse_the_balance_scan() {
        let raw = r#"{"summary": "She said \"use {curly} braces\" in the meeting.", "decisions": [], "action_items": []}"#;
        let doc = extract_summary_json(raw).unwrap();
        assert_eq!(doc.summary, "She said \"use {curly} braces\" in the meeting.");
    }

    #[test]
    fn bare_string_action_items_are_accepted() {
        let raw = r#"{"summary": "x", "decisions": [], "action_items": ["Buy milk", "Call Bob"]}"#;
        let doc = extract_summary_json(raw).unwrap();
        assert_eq!(doc.action_items.len(), 2);
        assert_eq!(doc.action_items[0].text, "Buy milk");
        assert_eq!(doc.action_items[1].text, "Call Bob");
        assert!(doc.action_items.iter().all(|item| !item.done));
    }

    #[test]
    fn object_action_items_are_accepted() {
        let raw = r#"{"summary": "x", "decisions": [], "action_items": [{"text": "Buy milk"}]}"#;
        let doc = extract_summary_json(raw).unwrap();
        assert_eq!(doc.action_items[0].text, "Buy milk");
    }

    #[test]
    fn missing_keys_default_to_empty() {
        let doc = extract_summary_json("{}").unwrap();
        assert_eq!(doc.summary, "");
        assert!(doc.decisions.is_empty());
        assert!(doc.action_items.is_empty());
    }

    #[test]
    fn empty_arrays_parse_fine() {
        let raw = r#"{"summary": "Nothing much happened.", "decisions": [], "action_items": []}"#;
        let doc = extract_summary_json(raw).unwrap();
        assert_eq!(doc.summary, "Nothing much happened.");
        assert!(doc.decisions.is_empty());
        assert!(doc.action_items.is_empty());
    }

    #[test]
    fn multiple_decisions_and_action_items_preserve_order() {
        let raw = r#"{"summary": "x", "decisions": ["First", "Second"], "action_items": [{"text": "A"}, {"text": "B"}]}"#;
        let doc = extract_summary_json(raw).unwrap();
        assert_eq!(doc.decisions, vec!["First".to_string(), "Second".to_string()]);
        assert_eq!(doc.action_items[0].text, "A");
        assert_eq!(doc.action_items[1].text, "B");
    }

    #[test]
    fn garbage_with_no_json_object_is_an_error() {
        let err = extract_summary_json("the model just rambled with no structure at all").unwrap_err();
        assert!(err.to_string().contains("no JSON object found"));
    }

    #[test]
    fn unbalanced_braces_are_an_error() {
        let err = extract_summary_json("{\"summary\": \"never closed").unwrap_err();
        assert!(err.to_string().contains("no JSON object found"));
    }

    #[test]
    fn error_message_includes_a_snippet_of_the_raw_output() {
        let err = extract_summary_json("totally unstructured reply").unwrap_err();
        assert!(err.to_string().contains("totally unstructured reply"));
    }

    #[test]
    fn error_snippet_is_truncated_to_200_chars() {
        let raw = "x".repeat(500);
        let err = extract_summary_json(&raw).unwrap_err();
        // The snippet portion of the message should be capped well under
        // the full 500-char input.
        assert!(err.to_string().len() < 300);
    }

    #[test]
    fn invalid_json_inside_braces_is_an_error() {
        // Balanced braces, but not valid JSON inside — e.g. an unquoted key.
        let err = extract_summary_json("{summary: not valid json}").unwrap_err();
        assert!(err.to_string().contains("failed to parse JSON"));
    }

    // --- e2e: real model, real generation (manual only) ----------------------
    //
    // Everything below is Task 1's model-support proof, not the module's
    // eventual pure/tested core (there isn't one yet — see the module docs).
    // It exercises llama-cpp-2's raw API directly: load a GGUF, apply the
    // model's own chat template, decode the prompt, then greedily sample a
    // few tokens. `LlmEngine` itself isn't involved because it doesn't do
    // anything yet.

    use std::num::NonZeroU32;
    use std::path::PathBuf;
    use std::time::Instant;

    use llama_cpp_2::context::params::LlamaContextParams;
    use llama_cpp_2::llama_backend::LlamaBackend;
    use llama_cpp_2::llama_batch::LlamaBatch;
    use llama_cpp_2::model::params::LlamaModelParams;
    use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaModel};
    use llama_cpp_2::sampling::LlamaSampler;

    /// Requires the real `qwen3.5-4b` GGUF to already be installed (fetched
    /// by `download::real_download_of_qwen3_5_4b_verifies_checksum_and_marks_installed`)
    /// at the real app-data models directory. Run manually:
    ///
    /// ```sh
    /// cargo test --manifest-path src-tauri/Cargo.toml \
    ///     real_llm_loads_and_generates -- --ignored --nocapture
    /// ```
    ///
    /// This is Task 1's model-support risk check (see the plan's
    /// "Model-support risk" note): if `LlamaModel::load_from_file` rejects
    /// the Qwen3.5 GGUF architecture, that's the vendored llama.cpp inside
    /// the pinned `llama-cpp-2` version being too old — the assertion
    /// message below is written to surface that clearly rather than as a
    /// generic panic.
    #[test]
    #[ignore]
    fn real_llm_loads_and_generates() {
        let home = std::env::var("HOME").expect("HOME must be set");
        let model_path = PathBuf::from(&home).join(
            "Library/Application Support/dev.minute.app/models/llm/Qwen3.5-4B-Q4_K_M.gguf",
        );
        assert!(
            model_path.exists(),
            "expected qwen3.5-4b model at {model_path:?} (run \
             real_download_of_qwen3_5_4b_verifies_checksum_and_marks_installed in \
             download.rs first)"
        );

        let backend = LlamaBackend::init().expect("failed to init llama backend");
        eprintln!(
            "backend built with GPU offload support: {}",
            backend.supports_gpu_offload()
        );

        // Offload every layer we can to Metal — llama.cpp clamps this to the
        // model's actual layer count, so an oversized value is the normal
        // "offload everything" idiom rather than something needing the
        // exact layer count up front.
        let model_params = LlamaModelParams::default().with_n_gpu_layers(1_000_000);

        let load_start = Instant::now();
        let model = LlamaModel::load_from_file(&backend, &model_path, &model_params)
            .expect(
                "failed to load Qwen3.5-4B GGUF — if this rejects the model architecture, the \
                 vendored llama.cpp inside this llama-cpp-2 version is too old for Qwen3.5; see \
                 the plan's model-support risk contingency before swapping anything",
            );
        let load_elapsed = load_start.elapsed();
        eprintln!("model load took {load_elapsed:?}");

        let ctx_params = LlamaContextParams::default().with_n_ctx(NonZeroU32::new(4096));
        let mut ctx = model
            .new_context(&backend, ctx_params)
            .expect("failed to create llama context");

        let tmpl = model
            .chat_template(None)
            .expect("model has no baked-in chat template");
        let messages = vec![LlamaChatMessage::new(
            "user".to_string(),
            "Say OK and nothing else.".to_string(),
        )
        .expect("chat message construction should not fail on plain ASCII")];
        let prompt = model
            .apply_chat_template(&tmpl, &messages, true)
            .expect("chat template application failed");
        eprintln!("prompt: {prompt:?}");

        let prompt_tokens = model
            .str_to_token(&prompt, AddBos::Always)
            .expect("tokenization failed");
        assert!(!prompt_tokens.is_empty(), "tokenized prompt was empty");

        let mut batch = LlamaBatch::new(prompt_tokens.len().max(512), 1);
        let last_index = prompt_tokens.len() - 1;
        for (i, token) in prompt_tokens.iter().enumerate() {
            batch
                .add(*token, i as i32, &[0], i == last_index)
                .expect("failed to add prompt token to batch");
        }
        ctx.decode(&mut batch).expect("prompt decode failed");

        let mut sampler = LlamaSampler::chain_simple([LlamaSampler::greedy()]);
        let mut output_bytes: Vec<u8> = Vec::new();
        let max_new_tokens = 16;
        let mut n_cur = batch.n_tokens();

        let gen_start = Instant::now();
        let mut generated = 0usize;
        loop {
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            sampler.accept(token);
            if model.is_eog_token(token) {
                break;
            }

            let piece = model
                .token_to_piece_bytes(token, 64, false, None)
                .expect("failed to decode generated token to bytes");
            output_bytes.extend_from_slice(&piece);

            generated += 1;
            if generated >= max_new_tokens {
                break;
            }

            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .expect("failed to add generated token to batch");
            n_cur += 1;
            ctx.decode(&mut batch).expect("generation decode failed");
        }
        let gen_elapsed = gen_start.elapsed();
        let tokens_per_sec = generated as f64 / gen_elapsed.as_secs_f64();

        let output = String::from_utf8_lossy(&output_bytes).to_string();
        eprintln!(
            "generated {generated} tokens in {gen_elapsed:?} ({tokens_per_sec:.2} tok/s)"
        );
        eprintln!("output: {output:?}");

        assert!(!output.trim().is_empty(), "generated output was empty");
    }
}
