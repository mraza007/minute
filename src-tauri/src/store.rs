//! Folder-per-note persistence: note metadata, transcripts, and library scanning.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::{Duration, OffsetDateTime, UtcOffset};

use crate::error::{MinuteError, Result};
use crate::llm::SummaryDoc;

/// Lifecycle status of a note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteStatus {
    Recording,
    Transcribed,
    Ready,
}

/// A user-authored reference point in a recording, persisted in meta.json
/// so it is available both while recording and in the finalized note.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMarker {
    pub seconds: f64,
    pub label: String,
}

/// Metadata for a single note, stored as `notes/<id>/meta.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteMeta {
    pub id: String,
    pub title: String,
    pub created_at: String,
    pub duration_sec: f64,
    pub model: String,
    pub status: NoteStatus,
    pub speakers: u32,
    /// Persisted when capture or WAV finalization was not clean. Older
    /// libraries load this as absent and older builds ignore the new field.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub capture_warning: Option<String>,
    /// Set `true` once the 30-day audio sweep (see [`sweep_candidates`]/
    /// [`Store::run_audio_sweep`]) has deleted this note's `audio.wav`.
    /// `#[serde(default)]` so `meta.json` files written before this field
    /// existed still parse — they simply default to `false` ("audio has not
    /// been swept"), which is the correct interpretation: a pre-Task-3 note
    /// still has its audio.wav sitting on disk untouched.
    #[serde(default)]
    pub audio_deleted: bool,
    /// Set `true` once the compression sweep (issue #16 — see
    /// [`compress_candidates`]/[`Store::run_compression_sweep`]) has
    /// converted this note's `audio.wav` to `audio.m4a` and removed the
    /// WAV. `#[serde(default)]` so `meta.json` files written before this
    /// field existed still parse — they default to `false` ("audio has not
    /// been compressed"), which is correct: a pre-issue-#16 note still has
    /// its original `audio.wav` (or has had it deleted by the unrelated
    /// 30-day sweep, tracked separately by `audio_deleted`) untouched by
    /// compression.
    #[serde(default)]
    pub audio_compressed: bool,
    /// Which audio source(s) fed this note's recording — `["mic"]` (the
    /// overwhelming common case) or `["mic", "system"]` once Stage 5 Task
    /// 5's two-source pipeline actually mixed in system audio. Written once,
    /// at `stop_recording` finalize time (see `audio::stop_recording`'s
    /// `set_note_sources` call) — never mutated afterward, since a note's
    /// audio source can't change after the fact. `#[serde(default =
    /// "default_sources")]` so a `meta.json` written before this field
    /// existed still parses — it defaults to `["mic"]`, the correct
    /// interpretation: every pre-Stage-5 recording was mic-only by
    /// construction (system audio didn't exist as a capture path yet).
    #[serde(default = "default_sources")]
    pub sources: Vec<String>,
    /// User-controlled library priority. Defaults off for existing notes.
    #[serde(default)]
    pub pinned: bool,
    /// Timestamped reference points created during a recording.
    #[serde(default)]
    pub markers: Vec<NoteMarker>,
    /// User-confirmed mapping from this note's raw diarization label to its
    /// corrected display name. Scoped to one note: "Speaker 1" is stable
    /// within a diarization session but does not identify a person across
    /// unrelated recordings.
    #[serde(default)]
    pub speaker_aliases: HashMap<String, String>,
    /// Issue #22: unconfirmed name suggestions from voice-profile
    /// matching, keyed by the transcript's current "Speaker N" label.
    /// Written whole by each diarization pass (see `diar::run_diarize`),
    /// removed per label when the user confirms (which is just a rename)
    /// or dismisses. Skipped when empty so pre-#22 `meta.json` files
    /// round-trip byte-identical.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub speaker_suggestions: HashMap<String, SpeakerSuggestion>,
    /// Issue #32: names the diarization pass applied to the transcript on
    /// its own (match cleared `profiles::AUTO_APPLY_THRESHOLD`), keyed by
    /// the raw label they replaced. Rendered as an "auto-renamed — Undo"
    /// notice; any rename of the applied name (Undo included) removes the
    /// entry. Written whole by each pass, like `speaker_suggestions`.
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub speaker_auto_applied: HashMap<String, SpeakerSuggestion>,
}

/// One voice-profile match (issue #22): "this diarized voice sounds like
/// `name`". `similarity` is the cosine score that cleared
/// `profiles::SUGGEST_THRESHOLD` — surfaced to the UI so a borderline
/// match can be presented more tentatively than a near-certain one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerSuggestion {
    pub name: String,
    pub similarity: f32,
}

/// Default for [`NoteMeta::sources`] — see that field's own docs for why
/// `["mic"]` (not an empty vec) is the correct default for both a freshly
/// created note and a pre-Stage-5 `meta.json` with no `sources` key at all.
fn default_sources() -> Vec<String> {
    vec!["mic".to_string()]
}

/// One transcript segment, as stored in `transcript.json`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredSegment {
    pub speaker: String,
    pub start: f64,
    pub end: f64,
    pub text: String,
}

/// A note's full transcript, stored as `notes/<id>/transcript.json`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub segments: Vec<StoredSegment>,
}

/// Exact information required to reverse one speaker merge without
/// accidentally renaming turns that already belonged to the destination
/// speaker before the merge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerMergeUndo {
    pub from: String,
    pub into: String,
    pub segment_indices: Vec<usize>,
    pub checksum: String,
}

/// Result of merging one persisted speaker into another.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerMergeResult {
    pub transcript: Transcript,
    pub meta: NoteMeta,
    pub undo: SpeakerMergeUndo,
}

/// Result of reversing a speaker merge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpeakerMergeUndoResult {
    pub transcript: Transcript,
    pub meta: NoteMeta,
}

/// Which field of a note a [`SearchHit`] matched against — a title
/// (`meta.json`'s `title`) or a transcript segment's text.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SearchHitKind {
    Title,
    Transcript,
}

/// One hit from [`Store::search_notes`], `#[serde(rename_all =
/// "camelCase")]`.
///
/// `snippet` is a window of up to [`SEARCH_SNIPPET_RADIUS`] chars either
/// side of the first case-insensitive match of the query within the matched
/// text (the title itself for a `kind: Title` hit, a transcript segment's
/// text for `kind: Transcript`) — see [`find_snippet`] for the char-boundary
/// -safe windowing.
///
/// Deliberately carries no match-offset field (no `matchStart`/`matchLen`).
/// Highlighting the matched substring is left entirely to the frontend,
/// which re-finds it in `snippet` with a plain case-insensitive `indexOf`
/// against the same query it just sent — see `src/state/adapters.ts`'s
/// `splitHighlight`. This sidesteps a real cross-language footgun: a Rust
/// `char_indices` offset, a raw UTF-8 byte offset, and a JavaScript UTF-16
/// code-unit offset are three different index spaces, and shipping any one
/// of them over the wire would require the frontend to already know (and
/// never get wrong) which one it was looking at. Recomputing the match
/// position client-side against a string it already has removes that whole
/// class of bug for a negligible amount of extra work — a short substring
/// search over an already-short snippet.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub note_id: String,
    pub title: String,
    pub snippet: String,
    /// The matched transcript segment's start time (seconds) — what a
    /// frontend click seeks playback to. `None` for a `kind: Title` hit (a
    /// title has no timestamp to seek to).
    pub segment_start: Option<f64>,
    pub kind: SearchHitKind,
}

/// Disk usage breakdown for the storage stats panel.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub models_bytes: u64,
    pub audio_bytes: u64,
    pub notes_bytes: u64,
}

/// Exact token for restoring a note moved into Minute's private recovery
/// area. The checksum prevents a frontend from changing either path segment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeletedNoteUndo {
    pub id: String,
    pub title: String,
    pub trash_name: String,
    pub checksum: String,
}

/// Per-note disk usage for the note inspector.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteStorageStats {
    pub total_bytes: u64,
    pub audio_bytes: u64,
    pub document_bytes: u64,
}

/// Privacy-safe support snapshot. It intentionally contains aggregate
/// counts only: no titles, ids, transcript text, filenames, or full paths.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticsSnapshot {
    pub generated_at: String,
    pub app_version: String,
    pub os: String,
    pub architecture: String,
    pub note_count: usize,
    pub recording_notes: usize,
    pub transcribed_notes: usize,
    pub ready_notes: usize,
    pub notes_with_system_audio: usize,
    pub notes_with_audio_removed: usize,
    /// Issue #16: notes whose `audio.wav` has been compressed to `audio.m4a`
    /// by the compression sweep — see [`compress_candidates`]/
    /// [`Store::run_compression_sweep`].
    pub notes_with_audio_compressed: usize,
    pub storage: StorageStats,
    pub privacy: String,
}

const META_FILE: &str = "meta.json";
const META_TMP_FILE: &str = "meta.json.tmp";
const TRANSCRIPT_FILE: &str = "transcript.json";
const TRANSCRIPT_TMP_FILE: &str = "transcript.json.tmp";
const AUDIO_FILE: &str = "audio.wav";
/// Issue #16: the lossy AAC-in-.m4a a note's `audio.wav` gets compressed to
/// by [`Store::run_compression_sweep`] (via macOS's `afconvert`), once it
/// exists this fully replaces `AUDIO_FILE` for that note — see
/// [`existing_audio_file`], which is what every audio-file-discovery
/// call site (playback resolution, reveal-in-Finder, deletion, storage
/// stats) actually goes through instead of hardcoding `AUDIO_FILE`.
const AUDIO_M4A_FILE: &str = "audio.m4a";
/// The temp name [`Store::run_compression_sweep`] writes `afconvert`'s
/// output to before renaming it onto [`AUDIO_M4A_FILE`] — same tmp-then-
/// rename shape as every other atomic write in this module (`META_TMP_FILE`
/// etc.), so a process killed mid-encode never leaves a half-written
/// `audio.m4a` that playback could pick up.
const AUDIO_M4A_TMP_FILE: &str = "audio.m4a.tmp";
const SUMMARY_FILE: &str = "summary.json";
const SUMMARY_TMP_FILE: &str = "summary.json.tmp";

/// Issue #22: per-note voice embeddings, one centroid per final "Speaker N"
/// label, written by the diarization pass. A speaker rename reads this to
/// turn "Speaker 2 is Sarah" into a voice profile without re-running the
/// embedding model.
const SPEAKERS_FILE: &str = "speakers.json";
const SPEAKERS_TMP_FILE: &str = "speakers.json.tmp";
const NOTE_MD_FILE: &str = "note.md";
const NOTE_MD_TMP_FILE: &str = "note.md.tmp";
const RECOVERY_DIR: &str = ".minute-trash";

/// The title every note is created with, before the user (or
/// `llm::rename_target` — issue #12) gives it a real one.
///
/// Lives here rather than at its `audio::start_recording` call site because
/// two unrelated modules now have to agree on the exact string: that call
/// site writes it, and `llm::rename_target` tests for it to decide whether a
/// note is still unnamed. Two independent literals that must stay
/// byte-identical is precisely the shape that drifts.
///
/// `Sidebar.tsx` compares against its own copy of this string (to render a
/// note glyph instead of a column of identical "NR" monograms). That one is
/// deliberately left independent — a TS/Rust constant pair can't be shared
/// without generating one from the other, which is far more machinery than a
/// default title is worth.
pub const DEFAULT_NOTE_TITLE: &str = "New recording";
const EXPORTS_DIR: &str = "exports";
const DIAGNOSTICS_DIR: &str = "diagnostics";

/// [`Store::search_notes`]'s total hit cap across every note — a single
/// query result set never grows past this, regardless of library size.
const SEARCH_HIT_CAP: usize = 50;
/// [`Store::search_notes`]'s per-note cap on *transcript* hits (title hits
/// are uncapped per-note — a note has exactly one title) — keeps one
/// meeting whose transcript happens to repeat the query many times from
/// flooding the result list and crowding out every other note's hits.
const SEARCH_PER_NOTE_TRANSCRIPT_CAP: usize = 3;
/// [`find_snippet`]'s window radius, in chars, either side of the match.
const SEARCH_SNIPPET_RADIUS: usize = 40;

/// Folder-per-note store rooted at an app-data directory.
///
/// Layout:
/// ```text
/// root/
///   models/           (managed by catalog.rs)
///   notes/
///     <id>/
///       meta.json
///       transcript.json
///       audio.wav      (written by audio.rs)
/// ```
///
/// # Concurrency contract
///
/// A given app-data root must only ever be opened by **one** `Store`
/// instance for the lifetime of the app, shared behind a single
/// [`SharedStore`] handle. `create_note`'s collision check (does
/// `notes/<id>/` already exist?) and `append_segment`'s read-modify-write
/// are only atomic when every caller — Tauri commands, the recording
/// thread (Task 5), and the transcription worker thread (Task 6) — goes
/// through that one shared mutex. Constructing a second `Store` over the
/// same root from another thread reintroduces the races those methods are
/// meant to prevent. Note `run_audio_sweep` (Stage 4 Task 3) holds this
/// same mutex for its entire pass over the library, not just per-note —
/// commands issued while it's running queue briefly behind it at launch.
pub struct Store {
    root: PathBuf,
}

/// One row of the note list the frontend renders (issue #18): the persisted
/// [`NoteMeta`] plus `has_summary`, computed at list time from whether
/// `summary.json` exists on disk. Serialize-only — nothing reads this back;
/// `meta.json` stays the single persisted format. `#[serde(flatten)]` keeps
/// the wire shape a strict superset of the old `NoteMeta` payload, so the
/// frontend's existing `NoteMeta` consumers keep working unchanged.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NoteListEntry {
    #[serde(flatten)]
    pub meta: NoteMeta,
    pub has_summary: bool,
}

/// Shared handle to a [`Store`] — an `Arc<Mutex<Store>>`. Tauri commands
/// and the (future) recorder/transcription worker threads all hold clones
/// of the same `SharedStore` rather than each owning their own `Store`, so
/// mutating operations stay serialized through one mutex. See the
/// concurrency contract on [`Store`].
pub type SharedStore = Arc<Mutex<Store>>;

/// Locks a [`SharedStore`], recovering from lock poisoning instead of
/// propagating it. If one operation panics while holding the lock, every
/// later command must still be able to acquire it — a poisoned store
/// should degrade to "maybe-inconsistent state" rather than bricking the
/// whole app for the rest of the session.
pub fn lock_store(store: &SharedStore) -> MutexGuard<'_, Store> {
    store
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Recursively copies `src` into `dst` (created fresh) — the cross-volume
/// fallback for [`Store::move_library`] when a plain `fs::rename` fails.
fn copy_dir_recursive(src: &Path, dst: &Path) -> Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let target = dst.join(entry.file_name());
        if entry.file_type()?.is_dir() {
            copy_dir_recursive(&entry.path(), &target)?;
        } else {
            fs::copy(entry.path(), &target)?;
        }
    }
    Ok(())
}

/// Opens (creating if needed) a store rooted at `root` and hands it back
/// already wrapped as a [`SharedStore`] — the only way to obtain a `Store`
/// from outside this module. `Store::new` itself is private, so there is
/// no way for another module (audio.rs's recording thread, stt.rs's
/// transcription worker, ...) to construct a second, unsynchronized
/// `Store` over the same root; every caller is structurally forced through
/// this one shared handle. See the concurrency contract on [`Store`].
pub(crate) fn open_shared(root: PathBuf) -> SharedStore {
    let store = Store::new(root).expect("failed to initialize note store");
    Arc::new(Mutex::new(store))
}

impl Store {
    /// Opens (creating if needed) a store rooted at `root`. Ensures
    /// `root/notes/` exists.
    ///
    /// Private: the only supported way to obtain a `Store` outside this
    /// module is [`open_shared`], which immediately wraps it in a
    /// [`SharedStore`] — see the concurrency contract above.
    fn new(root: PathBuf) -> Result<Store> {
        let notes_dir = root.join("notes");
        fs::create_dir_all(&notes_dir)?;
        Ok(Store { root })
    }

    /// The app-data root this store is opened on — e.g. so a caller can
    /// clone it out from under a short-held lock before doing slow,
    /// lock-free disk I/O (see the free [`storage_stats`] function).
    pub(crate) fn root(&self) -> &Path {
        &self.root
    }

    /// Moves the whole notes library (`<root>/notes/`) into `new_root` and
    /// re-roots this store there, so every subsequent read/write goes to the
    /// new location. All-or-nothing from the caller's perspective:
    ///
    /// - `new_root` must be an existing directory (the folder picker
    ///   guarantees this in practice) that is not the current root, not
    ///   inside the current notes dir, and must not already contain a
    ///   `notes/` entry — refusing to merge into or clobber an existing
    ///   library beats guessing which of two libraries wins.
    /// - Same-volume moves are a single `fs::rename`. When that fails
    ///   (e.g. `EXDEV` for an external disk), falls back to copy + delete;
    ///   a failed copy removes the partial destination and leaves the store
    ///   on its original root, so a half-move can never take effect.
    ///
    /// Holding `&mut self` (via the store lock) is what makes this safe
    /// against concurrent note writes — nothing else can touch the library
    /// mid-move. The caller (the `move_library` command) is responsible for
    /// rejecting an active recording *before* taking the lock, since a
    /// recording holds note paths from the old root across lock releases.
    pub fn move_library(&mut self, new_root: PathBuf) -> Result<()> {
        if !new_root.is_dir() {
            return Err(MinuteError::Other(
                "the chosen folder does not exist or is not a directory".to_string(),
            ));
        }
        let old_notes = self.notes_root();
        // Canonicalize so "the same folder via a different path spelling"
        // (symlinks, `..`) can't sneak past the self-move guards.
        let canonical_new = new_root.canonicalize()?;
        let canonical_old_root = self.root.canonicalize()?;
        if canonical_new == canonical_old_root {
            return Err(MinuteError::Other(
                "the library already lives in that folder".to_string(),
            ));
        }
        if let Ok(canonical_old_notes) = old_notes.canonicalize() {
            if canonical_new.starts_with(&canonical_old_notes) {
                return Err(MinuteError::Other(
                    "the chosen folder is inside the current library".to_string(),
                ));
            }
        }
        let new_notes = canonical_new.join("notes");
        if new_notes.exists() {
            return Err(MinuteError::Other(
                "the chosen folder already contains a \"notes\" folder".to_string(),
            ));
        }

        if fs::rename(&old_notes, &new_notes).is_err() {
            // Different volume (or anything else rename can't do): copy the
            // tree, then delete the original only after the copy fully
            // succeeded. On failure, drop the partial copy — the original
            // library hasn't been touched.
            if let Err(copy_err) = copy_dir_recursive(&old_notes, &new_notes) {
                let _ = fs::remove_dir_all(&new_notes);
                return Err(copy_err);
            }
            fs::remove_dir_all(&old_notes)?;
        }

        self.root = canonical_new;
        Ok(())
    }

    fn notes_root(&self) -> PathBuf {
        self.root.join("notes")
    }

    /// Directory for a given note id — where audio.rs writes `audio.wav`.
    pub fn note_dir(&self, id: &str) -> PathBuf {
        self.notes_root().join(id)
    }

    /// The path `reveal_note` should hand to Finder for a given note id —
    /// see the free [`reveal_target`] function this delegates to.
    pub fn reveal_target(&self, id: &str) -> PathBuf {
        reveal_target(&self.note_dir(id))
    }

    fn meta_path(&self, id: &str) -> PathBuf {
        self.note_dir(id).join(META_FILE)
    }

    fn meta_tmp_path(&self, id: &str) -> PathBuf {
        self.note_dir(id).join(META_TMP_FILE)
    }

    fn transcript_path(&self, id: &str) -> PathBuf {
        self.note_dir(id).join(TRANSCRIPT_FILE)
    }

    fn transcript_tmp_path(&self, id: &str) -> PathBuf {
        self.note_dir(id).join(TRANSCRIPT_TMP_FILE)
    }

    fn summary_path(&self, id: &str) -> PathBuf {
        self.note_dir(id).join(SUMMARY_FILE)
    }

    fn summary_tmp_path(&self, id: &str) -> PathBuf {
        self.note_dir(id).join(SUMMARY_TMP_FILE)
    }

    fn speaker_embeddings_path(&self, id: &str) -> PathBuf {
        self.note_dir(id).join(SPEAKERS_FILE)
    }

    /// Where the voice-profile list lives (issue #22): at the library
    /// root, next to `notes/` — it moves with the library and dies with
    /// it.
    pub fn voice_profiles_path(&self) -> PathBuf {
        self.root.join(crate::profiles::PROFILES_FILE)
    }

    /// The stored voice embedding for the speaker currently displayed as
    /// `label` in this note (issue #22).
    ///
    /// `speakers.json` is keyed by the original "Speaker N" labels the
    /// diarization pass wrote, but the transcript may since have renamed
    /// them — possibly more than once ("Speaker 2" → "Sarah" → "Sara"),
    /// each rename appending one link to `meta.speaker_aliases`. So each
    /// original key's alias chain is followed to its current display name
    /// and compared against `label`. `Ok(None)` when the note has no
    /// embeddings or no chain ends at `label`.
    pub fn embedding_for_speaker(&self, id: &str, label: &str) -> Result<Option<Vec<f32>>> {
        let Some(embeddings) = self.read_speaker_embeddings(id)? else {
            return Ok(None);
        };
        if let Some(embedding) = embeddings.get(label) {
            return Ok(Some(embedding.clone()));
        }
        let meta = self.read_meta(id)?;
        for (original, embedding) in &embeddings {
            let mut current = original.as_str();
            // Bounded walk: a pathological alias file must not loop
            // forever, and no real chain is longer than its rename count.
            for _ in 0..meta.speaker_aliases.len() {
                match meta.speaker_aliases.get(current) {
                    Some(next) => current = next,
                    None => break,
                }
            }
            if current == label {
                return Ok(Some(embedding.clone()));
            }
        }
        Ok(None)
    }

    fn note_md_path(&self, id: &str) -> PathBuf {
        self.note_dir(id).join(NOTE_MD_FILE)
    }

    fn note_md_tmp_path(&self, id: &str) -> PathBuf {
        self.note_dir(id).join(NOTE_MD_TMP_FILE)
    }

    /// Atomically writes a note's `meta.json` (write to `.tmp`, then rename
    /// over the final path — same pattern as [`Store::write_transcript`]/
    /// [`Store::write_summary`]) so readers (including a concurrent
    /// `list_notes` walk) never observe a partially written file.
    fn write_meta(&self, meta: &NoteMeta) -> Result<()> {
        let json = serde_json::to_string_pretty(meta)
            .map_err(|e| MinuteError::Other(format!("failed to serialize meta.json: {e}")))?;
        let tmp_path = self.meta_tmp_path(&meta.id);
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, self.meta_path(&meta.id))?;
        Ok(())
    }

    fn read_meta(&self, id: &str) -> Result<NoteMeta> {
        let raw = fs::read_to_string(self.meta_path(id))?;
        serde_json::from_str(&raw)
            .map_err(|e| MinuteError::Other(format!("failed to parse meta.json for {id}: {e}")))
    }

    /// Formats `now` (UTC) as a note id: `YYYYMMDD-HHMMSS`.
    fn format_id(now: OffsetDateTime) -> String {
        format!(
            "{:04}{:02}{:02}-{:02}{:02}{:02}",
            now.year(),
            u8::from(now.month()),
            now.day(),
            now.hour(),
            now.minute(),
            now.second()
        )
    }

    /// Creates a new note with an injected timestamp (for testability).
    /// The id is derived from `now` (UTC, `YYYYMMDD-HHMMSS`); on collision
    /// with an existing note directory, `-2`, `-3`, ... is appended.
    ///
    /// `now` is normalized to UTC before use — callers may inject an
    /// `OffsetDateTime` in any offset (e.g. a local-time clock), and this
    /// guarantees the id and `createdAt` are always derived from the same
    /// UTC instant rather than producing mixed-offset metadata depending on
    /// what the caller happened to pass.
    pub fn create_note(&self, title: &str, model: &str, now: OffsetDateTime) -> Result<NoteMeta> {
        let now = now.to_offset(UtcOffset::UTC);
        let base_id = Self::format_id(now);
        let mut id = base_id.clone();
        let mut suffix = 2;
        while self.note_dir(&id).exists() {
            id = format!("{base_id}-{suffix}");
            suffix += 1;
        }

        fs::create_dir_all(self.note_dir(&id))?;

        let created_at = now
            .format(&time::format_description::well_known::Rfc3339)
            .map_err(|e| MinuteError::Other(format!("failed to format createdAt: {e}")))?;

        let meta = NoteMeta {
            id,
            title: title.to_string(),
            created_at,
            duration_sec: 0.0,
            model: model.to_string(),
            status: NoteStatus::Recording,
            speakers: 1,
            capture_warning: None,
            audio_deleted: false,
            audio_compressed: false,
            sources: default_sources(),
            pinned: false,
            markers: Vec::new(),
            speaker_aliases: HashMap::new(),
            speaker_suggestions: HashMap::new(),
            speaker_auto_applied: HashMap::new(),
        };
        self.write_meta(&meta)?;
        Ok(meta)
    }

    /// Convenience wrapper: creates a note using the current UTC time.
    pub fn create_note_now(&self, title: &str, model: &str) -> Result<NoteMeta> {
        self.create_note(title, model, OffsetDateTime::now_utc())
    }

    /// Marks a note as transcribed and records its final duration/speaker count.
    pub fn finalize_note(&self, id: &str, duration_sec: f64, speakers: u32) -> Result<NoteMeta> {
        let mut meta = self.read_meta(id)?;
        meta.status = NoteStatus::Transcribed;
        meta.duration_sec = duration_sec;
        meta.speakers = speakers;
        self.write_meta(&meta)?;
        Ok(meta)
    }

    /// Overwrites a note's `sources` field — called once, right after
    /// `finalize_note`, from `audio::stop_recording` (only when system audio
    /// was actually part of this recording's mix; `create_note`'s own
    /// `["mic"]` default is already correct otherwise, so that common case
    /// never needs this second write at all). See [`NoteMeta::sources`]'s
    /// docs for why this is a dedicated method rather than a parameter on
    /// `finalize_note` itself: `finalize_note`'s signature is depended on by
    /// dozens of existing call sites (this store's own tests, `llm.rs`,
    /// `stt.rs`) that have nothing to do with system audio — widening it
    /// would force every one of them to thread through a value they don't
    /// care about, whereas this is purely additive.
    pub fn set_note_sources(&self, id: &str, sources: Vec<String>) -> Result<NoteMeta> {
        let mut meta = self.read_meta(id)?;
        meta.sources = sources;
        self.write_meta(&meta)?;
        Ok(meta)
    }

    /// Marks a finalized note whose capture is usable but incomplete.
    pub fn set_capture_warning(&self, id: &str, warning: String) -> Result<NoteMeta> {
        let mut meta = self.read_meta(id)?;
        meta.capture_warning = Some(warning);
        self.write_meta(&meta)?;
        Ok(meta)
    }

    /// Atomically writes a note's full transcript (write to `.tmp`, then
    /// rename over the final path so readers never see a partial file).
    pub fn write_transcript(&self, id: &str, transcript: &Transcript) -> Result<()> {
        let json = serde_json::to_string_pretty(transcript)
            .map_err(|e| MinuteError::Other(format!("failed to serialize transcript.json: {e}")))?;
        let tmp_path = self.transcript_tmp_path(id);
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, self.transcript_path(id))?;
        Ok(())
    }

    /// Reads a note's transcript, or an empty one if none has been written yet.
    fn read_transcript(&self, id: &str) -> Result<Transcript> {
        let path = self.transcript_path(id);
        if !path.exists() {
            return Ok(Transcript::default());
        }
        let raw = fs::read_to_string(&path)?;
        serde_json::from_str(&raw).map_err(|e| {
            MinuteError::Other(format!("failed to parse transcript.json for {id}: {e}"))
        })
    }

    /// Appends one segment to a note's transcript (read-modify-write, atomic
    /// write via `write_transcript`). Fine at this scale — transcripts are
    /// small and appends are infrequent (chunk cadence, not per-word).
    pub fn append_segment(&self, id: &str, mut segment: StoredSegment) -> Result<()> {
        if let Ok(meta) = self.read_meta(id) {
            if let Some(alias) = meta.speaker_aliases.get(&segment.speaker) {
                segment.speaker = alias.clone();
            }
        }
        let mut transcript = self.read_transcript(id)?;
        transcript.segments.push(segment);
        self.write_transcript(id, &transcript)
    }

    /// Atomically writes a note's summary (write to `.tmp`, then rename over
    /// the final path — same pattern as [`Store::write_transcript`]).
    /// Writes a note's per-speaker voice embeddings (issue #22) — one
    /// centroid per "Speaker N" label, atomically via the same
    /// tmp-then-rename shape as [`Self::write_summary`]. Overwrites any
    /// previous pass's file whole: a re-diarization renumbers speakers,
    /// so stale entries under old labels must not survive it.
    pub fn write_speaker_embeddings(
        &self,
        id: &str,
        embeddings: &BTreeMap<String, Vec<f32>>,
    ) -> Result<()> {
        let json = serde_json::to_string(embeddings)
            .map_err(|e| MinuteError::Other(format!("failed to serialize speakers.json: {e}")))?;
        let tmp_path = self.note_dir(id).join(SPEAKERS_TMP_FILE);
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, self.speaker_embeddings_path(id))?;
        Ok(())
    }

    /// Reads a note's per-speaker voice embeddings. `Ok(None)` when no
    /// `speakers.json` exists (a note diarized before issue #22, or never
    /// diarized) — not an error. A corrupt file degrades to `Ok(None)`
    /// (logged), mirroring [`Self::read_summary`]: losing a voice profile
    /// source must never break the note it sits next to.
    pub fn read_speaker_embeddings(&self, id: &str) -> Result<Option<BTreeMap<String, Vec<f32>>>> {
        let path = self.speaker_embeddings_path(id);
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(&path)?;
        match serde_json::from_str(&raw) {
            Ok(embeddings) => Ok(Some(embeddings)),
            Err(e) => {
                log::warn!("note {id}: unreadable speakers.json ({e}) — treating as absent");
                Ok(None)
            }
        }
    }

    pub fn write_summary(&self, id: &str, summary: &SummaryDoc) -> Result<()> {
        let json = serde_json::to_string_pretty(summary)
            .map_err(|e| MinuteError::Other(format!("failed to serialize summary.json: {e}")))?;
        let tmp_path = self.summary_tmp_path(id);
        fs::write(&tmp_path, json)?;
        fs::rename(&tmp_path, self.summary_path(id))?;
        Ok(())
    }

    /// Reads a note's summary. `Ok(None)` if no `summary.json` exists yet
    /// (a note that hasn't been summarized, or an LLM error left it absent)
    /// — not an error. A corrupt/unparseable file also degrades to
    /// `Ok(None)` (logged via `log::warn!`) rather than failing the whole
    /// `get_note` call, matching `list_notes`'s tolerance of corrupt
    /// `meta.json`.
    pub fn read_summary(&self, id: &str) -> Result<Option<SummaryDoc>> {
        let path = self.summary_path(id);
        if !path.exists() {
            return Ok(None);
        }
        let raw = fs::read_to_string(&path)?;
        match serde_json::from_str(&raw) {
            Ok(summary) => Ok(Some(summary)),
            Err(e) => {
                log::warn!("failed to parse summary.json for {id}: {e}");
                Ok(None)
            }
        }
    }

    /// Persists a freshly generated summary and marks the note `Ready`.
    ///
    /// Ordering is deliberate and load-bearing for crash-safety: the summary
    /// is written *first*, then `meta.json`'s status flips to `Ready`. If the
    /// process dies between the two writes, the note is left at status
    /// `Transcribed` with a valid `summary.json` already on disk — a safe
    /// state to resume from (re-running the summarizer just overwrites the
    /// existing summary and completes the status flip), rather than a
    /// `Ready` note whose summary might not actually exist.
    ///
    /// Also (re)renders `note.md` — see [`Store::write_note_md`] — so the
    /// on-disk markdown reflects the new summary immediately.
    ///
    /// Called from `llm::run_summarize`'s success path, on the summarize
    /// worker thread.
    pub fn write_summary_and_finalize(&self, id: &str, summary: &SummaryDoc) -> Result<NoteMeta> {
        self.write_summary(id, summary)?;
        let mut meta = self.read_meta(id)?;
        meta.status = NoteStatus::Ready;
        self.write_meta(&meta)?;
        self.write_note_md(id)?;
        Ok(meta)
    }

    /// Flips a single action item's `done` state (read-modify-write) and
    /// re-persists the whole summary. `Err` if the note has no summary yet,
    /// or if `index` is out of bounds for its `action_items`.
    pub fn toggle_action_item(&self, id: &str, index: usize, done: bool) -> Result<SummaryDoc> {
        let mut summary = self
            .read_summary(id)?
            .ok_or_else(|| MinuteError::Other(format!("note {id} has no summary yet")))?;
        let item_count = summary.action_items.len();
        let item = summary.action_items.get_mut(index).ok_or_else(|| {
            MinuteError::Other(format!(
                "action item index {index} out of bounds for note {id} ({item_count} item(s))"
            ))
        })?;
        item.done = done;
        self.write_summary(id, &summary)?;
        self.write_note_md(id)?;
        Ok(summary)
    }

    /// Renders (via [`render_note_md`]) and atomically writes `note.md` for
    /// a note from whatever's currently on disk — its `meta.json`,
    /// `transcript.json` (empty if absent), and `summary.json` (omitted if
    /// absent). Called after every write that changes what `note.md` should
    /// say: `write_summary_and_finalize`, `toggle_action_item`,
    /// `rename_note`, and `stop_recording`'s finalize path (audio.rs) —
    /// `note.md` should exist for every finalized note, summarized or not.
    pub fn write_note_md(&self, id: &str) -> Result<()> {
        let meta = self.read_meta(id)?;
        let transcript = self.read_transcript(id)?;
        let summary = self.read_summary(id)?;
        let markdown = render_note_md(&meta, summary.as_ref(), &transcript);

        let tmp_path = self.note_md_tmp_path(id);
        fs::write(&tmp_path, markdown)?;
        fs::rename(&tmp_path, self.note_md_path(id))?;
        Ok(())
    }

    /// Lists all notes, sorted by `createdAt` descending. Note directories
    /// with a missing or corrupt `meta.json` are logged and skipped rather
    /// than failing the whole scan.
    pub fn list_notes(&self) -> Result<Vec<NoteMeta>> {
        let notes_root = self.notes_root();
        let mut metas = Vec::new();

        let entries = match fs::read_dir(&notes_root) {
            Ok(entries) => entries,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(metas),
            Err(e) => return Err(e.into()),
        };

        for entry in entries {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let id = entry.file_name().to_string_lossy().to_string();
            match self.read_meta(&id) {
                Ok(meta) => metas.push(meta),
                Err(e) => {
                    log::warn!("skipping note {id}: unreadable meta.json ({e})");
                }
            }
        }

        metas.sort_by(|a, b| Self::created_at_cmp(&b.created_at, &a.created_at));
        Ok(metas)
    }

    /// [`Self::list_notes`] plus a `has_summary` flag per note (issue #18).
    ///
    /// The flag reports whether `summary.json` exists on disk — deliberately
    /// *not* derived from `meta.status`. Status and summary presence can
    /// disagree: notes from builds that predate summarization are `ready`
    /// with no summary, and a summarization that never completed (issue
    /// #21) leaves `transcribed` notes that the UI has already shown a
    /// summary for. The sidebar's "Summarized" / "Needs summary" filters
    /// need the truth on disk, not the pipeline's bookkeeping.
    pub fn list_notes_with_summary(&self) -> Result<Vec<NoteListEntry>> {
        Ok(self
            .list_notes()?
            .into_iter()
            .map(|meta| {
                let has_summary = self.summary_path(&meta.id).exists();
                NoteListEntry { meta, has_summary }
            })
            .collect())
    }

    /// Compares two `createdAt` RFC3339 strings chronologically (parses
    /// both, falls back to a plain string compare if either fails to
    /// parse). Plain lexicographic string comparison breaks for RFC3339
    /// timestamps whose fractional seconds are omitted at exactly 0 ns:
    /// `"...T10:15:30Z"` sorts *after* `"...T10:15:30.5Z"` as a string
    /// (`'.'` < `'Z'` in ASCII) even though the `.5` instant is later.
    fn created_at_cmp(a: &str, b: &str) -> std::cmp::Ordering {
        let rfc3339 = &time::format_description::well_known::Rfc3339;
        match (
            OffsetDateTime::parse(a, rfc3339),
            OffsetDateTime::parse(b, rfc3339),
        ) {
            (Ok(a_dt), Ok(b_dt)) => a_dt.cmp(&b_dt),
            _ => a.cmp(b),
        }
    }

    /// Fetches a note's metadata and transcript (transcript is empty if not
    /// yet written).
    pub fn get_note(&self, id: &str) -> Result<(NoteMeta, Transcript)> {
        let meta = self.read_meta(id)?;
        let transcript = self.read_transcript(id)?;
        Ok((meta, transcript))
    }

    /// Case-insensitive substring search over every note's title and
    /// transcript segment text — the backend for ⌘K search and the
    /// sidebar's filter input.
    ///
    /// An empty or whitespace-only `query` returns `Ok(vec![])` immediately,
    /// without walking a single note directory — a blank query has no
    /// meaningful matches, and skipping the scan entirely (rather than
    /// "matching" everything, or scanning and finding nothing) is what keeps
    /// a debounced-but-not-yet-typed-into search input cheap.
    ///
    /// Ordering: every title hit sorts before every transcript hit; within
    /// each of those two groups, hits are ordered by their note's `created`
    /// time descending — this falls out naturally from [`Store::list_notes`]
    /// already returning notes newest-first and this method visiting notes
    /// in that order, appending each note's (at most one) title hit and (at
    /// most [`SEARCH_PER_NOTE_TRANSCRIPT_CAP`]) transcript hits to two
    /// separate buffers that are only concatenated (title buffer first) at
    /// the very end.
    ///
    /// Caps: [`SEARCH_HIT_CAP`] hits total (applied last, after ranking —
    /// so title hits are never pushed out by transcript hits), at most
    /// [`SEARCH_PER_NOTE_TRANSCRIPT_CAP`] transcript hits per individual
    /// note (applied while scanning that note's transcript, before the
    /// total cap — see the field's docs for why).
    ///
    /// A note whose `transcript.json` is missing or fails to parse is
    /// tolerated exactly like [`Store::read_transcript`]/`get_note` already
    /// tolerate a missing file (an empty transcript, i.e. title-only
    /// matching for that note) — a corrupt file is additionally logged via
    /// `log::warn!` and likewise degrades to "no transcript hits for this
    /// note" rather than failing the whole search.
    ///
    /// Every note's transcript is read and scanned in full on every call —
    /// including notes whose *title* already matched — rather than skipping
    /// the transcript scan once a note has a title hit; a title match and a
    /// transcript match are independently meaningful results (a title hit
    /// tells you the note exists, a transcript hit tells you *where* in it),
    /// and skipping the latter would silently drop timestamped citations for
    /// exactly the notes most likely to be relevant. This makes `search_notes`
    /// an O(notes × transcript size) full scan per keystroke (debounced),
    /// no index — accepted at the local, single-user, few-hundred-notes
    /// scale this app runs at; revisit (an in-memory or on-disk index) if
    /// the note count or debounce cadence ever makes that cost visible.
    pub fn search_notes(&self, query: &str) -> Result<Vec<SearchHit>> {
        let trimmed = query.trim();
        if trimmed.is_empty() {
            return Ok(Vec::new());
        }
        let needle_lower = trimmed.to_lowercase();

        let notes = self.list_notes()?; // already newest-first, see the ordering docs above
        let mut title_hits = Vec::new();
        let mut transcript_hits = Vec::new();

        for meta in &notes {
            if let Some(snippet) = find_snippet(&meta.title, &needle_lower) {
                title_hits.push(SearchHit {
                    note_id: meta.id.clone(),
                    title: meta.title.clone(),
                    snippet,
                    segment_start: None,
                    kind: SearchHitKind::Title,
                });
            }

            let transcript = match self.read_transcript(&meta.id) {
                Ok(t) => t,
                Err(e) => {
                    log::warn!(
                        "search: skipping unreadable transcript for note {}: {e}",
                        meta.id
                    );
                    Transcript::default()
                }
            };
            let mut hits_for_this_note = 0;
            for seg in &transcript.segments {
                if hits_for_this_note >= SEARCH_PER_NOTE_TRANSCRIPT_CAP {
                    break;
                }
                if let Some(snippet) = find_snippet(&seg.text, &needle_lower) {
                    transcript_hits.push(SearchHit {
                        note_id: meta.id.clone(),
                        title: meta.title.clone(),
                        snippet,
                        segment_start: Some(seg.start),
                        kind: SearchHitKind::Transcript,
                    });
                    hits_for_this_note += 1;
                }
            }
        }

        let mut hits = title_hits;
        hits.extend(transcript_hits);
        hits.truncate(SEARCH_HIT_CAP);
        Ok(hits)
    }

    /// Renames a note's title, preserving its id and createdAt. Re-renders
    /// `note.md` (its `# {title}` header line) so the on-disk markdown
    /// doesn't go stale — see [`Store::write_note_md`].
    pub fn rename_note(&self, id: &str, title: &str) -> Result<NoteMeta> {
        let mut meta = self.read_meta(id)?;
        meta.title = title.to_string();
        self.write_meta(&meta)?;
        self.write_note_md(id)?;
        Ok(meta)
    }

    /// Pins or unpins a note in the local library.
    pub fn set_note_pinned(&self, id: &str, pinned: bool) -> Result<NoteMeta> {
        let mut meta = self.read_meta(id)?;
        meta.pinned = pinned;
        self.write_meta(&meta)?;
        Ok(meta)
    }

    /// Adds a timestamped marker and keeps markers ordered by time.
    pub fn add_note_marker(&self, id: &str, seconds: f64, label: &str) -> Result<NoteMeta> {
        let mut meta = self.read_meta(id)?;
        let label = label.trim();
        if label.is_empty() {
            return Err(MinuteError::Other(
                "marker label cannot be empty".to_string(),
            ));
        }
        meta.markers.push(NoteMarker {
            seconds: seconds.max(0.0),
            label: label.to_string(),
        });
        meta.markers.sort_by(|a, b| a.seconds.total_cmp(&b.seconds));
        self.write_meta(&meta)?;
        self.write_note_md(id)?;
        Ok(meta)
    }

    /// Renames an existing marker without changing its timestamp.
    pub fn update_note_marker(&self, id: &str, index: usize, label: &str) -> Result<NoteMeta> {
        let mut meta = self.read_meta(id)?;
        let label = label.trim();
        if label.is_empty() {
            return Err(MinuteError::Other(
                "marker label cannot be empty".to_string(),
            ));
        }
        let marker = meta
            .markers
            .get_mut(index)
            .ok_or_else(|| MinuteError::Other(format!("marker index out of bounds: {index}")))?;
        marker.label = label.to_string();
        self.write_meta(&meta)?;
        self.write_note_md(id)?;
        Ok(meta)
    }

    /// Deletes an existing marker by its persisted display order.
    pub fn delete_note_marker(&self, id: &str, index: usize) -> Result<NoteMeta> {
        let mut meta = self.read_meta(id)?;
        if index >= meta.markers.len() {
            return Err(MinuteError::Other(format!(
                "marker index out of bounds: {index}"
            )));
        }
        meta.markers.remove(index);
        self.write_meta(&meta)?;
        self.write_note_md(id)?;
        Ok(meta)
    }

    /// Issue #32: one diarization pass's whole outcome for speaker names.
    /// The `speaker_auto_applied`/`speaker_suggestions` maps are replaced
    /// outright (each pass owns them, so stale entries from an earlier
    /// pass — whose labels it may have renumbered — never survive; empty
    /// maps clear them; this subsumed the old issue-#22
    /// `set_speaker_suggestions`). Candidate aliases pass two guards
    /// before landing:
    ///
    /// - A label the *user* renamed (including correcting an earlier
    ///   auto-apply — that rename cleared its notice) is skipped: the
    ///   correction must survive every later re-run, not revert to the
    ///   profile name.
    /// - A name already displayed by a different label is demoted to a
    ///   suggestion: applying it blind would silently collapse two people
    ///   into one, which the manual rename path refuses ("use merge
    ///   speakers instead") — the automatic path must not bypass that.
    ///
    /// One meta write. Called by `diar::run_diarize` *before* its
    /// `update_segment_speakers` call, which is what makes the applied
    /// names land in the transcript — and therefore in the summary that
    /// `on_done` triggers.
    pub fn apply_speaker_names(
        &self,
        id: &str,
        aliases: &HashMap<String, String>,
        applied: &HashMap<String, SpeakerSuggestion>,
        suggestions: &HashMap<String, SpeakerSuggestion>,
    ) -> Result<NoteMeta> {
        let mut meta = self.read_meta(id)?;
        let mut suggestions = suggestions.clone();
        let mut kept_applied: HashMap<String, SpeakerSuggestion> = HashMap::new();
        for (label, name) in aliases {
            let user_owned = meta
                .speaker_aliases
                .get(label)
                .is_some_and(|current| current != name)
                && !meta.speaker_auto_applied.contains_key(label);
            if user_owned {
                continue;
            }
            let taken_elsewhere = meta
                .speaker_aliases
                .iter()
                .any(|(other, target)| other != label && target == name);
            if taken_elsewhere {
                if let Some(suggestion) = applied.get(label) {
                    suggestions.insert(label.clone(), suggestion.clone());
                }
                continue;
            }
            meta.speaker_aliases.insert(label.clone(), name.clone());
            if let Some(suggestion) = applied.get(label) {
                kept_applied.insert(label.clone(), suggestion.clone());
            }
        }
        meta.speaker_auto_applied = kept_applied;
        meta.speaker_suggestions = suggestions;
        self.write_meta(&meta)?;
        Ok(meta)
    }

    /// Drops one suggestion by label (issue #22) — the dismiss path.
    /// Dropping an absent label is a no-op: the state the user asked for
    /// ("stop suggesting this") already holds.
    pub fn clear_speaker_suggestion(&self, id: &str, label: &str) -> Result<NoteMeta> {
        let mut meta = self.read_meta(id)?;
        if meta.speaker_suggestions.remove(label).is_some() {
            self.write_meta(&meta)?;
        }
        Ok(meta)
    }

    /// Rewrites every matching transcript speaker label and refreshes note.md.
    pub fn rename_speaker(&self, id: &str, from: &str, to: &str) -> Result<Transcript> {
        let to = to.trim();
        if to.is_empty() {
            return Err(MinuteError::Other(
                "speaker name cannot be empty".to_string(),
            ));
        }
        let mut transcript = self.read_transcript(id)?;
        if from != to
            && transcript
                .segments
                .iter()
                .any(|segment| segment.speaker == to)
        {
            return Err(MinuteError::Other(
                "speaker name already exists; use merge speakers instead".to_string(),
            ));
        }
        let mut changed = false;
        for segment in &mut transcript.segments {
            if segment.speaker == from {
                segment.speaker = to.to_string();
                changed = true;
            }
        }
        if !changed {
            return Err(MinuteError::Other(format!("speaker not found: {from}")));
        }
        let mut meta = self.persist_speaker_edit(id, &transcript)?;
        // Issue #39: compact alias chains through the name that just
        // vanished. Two stale shapes used to survive here: (a) renaming
        // A -> B -> A left `A -> B` behind, silently resurrecting "B" on
        // the next diarization pass; (b) chained renames (Speaker 2 ->
        // Sarah -> Sara) left `Speaker 2 -> Sarah`, and
        // `update_segment_speakers`' single-hop lookup restored the
        // *intermediate* name on a re-run. Redirecting every entry that
        // points at `from` to point at `to` fixes both; an entry that
        // becomes `X -> X` is the revert case and simply disappears.
        for target in meta.speaker_aliases.values_mut() {
            if target == from {
                *target = to.to_string();
            }
        }
        meta.speaker_aliases.retain(|raw, target| raw != target);
        meta.speaker_aliases
            .insert(from.to_string(), to.to_string());
        // Issue #22: a rename settles this label's identity — whether it
        // confirmed the suggestion or overrode it with a different name,
        // the suggestion is answered either way.
        meta.speaker_suggestions.remove(from);
        // Issue #32: renaming an auto-applied name (Undo back to the raw
        // label, or correcting it to someone else) answers that notice the
        // same way.
        meta.speaker_auto_applied
            .retain(|_, applied| applied.name != from);
        self.write_meta(&meta)?;
        Ok(transcript)
    }

    /// Merges every turn attributed to `from` into an already-existing
    /// destination speaker and returns an exact, index-based undo token.
    pub fn merge_speakers(&self, id: &str, from: &str, into: &str) -> Result<SpeakerMergeResult> {
        let from = from.trim();
        let into = into.trim();
        if from.is_empty() || into.is_empty() {
            return Err(MinuteError::Other(
                "speaker names cannot be empty".to_string(),
            ));
        }
        if from == into {
            return Err(MinuteError::Other(
                "cannot merge a speaker into itself".to_string(),
            ));
        }

        let mut transcript = self.read_transcript(id)?;
        if !transcript
            .segments
            .iter()
            .any(|segment| segment.speaker == into)
        {
            return Err(MinuteError::Other(format!(
                "destination speaker not found: {into}"
            )));
        }
        let segment_indices = transcript
            .segments
            .iter()
            .enumerate()
            .filter_map(|(index, segment)| (segment.speaker == from).then_some(index))
            .collect::<Vec<_>>();
        if segment_indices.is_empty() {
            return Err(MinuteError::Other(format!("speaker not found: {from}")));
        }
        for index in &segment_indices {
            transcript.segments[*index].speaker = into.to_string();
        }
        let mut meta = self.persist_speaker_edit(id, &transcript)?;
        meta.speaker_aliases
            .insert(from.to_string(), into.to_string());
        // Issue #32: merging away an auto-applied name answers its notice
        // — without this, the "auto-renamed — Undo" chip would linger and
        // its Undo (a rename from a name that no longer exists) would
        // always fail.
        meta.speaker_auto_applied
            .retain(|_, applied| applied.name != from);
        self.write_meta(&meta)?;
        let checksum = speaker_merge_undo_checksum(id, from, into, &segment_indices, &transcript)?;
        Ok(SpeakerMergeResult {
            transcript,
            meta,
            undo: SpeakerMergeUndo {
                from: from.to_string(),
                into: into.to_string(),
                segment_indices,
                checksum,
            },
        })
    }

    /// Reverses exactly the turns changed by [`Store::merge_speakers`].
    /// The full token is validated before any mutation reaches disk.
    pub fn undo_speaker_merge(
        &self,
        id: &str,
        undo: &SpeakerMergeUndo,
    ) -> Result<SpeakerMergeUndoResult> {
        if undo.from.trim().is_empty() || undo.into.trim().is_empty() || undo.from == undo.into {
            return Err(MinuteError::Other(
                "invalid speaker merge undo token".to_string(),
            ));
        }
        if undo.segment_indices.is_empty() {
            return Err(MinuteError::Other(
                "speaker merge undo token has no turns".to_string(),
            ));
        }
        let unique_indices = undo.segment_indices.iter().copied().collect::<HashSet<_>>();
        if unique_indices.len() != undo.segment_indices.len() {
            return Err(MinuteError::Other(
                "speaker merge undo token contains duplicate turns".to_string(),
            ));
        }

        let mut transcript = self.read_transcript(id)?;
        let expected_checksum = speaker_merge_undo_checksum(
            id,
            &undo.from,
            &undo.into,
            &undo.segment_indices,
            &transcript,
        )?;
        if undo.checksum != expected_checksum {
            return Err(MinuteError::Other(
                "speaker merge undo token is stale or invalid".to_string(),
            ));
        }
        for index in &undo.segment_indices {
            let segment = transcript.segments.get(*index).ok_or_else(|| {
                MinuteError::Other(format!("speaker merge undo turn is missing: {index}"))
            })?;
            if segment.speaker != undo.into {
                return Err(MinuteError::Other(format!(
                    "speaker merge can no longer be undone at turn {index}"
                )));
            }
        }
        for index in &undo.segment_indices {
            transcript.segments[*index].speaker = undo.from.clone();
        }
        let mut meta = self.persist_speaker_edit(id, &transcript)?;
        if meta.speaker_aliases.get(&undo.from) == Some(&undo.into) {
            meta.speaker_aliases.remove(&undo.from);
            self.write_meta(&meta)?;
        }
        Ok(SpeakerMergeUndoResult { transcript, meta })
    }

    /// Persists a transcript speaker edit, keeps the list-level speaker
    /// count honest, and refreshes the generated markdown.
    /// Diarization's write path (`diar.rs`): replaces every segment's
    /// speaker label at once with `labels` (one per segment, in order),
    /// applying any user-confirmed `speaker_aliases` on the way in (a note
    /// whose "Speaker 1" was already renamed to "Alice" keeps saying
    /// "Alice" when a re-run assigns "Speaker 1" again — same alias
    /// treatment `append_segment` gives live segments). Persists via the
    /// same `persist_speaker_edit` the rename/merge UI uses, so
    /// `meta.speakers` and `note.md` stay in sync. Errors if `labels`'
    /// length doesn't match the transcript — a mismatch means the transcript
    /// changed under the diarization pass, and relabeling anyway would
    /// attribute turns to the wrong people.
    pub fn update_segment_speakers(&self, id: &str, labels: &[String]) -> Result<NoteMeta> {
        let mut transcript = self.read_transcript(id)?;
        if transcript.segments.len() != labels.len() {
            return Err(MinuteError::Other(format!(
                "speaker labels ({}) do not match transcript segments ({})",
                labels.len(),
                transcript.segments.len()
            )));
        }
        let aliases = self.read_meta(id)?.speaker_aliases;
        for (segment, label) in transcript.segments.iter_mut().zip(labels) {
            segment.speaker = aliases.get(label).unwrap_or(label).clone();
        }
        self.persist_speaker_edit(id, &transcript)
    }

    fn persist_speaker_edit(&self, id: &str, transcript: &Transcript) -> Result<NoteMeta> {
        self.write_transcript(id, transcript)?;
        let mut meta = self.read_meta(id)?;
        meta.speakers = transcript
            .segments
            .iter()
            .map(|segment| segment.speaker.as_str())
            .collect::<HashSet<_>>()
            .len() as u32;
        self.write_meta(&meta)?;
        self.write_note_md(id)?;
        Ok(meta)
    }

    /// Moves a note into Minute's private recovery area and returns the exact
    /// token needed to restore it. Nothing is permanently erased here.
    pub fn delete_note(&self, id: &str) -> Result<DeletedNoteUndo> {
        let meta = self.read_meta(id)?;
        let source = self.note_dir(id);
        let recovery_root = self.root.join(RECOVERY_DIR);
        fs::create_dir_all(&recovery_root)?;
        let stamp = OffsetDateTime::now_utc().unix_timestamp_nanos();
        let mut trash_name = format!("{id}-{stamp}");
        let mut suffix = 2;
        while recovery_root.join(&trash_name).exists() {
            trash_name = format!("{id}-{stamp}-{suffix}");
            suffix += 1;
        }
        fs::rename(&source, recovery_root.join(&trash_name))?;
        let checksum = deleted_note_undo_checksum(id, &trash_name);
        Ok(DeletedNoteUndo {
            id: id.to_string(),
            title: meta.title,
            trash_name,
            checksum,
        })
    }

    /// Restores one recoverable deletion. The destination must remain empty;
    /// a newly-created note can never be overwritten by undo.
    pub fn restore_note(&self, undo: &DeletedNoteUndo) -> Result<NoteMeta> {
        if undo.checksum != deleted_note_undo_checksum(&undo.id, &undo.trash_name) {
            return Err(MinuteError::Other(
                "invalid note recovery token".to_string(),
            ));
        }
        let source = self.root.join(RECOVERY_DIR).join(&undo.trash_name);
        let destination = self.note_dir(&undo.id);
        if !source.is_dir() {
            return Err(MinuteError::Other(
                "recoverable note is no longer available".to_string(),
            ));
        }
        if destination.exists() {
            return Err(MinuteError::Other(format!(
                "cannot restore note {} because that id already exists",
                undo.id
            )));
        }
        fs::rename(source, destination)?;
        self.read_meta(&undo.id)
    }

    /// Disk usage for one note. A concurrent delete is treated as an empty
    /// result rather than failing the entire inspector.
    pub fn note_storage_stats(&self, id: &str) -> Result<NoteStorageStats> {
        let (total_bytes, audio_bytes) = note_dir_stats(&self.note_dir(id))?;
        Ok(NoteStorageStats {
            total_bytes,
            audio_bytes,
            document_bytes: total_bytes.saturating_sub(audio_bytes),
        })
    }

    /// Removes only the original audio — whichever file is actually present
    /// (`audio.wav`, or `audio.m4a` if the compression sweep already
    /// converted it — see [`existing_audio_file`]) — while preserving the
    /// transcript, summary, metadata, and markdown.
    pub fn delete_note_audio(&self, id: &str) -> Result<NoteMeta> {
        let mut meta = self.read_meta(id)?;
        if let Some(audio_path) = existing_audio_file(&self.note_dir(id)) {
            if let Err(error) = fs::remove_file(&audio_path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    return Err(error.into());
                }
            }
        }
        meta.audio_deleted = true;
        self.write_meta(&meta)?;
        Ok(meta)
    }

    /// Exports the selected notes as ordinary Markdown files plus a small
    /// manifest in a timestamped folder and returns that folder path.
    pub fn export_notes(&self, ids: &[String]) -> Result<PathBuf> {
        if ids.is_empty() {
            return Err(MinuteError::Other(
                "select at least one note to export".to_string(),
            ));
        }
        let stamp = OffsetDateTime::now_utc().unix_timestamp();
        let export_dir = self
            .root
            .join(EXPORTS_DIR)
            .join(format!("minute-export-{stamp}"));
        fs::create_dir_all(&export_dir)?;
        let mut manifest = Vec::new();
        for (index, id) in ids.iter().enumerate() {
            let (meta, transcript) = self.get_note(id)?;
            let summary = self.read_summary(id)?;
            let markdown = render_note_md(&meta, summary.as_ref(), &transcript);
            let filename = format!("{:03}-{}.md", index + 1, safe_export_name(&meta.title));
            fs::write(export_dir.join(&filename), markdown)?;
            manifest.push(serde_json::json!({
                "title": meta.title,
                "createdAt": meta.created_at,
                "file": filename,
            }));
        }
        let manifest_json = serde_json::to_string_pretty(&serde_json::json!({
            "formatVersion": 1,
            "exportedAt": OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_else(|_| "unknown".to_string()),
            "notes": manifest,
        }))
        .map_err(|error| {
            MinuteError::Other(format!("failed to serialize export manifest: {error}"))
        })?;
        fs::write(export_dir.join("manifest.json"), manifest_json)?;
        Ok(export_dir)
    }

    /// Writes a privacy-safe diagnostics JSON file and returns its path.
    pub fn export_diagnostics(&self, app_version: &str) -> Result<PathBuf> {
        let notes = self.list_notes()?;
        let storage = storage_stats(&self.root)?;
        let snapshot = DiagnosticsSnapshot {
            generated_at: OffsetDateTime::now_utc()
                .format(&time::format_description::well_known::Rfc3339)
                .unwrap_or_else(|_| "unknown".to_string()),
            app_version: app_version.to_string(),
            os: std::env::consts::OS.to_string(),
            architecture: std::env::consts::ARCH.to_string(),
            note_count: notes.len(),
            recording_notes: notes.iter().filter(|note| note.status == NoteStatus::Recording).count(),
            transcribed_notes: notes
                .iter()
                .filter(|note| note.status == NoteStatus::Transcribed)
                .count(),
            ready_notes: notes.iter().filter(|note| note.status == NoteStatus::Ready).count(),
            notes_with_system_audio: notes
                .iter()
                .filter(|note| note.sources.iter().any(|source| source == "system"))
                .count(),
            notes_with_audio_removed: notes.iter().filter(|note| note.audio_deleted).count(),
            notes_with_audio_compressed: notes.iter().filter(|note| note.audio_compressed).count(),
            storage,
            privacy: "Aggregate operational metadata only. No note ids, titles, transcript text, filenames, or paths."
                .to_string(),
        };
        let dir = self.root.join(DIAGNOSTICS_DIR);
        fs::create_dir_all(&dir)?;
        let path = dir.join(format!(
            "minute-diagnostics-{}.json",
            OffsetDateTime::now_utc().unix_timestamp()
        ));
        let json = serde_json::to_string_pretty(&snapshot).map_err(|error| {
            MinuteError::Other(format!("failed to serialize diagnostics: {error}"))
        })?;
        fs::write(&path, json)?;
        Ok(path)
    }

    /// Runs the 30-day audio sweep: for every note [`sweep_candidates`]
    /// selects against `now`, deletes `audio.wav` (tolerating one that's
    /// already missing — not an error, same tolerance `delete_note` and
    /// friends give already-gone files) and persists `audioDeleted: true`
    /// via the normal atomic [`Store::write_meta`] path. Returns the number
    /// of notes actually swept.
    ///
    /// Whether to call this at all is entirely the caller's decision (gated
    /// on `Settings::deleteAudioAfter30d` — see `lib.rs`'s `setup`) — this
    /// method itself has no opinion on the setting. Deliberately tolerant
    /// per-note: a single note whose `audio.wav` can't be removed (a
    /// permissions error, say) or whose `meta.json` can't be re-persisted is
    /// logged and skipped, rather than aborting the rest of the sweep over
    /// one bad note.
    pub fn run_audio_sweep(&self, now: OffsetDateTime) -> Result<usize> {
        let notes = self.list_notes()?;
        let candidates = sweep_candidates(&notes, now);
        let mut swept = 0;
        for mut meta in notes {
            if !candidates.contains(&meta.id) {
                continue;
            }
            if let Some(audio_path) = existing_audio_file(&self.note_dir(&meta.id)) {
                if let Err(e) = fs::remove_file(&audio_path) {
                    if e.kind() != std::io::ErrorKind::NotFound {
                        log::warn!(
                            "audio sweep: failed to delete audio for note {}: {e}",
                            meta.id
                        );
                        continue;
                    }
                }
            }
            meta.audio_deleted = true;
            if let Err(e) = self.write_meta(&meta) {
                log::warn!(
                    "audio sweep: failed to persist audioDeleted for note {}: {e}",
                    meta.id
                );
                continue;
            }
            swept += 1;
        }
        Ok(swept)
    }

}

/// Runs the compression sweep (issue #16): for every note
/// [`compress_candidates`] selects against `now`/`days`, encodes
/// `audio.wav` to `audio.m4a` via `afconvert` and, once the output is
/// verified non-empty, removes the WAV and persists `audioCompressed:
/// true` via the normal atomic [`Store::write_meta`] path. Returns the
/// number of notes actually compressed.
///
/// Whether to call this at all — and what `days` is — is entirely the
/// caller's decision (`Settings::compressAudioAfterDays` — see `lib.rs`'s
/// `setup`); this function has no opinion on the setting.
///
/// A free function over [`SharedStore`] rather than a method on [`Store`]
/// — deliberately, so it can *drop* the store lock while `afconvert` runs
/// (issue #21). As a method it could only be called with the caller
/// holding the mutex for the entire sweep, which for a library with
/// gigabytes of eligible audio meant every store operation in the app —
/// including the summarize worker's opening `get_note` — blocked behind
/// minutes of encoding (or forever, if `afconvert` ever hung on one
/// file). The lock is now held only for the metadata snapshots/writes
/// around each encode, never during one.
///
/// Thin wrapper around [`run_compression_sweep_with_encoder`] that
/// supplies the real `afconvert` shell-out — see that function for the
/// actual sweep/bookkeeping logic and why the encoder is injected.
pub fn run_compression_sweep(store: &SharedStore, now: OffsetDateTime, days: u32) -> Result<usize> {
    run_compression_sweep_with_encoder(store, now, days, encode_with_afconvert)
}

/// The compression sweep's actual logic, with the encoder step taken as
/// a closure rather than calling `afconvert` directly — same seam shape
/// as `llm::generate_fitting_transcript`'s injected `generate` closure.
/// This machine's CI (or the developer's) can't rely on `afconvert`
/// being present, deterministic, or fast, so the unit tests exercise
/// this function with a fake encoder (see `tests::run_compression_sweep_*`)
/// while `run_compression_sweep` above is what production actually
/// calls, with [`encode_with_afconvert`] wired in.
///
/// Deliberately tolerant per-note, mirroring [`Store::run_audio_sweep`]:
/// a failed encode, an empty/missing output, a failed rename, or a
/// `meta.json` that can't be re-persisted is `log::warn!`'d and the
/// sweep moves on to the next note rather than aborting. On any of
/// those failures the original `audio.wav` is left untouched — a note's
/// only copy of its audio is never removed unless the compressed
/// replacement is confirmed good on disk first — and a stray tmp file
/// from the failed attempt is cleaned up.
///
/// Locking discipline (issue #21 — see [`run_compression_sweep`]'s docs):
/// the store mutex is taken briefly for the initial `list_notes` snapshot
/// and again per note to persist the flag, and is *never* held across
/// `encode` or the filesystem shuffle around it. Consequences the
/// per-note tolerance already covers: a note deleted mid-encode makes the
/// rename/re-read fail (warn, skip), and the flag write re-reads
/// `meta.json` rather than persisting the stale snapshot — a rename that
/// landed while the encoder ran must not be clobbered.
fn run_compression_sweep_with_encoder(
    store: &SharedStore,
    now: OffsetDateTime,
    days: u32,
    encode: impl Fn(&Path, &Path) -> bool,
) -> Result<usize> {
    let (notes, note_dirs): (Vec<NoteMeta>, Vec<PathBuf>) = {
        let guard = lock_store(store);
        let notes = guard.list_notes()?;
        let dirs = notes.iter().map(|meta| guard.note_dir(&meta.id)).collect();
        (notes, dirs)
    };
    let candidates = compress_candidates(&notes, now, days);
    let mut compressed = 0;
    for (meta, note_dir) in notes.iter().zip(note_dirs) {
        if !candidates.contains(&meta.id) {
            continue;
        }
        let wav_path = note_dir.join(AUDIO_FILE);
        let tmp_path = note_dir.join(AUDIO_M4A_TMP_FILE);
        let final_path = note_dir.join(AUDIO_M4A_FILE);

        // `compress_candidates` is meta-only (see its docs) and doesn't
        // check the filesystem, so a note whose WAV has somehow gone
        // missing without `audioDeleted` being set (a manual deletion
        // outside the app, say) still reaches here — skip it rather
        // than handing a nonexistent path to the encoder.
        if !wav_path.exists() {
            log::warn!(
                "compression sweep: audio.wav missing for note {} — skipping",
                meta.id
            );
            continue;
        }

        // Clean up a stray tmp file left by a previous crashed attempt —
        // `afconvert` refuses to write over an existing file.
        let _ = fs::remove_file(&tmp_path);

        if !encode(&wav_path, &tmp_path) {
            log::warn!(
                "compression sweep: afconvert failed for note {} — leaving audio.wav untouched",
                meta.id
            );
            let _ = fs::remove_file(&tmp_path);
            continue;
        }

        let output_is_non_empty = fs::metadata(&tmp_path)
            .map(|m| m.len() > 0)
            .unwrap_or(false);
        if !output_is_non_empty {
            log::warn!(
                "compression sweep: afconvert produced an empty or missing audio.m4a for note {} — leaving audio.wav untouched",
                meta.id
            );
            let _ = fs::remove_file(&tmp_path);
            continue;
        }

        if let Err(e) = fs::rename(&tmp_path, &final_path) {
            log::warn!(
                "compression sweep: failed to finalize audio.m4a for note {}: {e} — leaving audio.wav untouched",
                meta.id
            );
            let _ = fs::remove_file(&tmp_path);
            continue;
        }

        if let Err(e) = fs::remove_file(&wav_path) {
            log::warn!(
                "compression sweep: audio.m4a written but failed to remove audio.wav for note {}: {e}",
                meta.id
            );
            continue;
        }

        {
            let guard = lock_store(store);
            // Re-read rather than persisting the pre-encode snapshot: a
            // rename (or any other meta write) that landed while the
            // encoder ran must survive. A note deleted mid-encode fails
            // the read — warn and move on, same as every other per-note
            // failure.
            let mut fresh = match guard.read_meta(&meta.id) {
                Ok(fresh) => fresh,
                Err(e) => {
                    log::warn!(
                        "compression sweep: audio.m4a written but meta.json unreadable for note {}: {e}",
                        meta.id
                    );
                    continue;
                }
            };
            fresh.audio_compressed = true;
            if let Err(e) = guard.write_meta(&fresh) {
                log::warn!(
                    "compression sweep: failed to persist audioCompressed for note {}: {e}",
                    meta.id
                );
                continue;
            }
        }
        compressed += 1;
    }
    Ok(compressed)
}

/// The real `afconvert` shell-out [`Store::run_compression_sweep`] wires
/// into [`Store::run_compression_sweep_with_encoder`] as production's
/// encoder: 48 kbps mono AAC in an `.m4a` container — plenty for 16 kHz
/// speech, and macOS-built-in (this app is macOS-only, so shelling out here
/// avoids pulling in a Rust encoder crate). Returns whether the process
/// both launched and exited successfully; any failure to even start
/// `afconvert` (e.g. it's somehow missing from `$PATH`) is treated the same
/// as a nonzero exit — both are "this note's compression attempt failed",
/// handled identically by the caller.
fn encode_with_afconvert(wav_path: &Path, out_path: &Path) -> bool {
    match std::process::Command::new("afconvert")
        .args(["-f", "m4af", "-d", "aac", "-b", "48000"])
        .arg(wav_path)
        .arg(out_path)
        .status()
    {
        Ok(status) => status.success(),
        Err(e) => {
            log::warn!("compression sweep: failed to launch afconvert: {e}");
            false
        }
    }
}

fn deleted_note_undo_checksum(id: &str, trash_name: &str) -> String {
    let digest = Sha256::digest(format!("minute-note-recovery\0{id}\0{trash_name}").as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn safe_export_name(title: &str) -> String {
    let cleaned = title
        .chars()
        .map(|character| {
            if character.is_alphanumeric()
                || character == '-'
                || character == '_'
                || character == ' '
            {
                character
            } else {
                '-'
            }
        })
        .collect::<String>();
    let compact = cleaned.split_whitespace().collect::<Vec<_>>().join("-");
    let trimmed = compact.trim_matches('-');
    if trimmed.is_empty() {
        "untitled".to_string()
    } else {
        trimmed.chars().take(80).collect()
    }
}

fn speaker_merge_undo_checksum(
    id: &str,
    from: &str,
    into: &str,
    segment_indices: &[usize],
    transcript: &Transcript,
) -> Result<String> {
    let payload =
        serde_json::to_vec(&(id, from, into, segment_indices, transcript)).map_err(|error| {
            MinuteError::Other(format!("failed to fingerprint speaker merge: {error}"))
        })?;
    let digest = Sha256::digest(payload);
    Ok(digest.iter().map(|byte| format!("{byte:02x}")).collect())
}

/// Which notes the 30-day audio sweep should delete `audio.wav` for, given
/// the current instant `now` (injected rather than read internally, for
/// testability — same shape as [`Store::create_note`]'s `now` parameter). A
/// note is a candidate iff all three hold:
///
/// - its `createdAt` parses as RFC3339 and is *strictly* more than 30×24h
///   before `now`. The boundary is deliberately exclusive at exactly 30
///   days: a note doesn't lose its audio the instant it turns 30 days old,
///   only once it's unambiguously past that mark.
/// - its `status` is [`NoteStatus::Ready`] or [`NoteStatus::Transcribed`] —
///   never [`NoteStatus::Recording`], so an in-progress recording's audio is
///   never touched no matter how stale its `createdAt` looks (a note stuck
///   at `Recording` for 30+ days would be a bug elsewhere, not a green light
///   to delete its only copy of the audio).
/// - it isn't already `audioDeleted` — a previous sweep (or any other path
///   that ever sets the flag) makes a note permanently ineligible; there's
///   no "audio.wav reappeared" case to re-detect.
///
/// Whether the sweep should run *at all* is the caller's responsibility
/// (gated on `Settings::deleteAudioAfter30d`) — this function takes no
/// settings, just notes + now, so its selection rule is unit-testable in
/// isolation from that.
///
/// A note whose `createdAt` fails to parse is skipped (logged via
/// `log::warn!`) rather than panicking, or — worse — being swept just
/// because its age couldn't be determined: malformed metadata must never be
/// the reason real audio gets deleted.
pub fn sweep_candidates(notes: &[NoteMeta], now: OffsetDateTime) -> Vec<String> {
    let cutoff = now - Duration::days(30);
    let rfc3339 = &time::format_description::well_known::Rfc3339;
    notes
        .iter()
        .filter(|meta| {
            if meta.audio_deleted {
                return false;
            }
            if !matches!(meta.status, NoteStatus::Ready | NoteStatus::Transcribed) {
                return false;
            }
            match OffsetDateTime::parse(&meta.created_at, rfc3339) {
                Ok(created) => created < cutoff,
                Err(e) => {
                    log::warn!(
                        "audio sweep: skipping note {} — unparseable createdAt {:?} ({e})",
                        meta.id,
                        meta.created_at
                    );
                    false
                }
            }
        })
        .map(|meta| meta.id.clone())
        .collect()
}

/// Which notes the compression sweep (issue #16) should encode `audio.wav`
/// to `audio.m4a` for, given the current instant `now`, the configured
/// `days` (`Settings::compressAudioAfterDays`), and the notes' in-memory
/// metadata. A note is a candidate iff all four hold:
///
/// - its `createdAt` parses as RFC3339 and is *strictly* more than `days`×24h
///   before `now` — same exclusive-boundary rule as [`sweep_candidates`]'s
///   fixed 30-day window, just with a caller-supplied day count instead.
/// - its `status` is [`NoteStatus::Ready`] or [`NoteStatus::Transcribed`] —
///   never [`NoteStatus::Recording`]; an in-progress recording's audio is
///   never a compression target no matter how stale its `createdAt` looks.
/// - it isn't already `audioDeleted` — nothing to compress once the 30-day
///   sweep (or the user's own "delete audio" action) has already removed
///   the WAV.
/// - it isn't already `audioCompressed` — idempotent, same as
///   [`sweep_candidates`]'s `audioDeleted` check: once compressed, a note
///   never becomes a candidate again.
///
/// Deliberately doesn't check whether `audio.wav` actually exists on disk —
/// same reasoning as [`sweep_candidates`] staying meta-only: this function
/// takes only `notes` + `now` + `days`, no root path, so it's unit-testable
/// without touching the filesystem. [`Store::run_compression_sweep`]
/// performs that existence check itself (and skips tolerantly, like every
/// other per-note failure there, if the WAV has somehow gone missing
/// without `audioDeleted` being set).
///
/// A note whose `createdAt` fails to parse is skipped (logged via
/// `log::warn!`), same as [`sweep_candidates`] — malformed metadata must
/// never be the reason a note's only remaining audio copy gets touched.
pub fn compress_candidates(notes: &[NoteMeta], now: OffsetDateTime, days: u32) -> Vec<String> {
    let cutoff = now - Duration::days(i64::from(days));
    let rfc3339 = &time::format_description::well_known::Rfc3339;
    notes
        .iter()
        .filter(|meta| {
            if meta.audio_deleted || meta.audio_compressed {
                return false;
            }
            if !matches!(meta.status, NoteStatus::Ready | NoteStatus::Transcribed) {
                return false;
            }
            match OffsetDateTime::parse(&meta.created_at, rfc3339) {
                Ok(created) => created < cutoff,
                Err(e) => {
                    log::warn!(
                        "compression sweep: skipping note {} — unparseable createdAt {:?} ({e})",
                        meta.id,
                        meta.created_at
                    );
                    false
                }
            }
        })
        .map(|meta| meta.id.clone())
        .collect()
}

/// The note directory's audio file, whichever of the two possible names is
/// actually on disk — `audio.wav` if present, else `audio.m4a` (issue #16's
/// compression sweep replaces the former with the latter), else `None` if
/// neither exists. Checked in that order because a note is never expected to
/// carry both at once (`run_compression_sweep` only removes the WAV *after*
/// the M4A is verified non-empty), but WAV-first is still the correct tie-
/// break if it somehow ever did — the WAV is the higher-fidelity original.
/// Pure — no process spawn — the single seam every audio-file-discovery call
/// site in this module (playback resolution, reveal-in-Finder, deletion,
/// storage stats) goes through instead of hardcoding a filename, so adding
/// the M4A case only had to happen once, here.
fn existing_audio_file(note_dir: &Path) -> Option<PathBuf> {
    let wav = note_dir.join(AUDIO_FILE);
    if wav.exists() {
        return Some(wav);
    }
    let m4a = note_dir.join(AUDIO_M4A_FILE);
    if m4a.exists() {
        return Some(m4a);
    }
    None
}

/// The path `reveal_note` should hand to Finder for a given note directory:
/// the note's audio file ([`existing_audio_file`] — `audio.wav` or, once
/// compressed, `audio.m4a`) if one exists, else the note directory itself
/// (e.g. a note whose audio was never captured, or has since been removed).
/// Pure — no process spawn, no existence requirement on `note_dir` itself —
/// so the selection rule is unit-testable without touching `open`.
pub fn reveal_target(note_dir: &Path) -> PathBuf {
    existing_audio_file(note_dir).unwrap_or_else(|| note_dir.to_path_buf())
}

/// The absolute path to a note's audio file, if it's actually present on
/// disk under either name ([`existing_audio_file`]) — `None` for a note
/// whose audio was never captured, or has since been deleted. Pure — a
/// plain existence check, no process spawn — mirroring [`reveal_target`]'s
/// shape. Doesn't know about `audioDeleted` at all (it's a raw filesystem
/// check, nothing more) — [`reveal_target`] wants exactly that (Finder
/// should still find a stray audio file if one somehow exists). The
/// `get_note` command instead goes through [`resolved_audio_path`], which
/// layers the `audioDeleted` invariant on top of this.
pub fn audio_path(note_dir: &Path) -> Option<PathBuf> {
    existing_audio_file(note_dir)
}

/// The `audioPath` the `get_note` command should report for a note: `None`
/// whenever `meta.audioDeleted` is `true` — even if a stray `audio.wav`
/// somehow still exists on disk (a race with an in-flight sweep, a manual
/// restore, ...) — otherwise falls through to the plain [`audio_path`]
/// existence check. `audioDeleted` is the single source of truth once it's
/// `true`; a leftover file must never resurrect playback for a note the
/// sweep has already marked swept. Pure (same shape as [`audio_path`]/
/// [`reveal_target`]) so this invariant is unit-testable without going
/// through the `#[tauri::command]` boundary.
pub fn resolved_audio_path(meta: &NoteMeta, note_dir: &Path) -> Option<PathBuf> {
    if meta.audio_deleted {
        return None;
    }
    audio_path(note_dir)
}

/// Case-insensitive substring search for `needle_lower` (already
/// lowercased) within `haystack`, returning a [`SEARCH_SNIPPET_RADIUS`]-char
/// window around the first match — or `None` if there's no match. A `…` is
/// prepended when the window doesn't reach the start of `haystack`, and/or
/// appended when it doesn't reach the end — an honest signal to the
/// frontend (and the person reading it) that the snippet is a truncated
/// excerpt, not the whole title/segment.
///
/// Entirely char-based (never byte-indexed), so it can never panic on
/// multi-byte UTF-8 (emoji, CJK, accented Latin, ...) even when the ±radius
/// window would otherwise land mid-character: because every index here is a
/// position in a `Vec<char>`, not a byte offset, there is no byte boundary
/// to straddle in the first place.
///
/// The returned snippet is *always* sliced from the original (not
/// lowercased) `haystack` — never a lowercased copy of it, under any
/// circumstance — so casing/diacritics in what's actually displayed are
/// always exactly what was typed. This matters because a char's lowercase
/// mapping isn't always 1:1: Turkish `İ` (U+0130) lowercases to *two* chars
/// (`i` + a combining dot above), so a naive "lowercase the whole haystack,
/// slice the same char-index window out of both copies" approach silently
/// misaligns (or has to fall back to the lowercased copy) the moment one of
/// those appears anywhere in the string, not just at the match itself.
///
/// Instead, `haystack` is lowercased char-by-char (`char::to_lowercase()` —
/// the same unconditional Unicode mapping `str::to_lowercase()` itself
/// applies internally), building `lowered_chars` alongside a parallel
/// `orig_index_of_lowered` that records, for every char *produced*, which
/// original char index it came from (a char whose mapping expands to N
/// chars simply appears N times, once per produced char — pointing at the
/// same original index each time). The match is found by plain char
/// comparison in that lowered sequence (`needle_lower` is already
/// lowercased, so no further case folding happens here), and only the
/// match's first/last lowered-char positions are ever mapped back through
/// `orig_index_of_lowered` — to a single original char span, which is what
/// actually gets windowed and sliced. The window and the slice never touch
/// `lowered_chars` again after that, so there's nothing left to misalign.
fn find_snippet(haystack: &str, needle_lower: &str) -> Option<String> {
    let needle_chars: Vec<char> = needle_lower.chars().collect();
    if needle_chars.is_empty() {
        return None;
    }

    let orig_chars: Vec<char> = haystack.chars().collect();
    let mut lowered_chars: Vec<char> = Vec::with_capacity(orig_chars.len());
    let mut orig_index_of_lowered: Vec<usize> = Vec::with_capacity(orig_chars.len());
    for (orig_idx, c) in orig_chars.iter().enumerate() {
        for lc in c.to_lowercase() {
            lowered_chars.push(lc);
            orig_index_of_lowered.push(orig_idx);
        }
    }

    if needle_chars.len() > lowered_chars.len() {
        return None;
    }

    let lowered_match_start = (0..=lowered_chars.len() - needle_chars.len())
        .find(|&start| lowered_chars[start..start + needle_chars.len()] == needle_chars[..])?;
    let lowered_match_end = lowered_match_start + needle_chars.len(); // exclusive, in lowered-char space

    // Map the matched lowered-char span back to a single original-char span
    // — the original char that produced the match's first lowered char,
    // through the original char that produced its last one (inclusive),
    // made exclusive again with `+ 1`.
    let orig_match_start = orig_index_of_lowered[lowered_match_start];
    let orig_match_end = orig_index_of_lowered[lowered_match_end - 1] + 1;

    let snippet_start = orig_match_start.saturating_sub(SEARCH_SNIPPET_RADIUS);
    let snippet_end = (orig_match_end + SEARCH_SNIPPET_RADIUS).min(orig_chars.len());

    let core: String = orig_chars[snippet_start..snippet_end].iter().collect();
    let mut snippet = String::with_capacity(core.len() + 6);
    if snippet_start > 0 {
        snippet.push('…');
    }
    snippet.push_str(&core);
    if snippet_end < orig_chars.len() {
        snippet.push('…');
    }
    Some(snippet)
}

/// Recursively sums file sizes under `path`. Missing paths count as 0.
///
/// Free function (not a `Store` method) — used by [`storage_stats`], which
/// deliberately doesn't take `&self`/a lock; see that function's docs.
fn dir_size(path: &Path) -> Result<u64> {
    if !path.exists() {
        return Ok(0);
    }
    let mut total = 0u64;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        if file_type.is_dir() {
            total += dir_size(&entry.path())?;
        } else {
            total += entry.metadata()?.len();
        }
    }
    Ok(total)
}

/// One pass over a single note's (flat) directory: total bytes on disk and
/// `audio.wav`'s share of that total. A single `fs::read_dir` walk stats
/// every entry once — earlier code stat'd `audio.wav` a second time via a
/// dedicated `fs::metadata` call on top of the walk `dir_size` already did
/// internally.
///
/// `storage_stats` runs this lock-free (see its docs), so it can race a
/// concurrent `delete_note` on the very directory it's about to walk. Every
/// "this vanished out from under us" case — the note directory itself, the
/// directory-listing iterator, or a single entry's metadata — is treated as
/// 0 bytes rather than failing the whole stats command; only genuinely
/// unexpected errors are logged and also degrade to 0 for that entry.
fn note_dir_stats(note_dir: &Path) -> Result<(u64, u64)> {
    let is_not_found = |e: &std::io::Error| e.kind() == std::io::ErrorKind::NotFound;

    let entries = match fs::read_dir(note_dir) {
        Ok(entries) => entries,
        Err(e) if is_not_found(&e) => return Ok((0, 0)),
        Err(e) => return Err(e.into()),
    };

    let mut total = 0u64;
    let mut audio = 0u64;
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) if is_not_found(&e) => continue,
            Err(e) => return Err(e.into()),
        };
        let len = match entry.metadata() {
            Ok(meta) => meta.len(),
            Err(e) if is_not_found(&e) => 0,
            Err(e) => {
                log::warn!("skipping {:?} in storage stats: {e}", entry.path());
                0
            }
        };
        total += len;
        if entry.file_name() == AUDIO_FILE || entry.file_name() == AUDIO_M4A_FILE {
            audio = len;
        }
    }
    Ok((total, audio))
}

/// Storage breakdown: `models_bytes` = everything under `root/models`;
/// `audio_bytes` = sum of every note's audio file (`audio.wav`, or
/// `audio.m4a` once the compression sweep has converted it — see
/// [`existing_audio_file`]); `notes_bytes` =
/// everything else under `root/notes` (meta/transcript json, excluding
/// audio).
///
/// A free function taking `root` directly (rather than a `Store` method
/// requiring `&self`) so callers can run this recursive disk walk without
/// holding the store's mutex: clone `root` out from under a brief
/// [`lock_store`] call, drop the lock, then call this. Keeps the mutex
/// uncontended for the (potentially large) filesystem walk instead of
/// blocking every other command — including the recording/transcription
/// worker threads — for its duration.
pub fn storage_stats(root: &Path) -> Result<StorageStats> {
    let models_bytes = dir_size(&root.join("models"))?;

    let mut audio_bytes = 0u64;
    let mut notes_bytes = 0u64;
    let notes_root = root.join("notes");
    if notes_root.exists() {
        for entry in fs::read_dir(&notes_root)? {
            let entry = entry?;
            if !entry.file_type()?.is_dir() {
                continue;
            }
            let (total, audio) = note_dir_stats(&entry.path())?;
            audio_bytes += audio;
            notes_bytes += total.saturating_sub(audio);
        }
    }

    Ok(StorageStats {
        models_bytes,
        audio_bytes,
        notes_bytes,
    })
}

/// Formats a segment's start time as `mm:ss` for `note.md`'s transcript
/// section — the same rounding rule as the frontend's `formatMmSs`
/// (`src/state/adapters.ts`) and `llm.rs`'s own copy for the summary prompt:
/// negative/NaN clamps to 0, whole seconds only. Duplicated rather than
/// shared with `llm::format_mm_ss` because the two render into different
/// surrounding punctuation (`(mm:ss)` here vs `[mm:ss]` there) and neither
/// module depends on the other — see that function's docs for the same
/// rationale spelled out the other way round.
fn format_mm_ss(total_seconds: f64) -> String {
    let whole_seconds = total_seconds.max(0.0).floor() as u64;
    let mm = whole_seconds / 60;
    let ss = whole_seconds % 60;
    format!("{mm:02}:{ss:02}")
}

/// Formats `created_at` (an RFC3339 string) as `Month D, YYYY` — matching
/// the frontend's `formatDateLabel`
/// (`new Date(createdAt).toLocaleDateString('en-US', { month: 'long', day:
/// 'numeric', year: 'numeric' })`). `time::Month`'s `Display` impl prints
/// the full English month name, which is exactly what `month: 'long'`
/// produces. Falls back to the raw string, unformatted, if it doesn't parse
/// as RFC3339 — deliberately tolerant rather than panicking, since this
/// feeds a rendered document rather than being load-bearing data.
fn format_date_label(created_at: &str) -> String {
    let rfc3339 = &time::format_description::well_known::Rfc3339;
    match OffsetDateTime::parse(created_at, rfc3339) {
        Ok(dt) => format!("{} {}, {}", dt.month(), dt.day(), dt.year()),
        Err(_) => created_at.to_string(),
    }
}

/// Renders the `## Transcript` section's body: `_No speech detected._` for
/// an empty transcript, else each segment as `**Speaker** (mm:ss)\ntext`,
/// blank-line-separated — byte-for-byte the same shape as the frontend's
/// `transcriptBody` in `src/state/noteToMarkdown.ts`.
fn transcript_body(segments: &[StoredSegment]) -> String {
    if segments.is_empty() {
        return "_No speech detected._".to_string();
    }
    segments
        .iter()
        .map(|seg| {
            format!(
                "**{}** ({})\n{}",
                seg.speaker,
                format_mm_ss(seg.start),
                seg.text
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n")
}

/// The single source of truth for a note's markdown rendering — both
/// `note.md` on disk (via [`Store::write_note_md`]) and the `get_note`
/// command's `markdown` field (rendered fresh on every read) go through
/// this. Ports the frontend's `noteToMarkdown` (`src/state/noteToMarkdown.ts`)
/// faithfully: with `summary: None`, the output byte-for-byte matches what
/// that function still produces today (the frontend keeps using its own
/// generator until Stage 3 Task 5 rewires it to this markdown field
/// instead).
///
/// When `summary` is `Some`, three sections are inserted between the header
/// and `## Transcript`: `## Summary` (always, since `SummaryDoc::summary` is
/// a plain string with no "absent" state), then `## Decisions` and
/// `## Action items` — each omitted entirely (no empty heading) when its
/// list is empty, rather than rendered with no bullets under it. Action
/// items render as GitHub-flavored task list items: `- [x] text` when done,
/// `- [ ] text` otherwise.
pub fn render_note_md(
    meta: &NoteMeta,
    summary: Option<&SummaryDoc>,
    transcript: &Transcript,
) -> String {
    let minutes = (meta.duration_sec / 60.0).round() as i64;
    let mut out = format!(
        "# {}\n\n**Date:** {} · **Duration:** {} min · **Speakers:** {}",
        meta.title,
        format_date_label(&meta.created_at),
        minutes,
        meta.speakers,
    );

    if let Some(summary) = summary {
        out.push_str(&format!("\n\n## Summary\n\n{}", summary.summary));

        // Issue #14's topic breakdown, between the overview and the
        // decisions — the same reading order the panel and the overview tab
        // use. Each topic is a `###` subsection so the breakdown nests
        // under `## Topics` rather than competing with it; a topic that
        // came back title-only (see `llm::summary_topic_from_value`) renders
        // as a bare heading rather than a heading followed by a blank line.
        if !summary.topics.is_empty() {
            let topics = summary
                .topics
                .iter()
                .map(|topic| {
                    if topic.summary.trim().is_empty() {
                        format!("### {}", topic.title)
                    } else {
                        format!("### {}\n\n{}", topic.title, topic.summary)
                    }
                })
                .collect::<Vec<_>>()
                .join("\n\n");
            out.push_str(&format!("\n\n## Topics\n\n{topics}"));
        }

        if !summary.decisions.is_empty() {
            let decisions = summary
                .decisions
                .iter()
                .map(|d| format!("- {d}"))
                .collect::<Vec<_>>()
                .join("\n");
            out.push_str(&format!("\n\n## Decisions\n\n{decisions}"));
        }

        if !summary.action_items.is_empty() {
            let items = summary
                .action_items
                .iter()
                .map(|item| {
                    let checkbox = if item.done { "[x]" } else { "[ ]" };
                    format!("- {checkbox} {}", item.text)
                })
                .collect::<Vec<_>>()
                .join("\n");
            out.push_str(&format!("\n\n## Action items\n\n{items}"));
        }
    }

    if !meta.markers.is_empty() {
        let markers = meta
            .markers
            .iter()
            .map(|marker| format!("- [{}] {}", format_mm_ss(marker.seconds), marker.label))
            .collect::<Vec<_>>()
            .join("\n");
        out.push_str(&format!("\n\n## Markers\n\n{markers}"));
    }

    out.push_str(&format!(
        "\n\n## Transcript\n\n{}",
        transcript_body(&transcript.segments)
    ));
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    // Only the topic-breakdown rendering tests need this — `render_note_md`
    // itself reaches `SummaryTopic`'s fields through `summary.topics`, which
    // needs no import. Kept here rather than at module scope so a non-test
    // build doesn't warn on it.
    use crate::llm::SummaryTopic;
    use tempfile::tempdir;
    use time::macros::datetime;

    fn store_at(root: &Path) -> Store {
        Store::new(root.to_path_buf()).unwrap()
    }

    #[test]
    fn create_note_writes_meta_json_readable_back() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        assert_eq!(meta.title, "Standup");
        assert_eq!(meta.model, "whisper-small");
        assert_eq!(meta.status, NoteStatus::Recording);
        assert_eq!(meta.duration_sec, 0.0);
        assert_eq!(meta.speakers, 1);

        let (read_back, transcript) = store.get_note(&meta.id).unwrap();
        assert_eq!(read_back, meta);
        assert!(transcript.segments.is_empty());

        // write_meta is atomic (tmp + rename, like every other on-disk
        // writer in this module) — no leftover .tmp file after the write.
        assert!(store.meta_path(&meta.id).exists());
        assert!(!store.meta_tmp_path(&meta.id).exists());
    }

    #[test]
    fn create_note_id_matches_expected_format() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        assert_eq!(meta.id, "20260723-101530");
        assert!(meta.id.len() == 15);
        let (date_part, time_part) = meta.id.split_once('-').unwrap();
        assert_eq!(date_part.len(), 8);
        assert!(date_part.chars().all(|c| c.is_ascii_digit()));
        assert_eq!(time_part.len(), 6);
        assert!(time_part.chars().all(|c| c.is_ascii_digit()));
    }

    #[test]
    fn create_note_normalizes_non_utc_offset_to_utc() {
        // 10:15:30 in UTC+05:00 is 05:15:30 UTC — the id/createdAt must be
        // derived from the normalized UTC instant, not the raw local
        // fields, regardless of what offset the caller happens to pass.
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        // Wall clock reads 10:15:30 with a +05:00 offset — i.e. 05:15:30 UTC.
        let local = datetime!(2026-07-23 10:15:30 +5);

        let meta = store
            .create_note("Standup", "whisper-small", local)
            .unwrap();

        assert_eq!(meta.id, "20260723-051530");
        assert!(
            meta.created_at.ends_with('Z') || meta.created_at.ends_with("+00:00"),
            "createdAt should be normalized to UTC, got {:?}",
            meta.created_at
        );
        assert!(meta.created_at.starts_with("2026-07-23T05:15:30"));
    }

    #[test]
    fn create_note_collision_appends_suffix() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let first = store.create_note("First", "whisper-small", now).unwrap();
        let second = store.create_note("Second", "whisper-small", now).unwrap();
        let third = store.create_note("Third", "whisper-small", now).unwrap();

        assert_eq!(first.id, "20260723-101530");
        assert_eq!(second.id, "20260723-101530-2");
        assert_eq!(third.id, "20260723-101530-3");
    }

    #[test]
    fn finalize_updates_status_and_duration() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        let finalized = store.finalize_note(&meta.id, 42.5, 2).unwrap();

        assert_eq!(finalized.status, NoteStatus::Transcribed);
        assert_eq!(finalized.duration_sec, 42.5);
        assert_eq!(finalized.speakers, 2);
        assert_eq!(finalized.id, meta.id);
        assert_eq!(finalized.created_at, meta.created_at);
    }

    // --- NoteMeta::sources (Stage 5 Task 5) ---------------------------------

    #[test]
    fn create_note_defaults_sources_to_mic_only() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        assert_eq!(meta.sources, vec!["mic".to_string()]);
    }

    #[test]
    fn set_note_sources_overwrites_and_persists_it() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();
        assert_eq!(meta.sources, vec!["mic".to_string()]);

        let updated = store
            .set_note_sources(&meta.id, vec!["mic".to_string(), "system".to_string()])
            .unwrap();
        assert_eq!(
            updated.sources,
            vec!["mic".to_string(), "system".to_string()]
        );

        // Persisted, not just returned — a fresh read confirms the write.
        let (read_back, _) = store.get_note(&meta.id).unwrap();
        assert_eq!(
            read_back.sources,
            vec!["mic".to_string(), "system".to_string()]
        );
    }

    #[test]
    fn set_note_sources_leaves_every_other_field_untouched() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();
        let finalized = store.finalize_note(&meta.id, 42.5, 2).unwrap();

        let updated = store
            .set_note_sources(&meta.id, vec!["mic".to_string(), "system".to_string()])
            .unwrap();

        assert_eq!(updated.id, finalized.id);
        assert_eq!(updated.title, finalized.title);
        assert_eq!(updated.created_at, finalized.created_at);
        assert_eq!(updated.duration_sec, finalized.duration_sec);
        assert_eq!(updated.status, finalized.status);
        assert_eq!(updated.speakers, finalized.speakers);
    }

    #[test]
    fn capture_warning_defaults_absent_and_persists_for_recovery() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();
        assert_eq!(meta.capture_warning, None);

        store.finalize_note(&meta.id, 42.5, 2).unwrap();
        let warning = "Audio finalization was incomplete: disk full".to_string();
        let updated = store
            .set_capture_warning(&meta.id, warning.clone())
            .unwrap();
        assert_eq!(updated.capture_warning.as_deref(), Some(warning.as_str()));

        let (read_back, _) = store.get_note(&meta.id).unwrap();
        assert_eq!(read_back.capture_warning.as_deref(), Some(warning.as_str()));
        assert_eq!(read_back.status, NoteStatus::Transcribed);
    }

    #[test]
    fn note_meta_without_sources_field_parses_as_mic_only_default() {
        // A meta.json written by any pre-Stage-5-Task-5 build has no
        // "sources" key at all — `#[serde(default = "default_sources")]`
        // must make that load as `["mic"]`, the correct interpretation
        // (every note recorded before this field existed was mic-only by
        // construction), not fail to parse.
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let id = "20260723-101530";
        fs::create_dir_all(store.note_dir(id)).unwrap();
        let legacy_json = serde_json::json!({
            "id": id,
            "title": "Standup",
            "createdAt": "2026-07-23T10:15:30.000Z",
            "durationSec": 60.0,
            "model": "whisper-small",
            "status": "transcribed",
            "speakers": 1,
        });
        fs::write(
            store.meta_path(id),
            serde_json::to_string(&legacy_json).unwrap(),
        )
        .unwrap();

        let (meta, _) = store.get_note(id).unwrap();

        assert_eq!(meta.sources, vec!["mic".to_string()]);
        assert_eq!(meta.capture_warning, None);
    }

    #[test]
    fn current_capture_warning_is_ignored_by_previous_version_metadata_reader() {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct V050NoteMeta {
            id: String,
            title: String,
            status: NoteStatus,
            sources: Vec<String>,
        }

        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let meta = store
            .create_note(
                "Recoverable call",
                "whisper-small",
                datetime!(2026-07-23 10:15:30 UTC),
            )
            .unwrap();
        let current = store
            .set_capture_warning(&meta.id, "disk full".to_string())
            .unwrap();
        let json = serde_json::to_string(&current).unwrap();

        let previous: V050NoteMeta = serde_json::from_str(&json).unwrap();
        assert_eq!(previous.id, current.id);
        assert_eq!(previous.title, current.title);
        assert_eq!(previous.status, NoteStatus::Recording);
        assert_eq!(previous.sources, vec!["mic".to_string()]);
    }

    #[test]
    fn note_meta_wire_shape_includes_camel_case_sources() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        let raw = fs::read_to_string(store.meta_path(&meta.id)).unwrap();
        assert!(raw.contains("\"sources\""));
    }

    #[test]
    fn rename_preserves_id_and_created_at() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Original", "whisper-small", now).unwrap();

        let renamed = store.rename_note(&meta.id, "Renamed").unwrap();

        assert_eq!(renamed.title, "Renamed");
        assert_eq!(renamed.id, meta.id);
        assert_eq!(renamed.created_at, meta.created_at);
    }

    #[test]
    fn legacy_note_defaults_pinned_and_markers() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let id = "20260723-101530";
        fs::create_dir_all(store.note_dir(id)).unwrap();
        let legacy_json = serde_json::json!({
            "id": id,
            "title": "Standup",
            "createdAt": "2026-07-23T10:15:30.000Z",
            "durationSec": 60.0,
            "model": "whisper-small",
            "status": "transcribed",
            "speakers": 1,
            "sources": ["mic"],
        });
        fs::write(
            store.meta_path(id),
            serde_json::to_string(&legacy_json).unwrap(),
        )
        .unwrap();

        let (meta, _) = store.get_note(id).unwrap();

        assert!(!meta.pinned);
        assert!(meta.markers.is_empty());
    }

    #[test]
    fn pin_marker_and_speaker_rename_persist_and_refresh_markdown() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Planning", "whisper-small", now).unwrap();
        store
            .write_transcript(
                &meta.id,
                &Transcript {
                    segments: vec![
                        StoredSegment {
                            speaker: "Speaker 1".into(),
                            start: 0.0,
                            end: 5.0,
                            text: "Opening context.".into(),
                        },
                        StoredSegment {
                            speaker: "Speaker 2".into(),
                            start: 74.0,
                            end: 82.0,
                            text: "We should ship Friday.".into(),
                        },
                    ],
                },
            )
            .unwrap();

        let pinned = store.set_note_pinned(&meta.id, true).unwrap();
        assert!(pinned.pinned);
        store.add_note_marker(&meta.id, 74.0, "Ship date").unwrap();
        store
            .add_note_marker(&meta.id, 18.0, "Open question")
            .unwrap();
        let transcript = store.rename_speaker(&meta.id, "Speaker 2", "Sam").unwrap();

        assert_eq!(transcript.segments[1].speaker, "Sam");
        let (persisted, persisted_transcript) = store.get_note(&meta.id).unwrap();
        assert!(persisted.pinned);
        assert_eq!(
            persisted.markers,
            vec![
                NoteMarker {
                    seconds: 18.0,
                    label: "Open question".into()
                },
                NoteMarker {
                    seconds: 74.0,
                    label: "Ship date".into()
                },
            ],
        );
        assert_eq!(persisted_transcript.segments[1].speaker, "Sam");

        let markdown = fs::read_to_string(store.note_md_path(&meta.id)).unwrap();
        assert!(markdown.contains("## Markers"));
        assert!(markdown.contains("- [00:18] Open question"));
        assert!(markdown.contains("- [01:14] Ship date"));
        assert!(markdown.contains("**Sam** (01:14)"));
    }

    #[test]
    fn merge_speakers_returns_exact_undo_and_restores_only_changed_turns() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Planning", "whisper-small", now).unwrap();
        store
            .write_transcript(
                &meta.id,
                &Transcript {
                    segments: vec![
                        StoredSegment {
                            speaker: "Speaker 1".into(),
                            start: 0.0,
                            end: 5.0,
                            text: "Opening context.".into(),
                        },
                        StoredSegment {
                            speaker: "Sam".into(),
                            start: 6.0,
                            end: 10.0,
                            text: "Existing Sam turn.".into(),
                        },
                        StoredSegment {
                            speaker: "Speaker 1".into(),
                            start: 11.0,
                            end: 15.0,
                            text: "Second source turn.".into(),
                        },
                    ],
                },
            )
            .unwrap();

        let merged = store.merge_speakers(&meta.id, "Speaker 1", "Sam").unwrap();
        assert_eq!(
            merged.undo,
            SpeakerMergeUndo {
                from: "Speaker 1".into(),
                into: "Sam".into(),
                segment_indices: vec![0, 2],
                checksum: merged.undo.checksum.clone(),
            }
        );
        assert!(merged
            .transcript
            .segments
            .iter()
            .all(|segment| segment.speaker == "Sam"));
        assert_eq!(merged.meta.speakers, 1);
        let markdown = fs::read_to_string(store.note_md_path(&meta.id)).unwrap();
        assert!(!markdown.contains("**Speaker 1**"));
        assert!(markdown.contains("**Sam**"));

        let restored = store.undo_speaker_merge(&meta.id, &merged.undo).unwrap();
        assert_eq!(restored.transcript.segments[0].speaker, "Speaker 1");
        assert_eq!(restored.transcript.segments[1].speaker, "Sam");
        assert_eq!(restored.transcript.segments[2].speaker, "Speaker 1");
        assert_eq!(restored.meta.speakers, 2);
        let markdown = fs::read_to_string(store.note_md_path(&meta.id)).unwrap();
        assert!(markdown.contains("**Speaker 1**"));
        assert!(markdown.contains("**Sam**"));
    }

    #[test]
    fn update_segment_speakers_relabels_everything_and_honors_aliases() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let meta = store
            .create_note(
                "Standup",
                "whisper-small",
                datetime!(2026-07-30 09:00:00 UTC),
            )
            .unwrap();
        store
            .write_transcript(
                &meta.id,
                &Transcript {
                    segments: vec![
                        StoredSegment {
                            speaker: "Speaker 1".into(),
                            start: 0.0,
                            end: 5.0,
                            text: "First.".into(),
                        },
                        StoredSegment {
                            speaker: "Speaker 1".into(),
                            start: 6.0,
                            end: 10.0,
                            text: "Second.".into(),
                        },
                    ],
                },
            )
            .unwrap();
        // A previously confirmed rename: raw "Speaker 1" is really Sam —
        // recorded in meta.speaker_aliases by rename_speaker.
        store.rename_speaker(&meta.id, "Speaker 1", "Sam").unwrap();
        let updated = store
            .update_segment_speakers(&meta.id, &["Speaker 1".into(), "Speaker 2".into()])
            .unwrap();

        let (_, transcript) = store.get_note(&meta.id).unwrap();
        // "Speaker 1" had been renamed to Sam, so the alias re-applies; the
        // brand-new "Speaker 2" label passes through untouched.
        assert_eq!(transcript.segments[0].speaker, "Sam");
        assert_eq!(transcript.segments[1].speaker, "Speaker 2");
        assert_eq!(updated.speakers, 2);
        let markdown = fs::read_to_string(store.note_md_path(&meta.id)).unwrap();
        assert!(markdown.contains("**Sam**"));
        assert!(markdown.contains("**Speaker 2**"));
    }

    /// Issue #32: a user's correction of an auto-applied name must survive
    /// a re-run — the pass matching the same profile again must not revert
    /// "Sara" back to "Sarah".
    #[test]
    fn a_user_correction_outranks_a_rerun_auto_apply() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let meta = store
            .create_note(
                "Standup",
                "whisper-small",
                datetime!(2026-07-30 09:00:00 UTC),
            )
            .unwrap();
        store
            .write_transcript(
                &meta.id,
                &Transcript {
                    segments: vec![StoredSegment {
                        speaker: "Speaker 1".into(),
                        start: 0.0,
                        end: 5.0,
                        text: "First.".into(),
                    }],
                },
            )
            .unwrap();

        let candidate = HashMap::from([("Speaker 1".to_string(), "Sarah".to_string())]);
        let applied = HashMap::from([(
            "Speaker 1".to_string(),
            SpeakerSuggestion {
                name: "Sarah".to_string(),
                similarity: 0.9,
            },
        )]);
        store
            .apply_speaker_names(&meta.id, &candidate, &applied, &HashMap::new())
            .unwrap();
        store
            .update_segment_speakers(&meta.id, &["Speaker 1".into()])
            .unwrap();

        // The user corrects the auto-applied name.
        store.rename_speaker(&meta.id, "Sarah", "Sara").unwrap();

        // A re-run matches the same profile again — the correction stays.
        let updated = store
            .apply_speaker_names(&meta.id, &candidate, &applied, &HashMap::new())
            .unwrap();
        assert_eq!(updated.speaker_aliases["Speaker 1"], "Sara");
        assert!(updated.speaker_auto_applied.is_empty());
        store
            .update_segment_speakers(&meta.id, &["Speaker 1".into()])
            .unwrap();
        let (_, transcript) = store.get_note(&meta.id).unwrap();
        assert_eq!(transcript.segments[0].speaker, "Sara");
    }

    /// Issue #32: a name already displayed by another label is never
    /// auto-applied — that would silently merge two people. It demotes to
    /// a suggestion instead.
    #[test]
    fn auto_apply_never_collapses_two_speakers_under_one_name() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let meta = store
            .create_note(
                "Standup",
                "whisper-small",
                datetime!(2026-07-30 09:00:00 UTC),
            )
            .unwrap();
        store
            .write_transcript(
                &meta.id,
                &Transcript {
                    segments: vec![
                        StoredSegment {
                            speaker: "Speaker 1".into(),
                            start: 0.0,
                            end: 5.0,
                            text: "First.".into(),
                        },
                        StoredSegment {
                            speaker: "Speaker 2".into(),
                            start: 6.0,
                            end: 10.0,
                            text: "Second.".into(),
                        },
                    ],
                },
            )
            .unwrap();
        // "Sarah" already belongs to Speaker 2 (user rename).
        store
            .rename_speaker(&meta.id, "Speaker 2", "Sarah")
            .unwrap();

        let candidate = HashMap::from([("Speaker 1".to_string(), "Sarah".to_string())]);
        let applied = HashMap::from([(
            "Speaker 1".to_string(),
            SpeakerSuggestion {
                name: "Sarah".to_string(),
                similarity: 0.85,
            },
        )]);
        let updated = store
            .apply_speaker_names(&meta.id, &candidate, &applied, &HashMap::new())
            .unwrap();

        assert!(!updated.speaker_aliases.contains_key("Speaker 1"));
        assert!(updated.speaker_auto_applied.is_empty());
        assert_eq!(updated.speaker_suggestions["Speaker 1"].name, "Sarah");
    }

    /// Issue #32: merging away an auto-applied name clears its notice —
    /// a lingering Undo would rename from a name that no longer exists.
    #[test]
    fn merging_away_an_auto_applied_name_clears_its_notice() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let meta = store
            .create_note(
                "Standup",
                "whisper-small",
                datetime!(2026-07-30 09:00:00 UTC),
            )
            .unwrap();
        store
            .write_transcript(
                &meta.id,
                &Transcript {
                    segments: vec![
                        StoredSegment {
                            speaker: "Speaker 1".into(),
                            start: 0.0,
                            end: 5.0,
                            text: "First.".into(),
                        },
                        StoredSegment {
                            speaker: "Priya".into(),
                            start: 6.0,
                            end: 10.0,
                            text: "Second.".into(),
                        },
                    ],
                },
            )
            .unwrap();

        let candidate = HashMap::from([("Speaker 1".to_string(), "Sarah".to_string())]);
        let applied = HashMap::from([(
            "Speaker 1".to_string(),
            SpeakerSuggestion {
                name: "Sarah".to_string(),
                similarity: 0.9,
            },
        )]);
        store
            .apply_speaker_names(&meta.id, &candidate, &applied, &HashMap::new())
            .unwrap();
        store
            .update_segment_speakers(&meta.id, &["Speaker 1".into(), "Priya".into()])
            .unwrap();

        let result = store.merge_speakers(&meta.id, "Sarah", "Priya").unwrap();
        assert!(result.meta.speaker_auto_applied.is_empty());
    }

    /// Issue #39: renaming a speaker back must not leave a stale alias
    /// that resurrects the abandoned name on the next diarization pass.
    #[test]
    fn reverting_a_rename_does_not_resurrect_the_old_name_on_rerun() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let meta = store
            .create_note(
                "Standup",
                "whisper-small",
                datetime!(2026-07-30 09:00:00 UTC),
            )
            .unwrap();
        store
            .write_transcript(
                &meta.id,
                &Transcript {
                    segments: vec![StoredSegment {
                        speaker: "Speaker 1".into(),
                        start: 0.0,
                        end: 5.0,
                        text: "First.".into(),
                    }],
                },
            )
            .unwrap();

        store.rename_speaker(&meta.id, "Speaker 1", "Sam").unwrap();
        store.rename_speaker(&meta.id, "Sam", "Speaker 1").unwrap();

        store
            .update_segment_speakers(&meta.id, &["Speaker 1".into()])
            .unwrap();
        let (_, transcript) = store.get_note(&meta.id).unwrap();
        assert_eq!(
            transcript.segments[0].speaker, "Speaker 1",
            "the reverted rename must stay reverted after a re-run"
        );
    }

    /// Issue #39's sibling: chained renames (Speaker 1 -> Sarah -> Sara)
    /// must re-apply the FINAL name on a re-run — the single-hop alias
    /// lookup used to restore the intermediate one.
    #[test]
    fn chained_renames_reapply_the_final_name_on_rerun() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let meta = store
            .create_note(
                "Standup",
                "whisper-small",
                datetime!(2026-07-30 09:00:00 UTC),
            )
            .unwrap();
        store
            .write_transcript(
                &meta.id,
                &Transcript {
                    segments: vec![StoredSegment {
                        speaker: "Speaker 1".into(),
                        start: 0.0,
                        end: 5.0,
                        text: "First.".into(),
                    }],
                },
            )
            .unwrap();

        store
            .rename_speaker(&meta.id, "Speaker 1", "Sarah")
            .unwrap();
        store.rename_speaker(&meta.id, "Sarah", "Sara").unwrap();

        store
            .update_segment_speakers(&meta.id, &["Speaker 1".into()])
            .unwrap();
        let (_, transcript) = store.get_note(&meta.id).unwrap();
        assert_eq!(
            transcript.segments[0].speaker, "Sara",
            "a re-run must land on the final rename, not the intermediate one"
        );
    }

    #[test]
    fn update_segment_speakers_rejects_a_label_count_mismatch() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let meta = store
            .create_note(
                "Standup",
                "whisper-small",
                datetime!(2026-07-30 09:00:00 UTC),
            )
            .unwrap();
        store
            .write_transcript(
                &meta.id,
                &Transcript {
                    segments: vec![StoredSegment {
                        speaker: "Speaker 1".into(),
                        start: 0.0,
                        end: 5.0,
                        text: "Only turn.".into(),
                    }],
                },
            )
            .unwrap();

        let err = store
            .update_segment_speakers(&meta.id, &["Speaker 1".into(), "Speaker 2".into()])
            .unwrap_err();
        assert!(err.to_string().contains("do not match"));
        // Nothing changed on disk.
        let (meta_after, transcript) = store.get_note(&meta.id).unwrap();
        assert_eq!(transcript.segments[0].speaker, "Speaker 1");
        assert_eq!(meta_after.speakers, meta.speakers);
    }

    #[test]
    fn confirmed_speaker_name_applies_to_later_turns_from_the_same_raw_label() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let meta = store
            .create_note(
                "Long interview",
                "whisper-small",
                datetime!(2026-07-23 10:15:30 UTC),
            )
            .unwrap();
        store
            .append_segment(
                &meta.id,
                StoredSegment {
                    speaker: "Speaker 2".into(),
                    start: 0.0,
                    end: 2.0,
                    text: "First turn.".into(),
                },
            )
            .unwrap();

        store
            .rename_speaker(&meta.id, "Speaker 2", "Jordan")
            .unwrap();
        store
            .append_segment(
                &meta.id,
                StoredSegment {
                    speaker: "Speaker 2".into(),
                    start: 3.0,
                    end: 5.0,
                    text: "Later turn.".into(),
                },
            )
            .unwrap();

        let (persisted_meta, transcript) = store.get_note(&meta.id).unwrap();
        assert_eq!(
            persisted_meta.speaker_aliases.get("Speaker 2"),
            Some(&"Jordan".to_string())
        );
        assert_eq!(transcript.segments[0].speaker, "Jordan");
        assert_eq!(transcript.segments[1].speaker, "Jordan");
    }

    #[test]
    fn speaker_merge_rejects_invalid_or_stale_operations_without_mutating_transcript() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Planning", "whisper-small", now).unwrap();
        let original = Transcript {
            segments: vec![
                StoredSegment {
                    speaker: "Speaker 1".into(),
                    start: 0.0,
                    end: 5.0,
                    text: "Opening context.".into(),
                },
                StoredSegment {
                    speaker: "Sam".into(),
                    start: 6.0,
                    end: 10.0,
                    text: "Existing Sam turn.".into(),
                },
            ],
        };
        store.write_transcript(&meta.id, &original).unwrap();

        assert!(store.rename_speaker(&meta.id, "Speaker 1", "Sam").is_err());
        assert!(store
            .merge_speakers(&meta.id, "Speaker 1", "Missing")
            .is_err());
        assert!(store.merge_speakers(&meta.id, "Sam", "Sam").is_err());
        assert_eq!(store.read_transcript(&meta.id).unwrap(), original);

        let merged = store.merge_speakers(&meta.id, "Speaker 1", "Sam").unwrap();
        let stale = SpeakerMergeUndo {
            from: merged.undo.from.clone(),
            into: merged.undo.into.clone(),
            segment_indices: vec![1],
            checksum: merged.undo.checksum.clone(),
        };
        assert!(store.undo_speaker_merge(&meta.id, &stale).is_err());
        assert_eq!(
            store.read_transcript(&meta.id).unwrap(),
            merged.transcript,
            "a rejected undo must leave the merged transcript untouched"
        );
    }

    #[test]
    fn marker_rejects_blank_labels_without_mutating_the_note() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Planning", "whisper-small", now).unwrap();

        assert!(store.add_note_marker(&meta.id, 12.0, "   ").is_err());
        let (persisted, _) = store.get_note(&meta.id).unwrap();
        assert!(persisted.markers.is_empty());
    }

    #[test]
    fn update_and_delete_marker_persist_and_refresh_markdown() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Planning", "whisper-small", now).unwrap();
        store
            .add_note_marker(&meta.id, 18.0, "Open question")
            .unwrap();
        store.add_note_marker(&meta.id, 74.0, "Old label").unwrap();

        let updated = store.update_note_marker(&meta.id, 1, "Ship date").unwrap();
        assert_eq!(updated.markers[1].label, "Ship date");
        let markdown = fs::read_to_string(store.note_md_path(&meta.id)).unwrap();
        assert!(markdown.contains("- [01:14] Ship date"));
        assert!(!markdown.contains("Old label"));

        let deleted = store.delete_note_marker(&meta.id, 0).unwrap();
        assert_eq!(
            deleted.markers,
            vec![NoteMarker {
                seconds: 74.0,
                label: "Ship date".into()
            }],
        );
        let markdown = fs::read_to_string(store.note_md_path(&meta.id)).unwrap();
        assert!(!markdown.contains("Open question"));
        assert!(markdown.contains("- [01:14] Ship date"));
    }

    #[test]
    fn marker_update_and_delete_reject_out_of_bounds_indices() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Planning", "whisper-small", now).unwrap();

        assert!(store.update_note_marker(&meta.id, 0, "Missing").is_err());
        assert!(store.delete_note_marker(&meta.id, 0).is_err());
    }

    #[test]
    fn append_segment_twice_orders_transcript() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        store
            .append_segment(
                &meta.id,
                StoredSegment {
                    speaker: "Speaker 1".into(),
                    start: 0.0,
                    end: 2.0,
                    text: "Hello".into(),
                },
            )
            .unwrap();
        store
            .append_segment(
                &meta.id,
                StoredSegment {
                    speaker: "Speaker 1".into(),
                    start: 2.0,
                    end: 4.5,
                    text: "world".into(),
                },
            )
            .unwrap();

        let (_meta, transcript) = store.get_note(&meta.id).unwrap();
        assert_eq!(transcript.segments.len(), 2);
        assert_eq!(transcript.segments[0].text, "Hello");
        assert_eq!(transcript.segments[1].text, "world");
    }

    #[test]
    fn write_transcript_atomic_leaves_no_tmp_file() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        let transcript = Transcript {
            segments: vec![StoredSegment {
                speaker: "Speaker 1".into(),
                start: 0.0,
                end: 1.0,
                text: "Hi".into(),
            }],
        };
        store.write_transcript(&meta.id, &transcript).unwrap();

        assert!(store.transcript_path(&meta.id).exists());
        assert!(!store.transcript_tmp_path(&meta.id).exists());

        // Not just "a file exists" — what's on disk must actually
        // deserialize back to the exact segments that were written.
        let raw = fs::read_to_string(store.transcript_path(&meta.id)).unwrap();
        let read_back: Transcript = serde_json::from_str(&raw).unwrap();
        assert_eq!(read_back, transcript);
    }

    #[test]
    fn list_notes_sorted_desc_by_created_at() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());

        let t1 = datetime!(2026-07-23 08:00:00 UTC);
        let t2 = datetime!(2026-07-23 09:00:00 UTC);
        let t3 = datetime!(2026-07-23 10:00:00 UTC);

        let n1 = store.create_note("Earliest", "whisper-small", t1).unwrap();
        let n2 = store.create_note("Middle", "whisper-small", t2).unwrap();
        let n3 = store.create_note("Latest", "whisper-small", t3).unwrap();

        let notes = store.list_notes().unwrap();
        let ids: Vec<&str> = notes.iter().map(|n| n.id.as_str()).collect();
        assert_eq!(ids, vec![n3.id.as_str(), n2.id.as_str(), n1.id.as_str()]);
    }

    #[test]
    fn list_notes_sorts_correctly_across_omitted_vs_present_fractional_seconds() {
        // Two notes land in the same wall-clock second: one exactly on the
        // second (RFC3339 omits the fraction entirely), one half a second
        // later within that same second (RFC3339 prints ".5"). Plain
        // lexicographic string comparison gets this backwards: "...:30Z" >
        // "...:30.5Z" as strings (because '.' < 'Z' in ASCII), even though
        // the .5 instant is chronologically later.
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());

        let on_the_second = datetime!(2026-07-23 10:15:30 UTC);
        let half_second_later = datetime!(2026-07-23 10:15:30.5 UTC);

        let earlier = store
            .create_note("On the second", "whisper-small", on_the_second)
            .unwrap();
        let later = store
            .create_note("Half second later", "whisper-small", half_second_later)
            .unwrap();

        // Sanity-check that this test actually exercises the pitfall: a
        // naive string compare must disagree with chronological order.
        assert!(
            later.created_at < earlier.created_at,
            "expected the fraction-bearing timestamp to sort lexicographically \
             smaller despite being chronologically later (got {:?} vs {:?})",
            later.created_at,
            earlier.created_at
        );

        let notes = store.list_notes().unwrap();
        let ids: Vec<&str> = notes.iter().map(|n| n.id.as_str()).collect();
        // Descending (most recent first): the .5s note must come first.
        assert_eq!(ids, vec![later.id.as_str(), earlier.id.as_str()]);
    }

    #[test]
    fn list_notes_skips_corrupt_meta_json() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let good = store
            .create_note("Good note", "whisper-small", now)
            .unwrap();

        let corrupt_dir = store.note_dir("20260723-000000-corrupt");
        fs::create_dir_all(&corrupt_dir).unwrap();
        fs::write(corrupt_dir.join(META_FILE), "not valid json {{{").unwrap();

        let notes = store.list_notes().unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, good.id);
    }

    #[test]
    fn list_notes_empty_root_returns_empty_vec() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());

        let notes = store.list_notes().unwrap();
        assert!(notes.is_empty());
    }

    #[test]
    fn get_note_without_transcript_returns_empty_segments() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("No transcript yet", "whisper-small", now)
            .unwrap();

        let (_meta, transcript) = store.get_note(&meta.id).unwrap();
        assert!(transcript.segments.is_empty());
    }

    #[test]
    fn storage_stats_counts_audio_separately_from_notes() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("With audio", "whisper-small", now)
            .unwrap();

        let audio_bytes = vec![0u8; 4096];
        fs::write(store.note_dir(&meta.id).join(AUDIO_FILE), &audio_bytes).unwrap();

        // models_bytes must walk recursively — pin a file nested in a
        // subdirectory (root/models/whisper/fake.bin), not just top-level.
        let model_bytes = vec![0u8; 2048];
        let model_dir = dir.path().join("models").join("whisper");
        fs::create_dir_all(&model_dir).unwrap();
        fs::write(model_dir.join("fake.bin"), &model_bytes).unwrap();

        let stats = storage_stats(dir.path()).unwrap();
        assert_eq!(stats.audio_bytes, audio_bytes.len() as u64);
        // meta.json itself (non-zero) should be counted in notes_bytes, and
        // must not include the audio bytes.
        assert!(stats.notes_bytes > 0);
        assert!(stats.notes_bytes < audio_bytes.len() as u64);
        assert_eq!(stats.models_bytes, model_bytes.len() as u64);
    }

    #[test]
    fn reveal_target_returns_audio_wav_when_present() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("Has audio", "whisper-small", now)
            .unwrap();
        fs::write(store.note_dir(&meta.id).join(AUDIO_FILE), b"fake wav bytes").unwrap();

        let target = store.reveal_target(&meta.id);

        assert_eq!(target, store.note_dir(&meta.id).join(AUDIO_FILE));
    }

    #[test]
    fn reveal_target_falls_back_to_note_dir_when_audio_missing() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("No audio yet", "whisper-small", now)
            .unwrap();

        let target = store.reveal_target(&meta.id);

        assert_eq!(target, store.note_dir(&meta.id));
    }

    #[test]
    fn reveal_target_on_nonexistent_note_dir_falls_back_to_it_anyway() {
        // Pure path selection doesn't require the note dir to exist — a
        // deleted-out-from-under-us note just falls back to a path that
        // itself won't exist either; the caller (the `reveal_note` Tauri
        // command) is what surfaces that as an error from `open -R`.
        let dir = tempdir().unwrap();
        let missing = dir.path().join("never-existed");

        assert_eq!(reveal_target(&missing), missing);
    }

    #[test]
    fn audio_path_returns_some_when_audio_wav_is_present() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("Has audio", "whisper-small", now)
            .unwrap();
        let expected = store.note_dir(&meta.id).join(AUDIO_FILE);
        fs::write(&expected, b"fake wav bytes").unwrap();

        assert_eq!(audio_path(&store.note_dir(&meta.id)), Some(expected));
    }

    #[test]
    fn audio_path_returns_none_when_audio_wav_is_missing() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("No audio yet", "whisper-small", now)
            .unwrap();

        assert_eq!(audio_path(&store.note_dir(&meta.id)), None);
    }

    #[test]
    fn audio_path_on_nonexistent_note_dir_returns_none() {
        let dir = tempdir().unwrap();
        let missing = dir.path().join("never-existed");

        assert_eq!(audio_path(&missing), None);
    }

    // --- resolved_audio_path -------------------------------------------------
    //
    // Pins the `get_note` invariant: `audioDeleted: true` always wins over
    // whatever's actually on disk, including the "impossible" case of a
    // stray `audio.wav` still sitting there (a race with an in-flight
    // sweep, a manual restore, ...).

    #[test]
    fn resolved_audio_path_is_none_when_audio_deleted_even_if_a_stray_wav_exists() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let mut meta = store
            .create_note("Swept but stray wav", "whisper-small", now)
            .unwrap();
        meta.audio_deleted = true;
        fs::write(
            store.note_dir(&meta.id).join(AUDIO_FILE),
            b"stray wav bytes",
        )
        .unwrap();

        assert_eq!(resolved_audio_path(&meta, &store.note_dir(&meta.id)), None);
    }

    #[test]
    fn resolved_audio_path_is_some_when_not_deleted_and_wav_present() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("Has audio", "whisper-small", now)
            .unwrap();
        let expected = store.note_dir(&meta.id).join(AUDIO_FILE);
        fs::write(&expected, b"real wav bytes").unwrap();

        assert_eq!(
            resolved_audio_path(&meta, &store.note_dir(&meta.id)),
            Some(expected)
        );
    }

    #[test]
    fn resolved_audio_path_is_none_when_not_deleted_and_wav_missing() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("No audio yet", "whisper-small", now)
            .unwrap();

        assert_eq!(resolved_audio_path(&meta, &store.note_dir(&meta.id)), None);
    }

    #[test]
    fn resolved_audio_path_falls_back_to_audio_m4a_once_compressed() {
        // Issue #16: after the compression sweep has replaced audio.wav
        // with audio.m4a, playback resolution must find the m4a — a note
        // isn't "audioDeleted" (that flag is reserved for the unrelated
        // 30-day delete sweep), it's just compressed.
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let mut meta = store
            .create_note("Compressed", "whisper-small", now)
            .unwrap();
        meta.audio_compressed = true;
        let expected = store.note_dir(&meta.id).join(AUDIO_M4A_FILE);
        fs::write(&expected, b"aac bytes").unwrap();

        assert_eq!(
            resolved_audio_path(&meta, &store.note_dir(&meta.id)),
            Some(expected)
        );
    }

    #[test]
    fn note_meta_without_audio_deleted_field_parses_as_false_default() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        // Simulate a pre-Task-3 meta.json: written back without the
        // `audioDeleted` field at all (not even `false` explicitly) — must
        // still parse, defaulting to `false`.
        let legacy_json = serde_json::json!({
            "id": meta.id,
            "title": meta.title,
            "createdAt": meta.created_at,
            "durationSec": meta.duration_sec,
            "model": meta.model,
            "status": "recording",
            "speakers": meta.speakers,
        });
        fs::write(
            store.meta_path(&meta.id),
            serde_json::to_string(&legacy_json).unwrap(),
        )
        .unwrap();

        let (read_back, _) = store.get_note(&meta.id).unwrap();
        assert!(!read_back.audio_deleted);
    }

    // --- sweep_candidates ---------------------------------------------------

    fn sweep_meta(id: &str, created_at: &str, status: NoteStatus, audio_deleted: bool) -> NoteMeta {
        NoteMeta {
            id: id.to_string(),
            title: "Note".to_string(),
            created_at: created_at.to_string(),
            duration_sec: 60.0,
            model: "whisper-small".to_string(),
            status,
            speakers: 1,
            capture_warning: None,
            audio_deleted,
            audio_compressed: false,
            sources: default_sources(),
            pinned: false,
            markers: Vec::new(),
            speaker_aliases: HashMap::new(),
            speaker_suggestions: HashMap::new(),
            speaker_auto_applied: HashMap::new(),
        }
    }

    fn rfc3339(dt: OffsetDateTime) -> String {
        dt.format(&time::format_description::well_known::Rfc3339)
            .unwrap()
    }

    #[test]
    fn sweep_candidates_selects_a_note_strictly_older_than_30_days() {
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let just_over_30_days = now - Duration::days(30) - Duration::seconds(1);
        let meta = sweep_meta("old", &rfc3339(just_over_30_days), NoteStatus::Ready, false);

        assert_eq!(sweep_candidates(&[meta], now), vec!["old".to_string()]);
    }

    #[test]
    fn sweep_candidates_excludes_a_note_exactly_30_days_old() {
        // The boundary is deliberately exclusive: exactly 30*24h old is NOT
        // yet swept, only strictly older than that.
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let exactly_30_days = now - Duration::days(30);
        let meta = sweep_meta(
            "boundary",
            &rfc3339(exactly_30_days),
            NoteStatus::Ready,
            false,
        );

        assert!(sweep_candidates(&[meta], now).is_empty());
    }

    #[test]
    fn sweep_candidates_excludes_a_note_younger_than_30_days() {
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let recent = now - Duration::days(1);
        let meta = sweep_meta("recent", &rfc3339(recent), NoteStatus::Ready, false);

        assert!(sweep_candidates(&[meta], now).is_empty());
    }

    #[test]
    fn sweep_candidates_excludes_recording_status_no_matter_how_old() {
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let ancient = now - Duration::days(365);
        let meta = sweep_meta(
            "still-recording",
            &rfc3339(ancient),
            NoteStatus::Recording,
            false,
        );

        assert!(sweep_candidates(&[meta], now).is_empty());
    }

    #[test]
    fn sweep_candidates_includes_transcribed_status_not_just_ready() {
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let ancient = now - Duration::days(60);
        let meta = sweep_meta(
            "transcribed-old",
            &rfc3339(ancient),
            NoteStatus::Transcribed,
            false,
        );

        assert_eq!(
            sweep_candidates(&[meta], now),
            vec!["transcribed-old".to_string()]
        );
    }

    #[test]
    fn sweep_candidates_excludes_notes_already_audio_deleted() {
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let ancient = now - Duration::days(60);
        let meta = sweep_meta("already-swept", &rfc3339(ancient), NoteStatus::Ready, true);

        assert!(sweep_candidates(&[meta], now).is_empty());
    }

    #[test]
    fn sweep_candidates_skips_a_note_with_malformed_created_at_without_panicking() {
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let meta = sweep_meta("corrupt", "not-a-real-timestamp", NoteStatus::Ready, false);

        assert!(sweep_candidates(&[meta], now).is_empty());
    }

    #[test]
    fn sweep_candidates_only_returns_the_matching_ids_out_of_a_mixed_set() {
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let ancient = now - Duration::days(60);
        let recent = now - Duration::days(1);
        let notes = vec![
            sweep_meta("eligible", &rfc3339(ancient), NoteStatus::Ready, false),
            sweep_meta("too-young", &rfc3339(recent), NoteStatus::Ready, false),
            sweep_meta("recording", &rfc3339(ancient), NoteStatus::Recording, false),
            sweep_meta(
                "already-deleted",
                &rfc3339(ancient),
                NoteStatus::Transcribed,
                true,
            ),
        ];

        assert_eq!(sweep_candidates(&notes, now), vec!["eligible".to_string()]);
    }

    // --- run_audio_sweep (fs) ------------------------------------------------

    #[test]
    fn run_audio_sweep_deletes_old_audio_sets_the_flag_and_leaves_the_transcript_intact() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let old = store
            .create_note("Old note", "whisper-small", now - Duration::days(40))
            .unwrap();
        store.finalize_note(&old.id, 60.0, 1).unwrap();
        fs::write(store.note_dir(&old.id).join(AUDIO_FILE), b"old wav bytes").unwrap();
        store
            .append_segment(
                &old.id,
                StoredSegment {
                    speaker: "Speaker 1".into(),
                    start: 0.0,
                    end: 1.0,
                    text: "hi".into(),
                },
            )
            .unwrap();

        let recent = store
            .create_note("Recent note", "whisper-small", now - Duration::days(1))
            .unwrap();
        store.finalize_note(&recent.id, 60.0, 1).unwrap();
        fs::write(
            store.note_dir(&recent.id).join(AUDIO_FILE),
            b"recent wav bytes",
        )
        .unwrap();

        let swept = store.run_audio_sweep(now).unwrap();

        assert_eq!(swept, 1);
        assert!(!store.note_dir(&old.id).join(AUDIO_FILE).exists());
        let (old_meta, old_transcript) = store.get_note(&old.id).unwrap();
        assert!(old_meta.audio_deleted);
        assert_eq!(old_transcript.segments.len(), 1);
        assert_eq!(old_transcript.segments[0].text, "hi");

        assert!(store.note_dir(&recent.id).join(AUDIO_FILE).exists());
        let (recent_meta, _) = store.get_note(&recent.id).unwrap();
        assert!(!recent_meta.audio_deleted);
    }

    #[test]
    fn run_audio_sweep_tolerates_an_already_missing_audio_wav() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let old = store
            .create_note("No audio", "whisper-small", now - Duration::days(40))
            .unwrap();
        store.finalize_note(&old.id, 60.0, 1).unwrap();
        // Deliberately no audio.wav written for this note.

        let swept = store.run_audio_sweep(now).unwrap();

        assert_eq!(swept, 1);
        let (meta, _) = store.get_note(&old.id).unwrap();
        assert!(meta.audio_deleted);
    }

    #[test]
    fn run_audio_sweep_never_touches_a_still_recording_note() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        // create_note leaves status at Recording; never finalized.
        let recording = store
            .create_note("Still recording", "whisper-small", now - Duration::days(90))
            .unwrap();
        fs::write(
            store.note_dir(&recording.id).join(AUDIO_FILE),
            b"live wav bytes",
        )
        .unwrap();

        let swept = store.run_audio_sweep(now).unwrap();

        assert_eq!(swept, 0);
        assert!(store.note_dir(&recording.id).join(AUDIO_FILE).exists());
        let (meta, _) = store.get_note(&recording.id).unwrap();
        assert!(!meta.audio_deleted);
    }

    #[test]
    fn note_dir_stats_on_vanished_dir_returns_zero() {
        // storage_stats runs lock-free and can race a concurrent
        // delete_note between listing notes/ and walking a given note's
        // directory — a directory that's gone by the time we get to it
        // must count as 0 bytes, not fail the whole stats command.
        let dir = tempdir().unwrap();
        let missing = dir.path().join("20260723-000000-never-existed");

        assert_eq!(note_dir_stats(&missing).unwrap(), (0, 0));
    }

    #[test]
    fn note_dir_stats_counts_audio_m4a_as_audio_bytes_once_compressed() {
        // Issue #16: once a note's audio.wav has been compressed away, the
        // remaining audio.m4a must still be counted as audio_bytes (not
        // notes_bytes) — the storage bar shouldn't suddenly attribute a
        // note's audio to "Notes" just because it got smaller.
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("Compressed already", "whisper-small", now)
            .unwrap();
        fs::write(store.note_dir(&meta.id).join(AUDIO_M4A_FILE), b"aac bytes").unwrap();
        fs::write(store.note_dir(&meta.id).join("meta.json"), b"{}").unwrap_or(());

        let (total, audio) = note_dir_stats(&store.note_dir(&meta.id)).unwrap();

        assert_eq!(audio, "aac bytes".len() as u64);
        assert!(total >= audio);
    }

    // --- compress_candidates -------------------------------------------------

    fn compress_meta(
        id: &str,
        created_at: &str,
        status: NoteStatus,
        audio_deleted: bool,
        audio_compressed: bool,
    ) -> NoteMeta {
        let mut meta = sweep_meta(id, created_at, status, audio_deleted);
        meta.audio_compressed = audio_compressed;
        meta
    }

    #[test]
    fn compress_candidates_selects_a_note_strictly_older_than_the_configured_days() {
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let just_over_7_days = now - Duration::days(7) - Duration::seconds(1);
        let meta = compress_meta("old", &rfc3339(just_over_7_days), NoteStatus::Ready, false, false);

        assert_eq!(
            compress_candidates(&[meta], now, 7),
            vec!["old".to_string()]
        );
    }

    #[test]
    fn compress_candidates_excludes_a_note_exactly_at_the_day_boundary() {
        // Same deliberately-exclusive boundary as sweep_candidates's 30-day
        // window: exactly N*24h old is NOT yet a candidate.
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let exactly_14_days = now - Duration::days(14);
        let meta = compress_meta(
            "boundary",
            &rfc3339(exactly_14_days),
            NoteStatus::Ready,
            false,
            false,
        );

        assert!(compress_candidates(&[meta], now, 14).is_empty());
    }

    #[test]
    fn compress_candidates_excludes_a_note_younger_than_the_configured_days() {
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let recent = now - Duration::days(2);
        let meta = compress_meta("recent", &rfc3339(recent), NoteStatus::Ready, false, false);

        assert!(compress_candidates(&[meta], now, 30).is_empty());
    }

    #[test]
    fn compress_candidates_excludes_recording_status_no_matter_how_old() {
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let ancient = now - Duration::days(365);
        let meta = compress_meta(
            "still-recording",
            &rfc3339(ancient),
            NoteStatus::Recording,
            false,
            false,
        );

        assert!(compress_candidates(&[meta], now, 7).is_empty());
    }

    #[test]
    fn compress_candidates_excludes_notes_already_audio_deleted() {
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let ancient = now - Duration::days(60);
        let meta = compress_meta("deleted", &rfc3339(ancient), NoteStatus::Ready, true, false);

        assert!(compress_candidates(&[meta], now, 7).is_empty());
    }

    #[test]
    fn compress_candidates_excludes_notes_already_compressed() {
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let ancient = now - Duration::days(60);
        let meta = compress_meta(
            "already-compressed",
            &rfc3339(ancient),
            NoteStatus::Ready,
            false,
            true,
        );

        assert!(compress_candidates(&[meta], now, 7).is_empty());
    }

    #[test]
    fn compress_candidates_skips_a_note_with_malformed_created_at_without_panicking() {
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let meta = compress_meta("corrupt", "not-a-real-timestamp", NoteStatus::Ready, false, false);

        assert!(compress_candidates(&[meta], now, 7).is_empty());
    }

    #[test]
    fn compress_candidates_includes_transcribed_status_not_just_ready() {
        let now = datetime!(2026-07-23 00:00:00 UTC);
        let ancient = now - Duration::days(30);
        let meta = compress_meta(
            "transcribed-old",
            &rfc3339(ancient),
            NoteStatus::Transcribed,
            false,
            false,
        );

        assert_eq!(
            compress_candidates(&[meta], now, 7),
            vec!["transcribed-old".to_string()]
        );
    }

    // --- run_compression_sweep (fs, fake encoder) -----------------------------

    /// A fake `afconvert` for `run_compression_sweep_with_encoder`'s tests —
    /// production tests can't rely on the real binary being present,
    /// deterministic, or fast (see `Store::run_compression_sweep_with_encoder`'s
    /// docs). Writes `contents` to `out_path` and returns `true` unless
    /// `wav_path` doesn't exist, mirroring `afconvert`'s own real failure
    /// mode (it can't encode audio that isn't there).
    fn fake_encoder(contents: &'static [u8]) -> impl Fn(&Path, &Path) -> bool {
        move |wav_path: &Path, out_path: &Path| {
            if !wav_path.exists() {
                return false;
            }
            fs::write(out_path, contents).is_ok()
        }
    }

    /// A [`SharedStore`] over the same root the test's plain [`Store`]
    /// uses — `Store` is just the root path, so both views see the same
    /// notes. The sweep takes the shared handle (it manages its own lock
    /// scope — see `run_compression_sweep`'s docs) while the test keeps
    /// its direct `Store` for setup and assertions.
    fn shared_store_at(root: &Path) -> SharedStore {
        Arc::new(Mutex::new(store_at(root)))
    }

    /// Issue #21: the sweep must not hold the store mutex while the
    /// encoder runs — a slow (or hung) `afconvert` used to block every
    /// store operation in the app, including the summarize worker's
    /// opening `get_note`. The encoder here *is* another store user:
    /// if the mutex is free mid-encode it locks instantly; if the old
    /// behavior regresses, `try_lock` fails and so does the test.
    #[test]
    fn run_compression_sweep_releases_the_store_lock_while_the_encoder_runs() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let old = store
            .create_note("Old note", "whisper-small", now - Duration::days(20))
            .unwrap();
        store.finalize_note(&old.id, 60.0, 1).unwrap();
        fs::write(store.note_dir(&old.id).join(AUDIO_FILE), b"old wav bytes").unwrap();

        let shared = shared_store_at(dir.path());
        let shared_for_encoder = shared.clone();
        let compressed = run_compression_sweep_with_encoder(
            &shared,
            now,
            7,
            move |wav_path: &Path, out_path: &Path| {
                assert!(
                    shared_for_encoder.try_lock().is_ok(),
                    "the store mutex must be free while the encoder runs"
                );
                fake_encoder(b"aac payload")(wav_path, out_path)
            },
        )
        .unwrap();

        assert_eq!(compressed, 1);
        let (meta, _) = store.get_note(&old.id).unwrap();
        assert!(meta.audio_compressed);
    }

    #[test]
    fn run_compression_sweep_encodes_old_audio_removes_wav_and_sets_the_flag() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let old = store
            .create_note("Old note", "whisper-small", now - Duration::days(20))
            .unwrap();
        store.finalize_note(&old.id, 60.0, 1).unwrap();
        fs::write(store.note_dir(&old.id).join(AUDIO_FILE), b"old wav bytes").unwrap();

        let recent = store
            .create_note("Recent note", "whisper-small", now - Duration::days(1))
            .unwrap();
        store.finalize_note(&recent.id, 60.0, 1).unwrap();
        fs::write(
            store.note_dir(&recent.id).join(AUDIO_FILE),
            b"recent wav bytes",
        )
        .unwrap();

        let compressed = run_compression_sweep_with_encoder(&shared_store_at(dir.path()), now, 7, fake_encoder(b"aac payload"))
            .unwrap();

        assert_eq!(compressed, 1);
        assert!(!store.note_dir(&old.id).join(AUDIO_FILE).exists());
        assert!(store.note_dir(&old.id).join(AUDIO_M4A_FILE).exists());
        assert!(!store.note_dir(&old.id).join(AUDIO_M4A_TMP_FILE).exists());
        let (old_meta, _) = store.get_note(&old.id).unwrap();
        assert!(old_meta.audio_compressed);
        assert!(!old_meta.audio_deleted);

        assert!(store.note_dir(&recent.id).join(AUDIO_FILE).exists());
        let (recent_meta, _) = store.get_note(&recent.id).unwrap();
        assert!(!recent_meta.audio_compressed);
    }

    #[test]
    fn run_compression_sweep_leaves_the_wav_untouched_when_afconvert_fails() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let old = store
            .create_note("Old note", "whisper-small", now - Duration::days(20))
            .unwrap();
        store.finalize_note(&old.id, 60.0, 1).unwrap();
        fs::write(store.note_dir(&old.id).join(AUDIO_FILE), b"old wav bytes").unwrap();

        let failing_encoder = |_wav: &Path, _out: &Path| false;
        let compressed = run_compression_sweep_with_encoder(&shared_store_at(dir.path()), now, 7, failing_encoder)
            .unwrap();

        assert_eq!(compressed, 0);
        assert!(store.note_dir(&old.id).join(AUDIO_FILE).exists());
        assert!(!store.note_dir(&old.id).join(AUDIO_M4A_FILE).exists());
        let (meta, _) = store.get_note(&old.id).unwrap();
        assert!(!meta.audio_compressed);
    }

    #[test]
    fn run_compression_sweep_leaves_the_wav_untouched_when_output_is_empty() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let old = store
            .create_note("Old note", "whisper-small", now - Duration::days(20))
            .unwrap();
        store.finalize_note(&old.id, 60.0, 1).unwrap();
        fs::write(store.note_dir(&old.id).join(AUDIO_FILE), b"old wav bytes").unwrap();

        // Encoder "succeeds" but writes an empty file — must be treated the
        // same as a failed encode: the WAV is the only real audio, so it's
        // never removed on the strength of a suspicious empty output.
        let compressed = run_compression_sweep_with_encoder(&shared_store_at(dir.path()), now, 7, fake_encoder(b""))
            .unwrap();

        assert_eq!(compressed, 0);
        assert!(store.note_dir(&old.id).join(AUDIO_FILE).exists());
        assert!(!store.note_dir(&old.id).join(AUDIO_M4A_FILE).exists());
        assert!(!store.note_dir(&old.id).join(AUDIO_M4A_TMP_FILE).exists());
        let (meta, _) = store.get_note(&old.id).unwrap();
        assert!(!meta.audio_compressed);
    }

    #[test]
    fn run_compression_sweep_tolerates_a_note_whose_wav_is_already_missing() {
        // compress_candidates is meta-only (see its docs) — a note without
        // audioDeleted/audioCompressed set but whose WAV vanished some other
        // way (a manual delete outside the app) must be skipped, not panic
        // or hand a nonexistent path to the encoder.
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let old = store
            .create_note("No wav", "whisper-small", now - Duration::days(20))
            .unwrap();
        store.finalize_note(&old.id, 60.0, 1).unwrap();
        // Deliberately no audio.wav written.

        let compressed = run_compression_sweep_with_encoder(&shared_store_at(dir.path()), now, 7, fake_encoder(b"aac payload"))
            .unwrap();

        assert_eq!(compressed, 0);
        let (meta, _) = store.get_note(&old.id).unwrap();
        assert!(!meta.audio_compressed);
    }

    #[test]
    fn run_compression_sweep_never_touches_a_still_recording_note() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let recording = store
            .create_note("Still recording", "whisper-small", now - Duration::days(90))
            .unwrap();
        fs::write(
            store.note_dir(&recording.id).join(AUDIO_FILE),
            b"live wav bytes",
        )
        .unwrap();

        let compressed = run_compression_sweep_with_encoder(&shared_store_at(dir.path()), now, 7, fake_encoder(b"aac payload"))
            .unwrap();

        assert_eq!(compressed, 0);
        assert!(store.note_dir(&recording.id).join(AUDIO_FILE).exists());
        let (meta, _) = store.get_note(&recording.id).unwrap();
        assert!(!meta.audio_compressed);
    }

    /// Issue #18: the flag must follow `summary.json` on disk, not
    /// `meta.status` — the two can disagree (pre-summarization notes are
    /// `ready` with no summary; issue #21 victims are `transcribed` with
    /// a summary already shown).
    #[test]
    fn list_notes_with_summary_follows_the_summary_file_not_the_status() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let summarized = store
            .create_note("Summarized", "whisper-small", now)
            .unwrap();
        store.finalize_note(&summarized.id, 60.0, 1).unwrap();
        store
            .write_summary_and_finalize(
                &summarized.id,
                &crate::llm::SummaryDoc {
                    summary: "They decided things.".to_string(),
                    ..Default::default()
                },
            )
            .unwrap();

        // The legacy mismatch: status `ready`, but no summary was ever
        // written.
        let legacy = store
            .create_note("Legacy ready", "whisper-small", now)
            .unwrap();
        store.finalize_note(&legacy.id, 60.0, 1).unwrap();
        let mut legacy_meta = store.read_meta(&legacy.id).unwrap();
        legacy_meta.status = NoteStatus::Ready;
        store.write_meta(&legacy_meta).unwrap();

        let entries = store.list_notes_with_summary().unwrap();
        let has_summary = |id: &str| {
            entries
                .iter()
                .find(|entry| entry.meta.id == id)
                .unwrap()
                .has_summary
        };
        assert!(has_summary(&summarized.id));
        assert!(
            !has_summary(&legacy.id),
            "a ready note with no summary.json must not report has_summary"
        );
    }

    // --- speaker embeddings (issue #22) ---------------------------------------

    #[test]
    fn speaker_embeddings_roundtrip_and_absence_reads_as_none() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        assert_eq!(store.read_speaker_embeddings(&meta.id).unwrap(), None);

        let embeddings = BTreeMap::from([
            ("Speaker 1".to_string(), vec![0.1_f32, 0.2, 0.3]),
            ("Speaker 2".to_string(), vec![0.9_f32, 0.8, 0.7]),
        ]);
        store.write_speaker_embeddings(&meta.id, &embeddings).unwrap();
        assert_eq!(
            store.read_speaker_embeddings(&meta.id).unwrap(),
            Some(embeddings)
        );
    }

    /// Issue #22: `speakers.json` keys stay at the original "Speaker N"
    /// labels while the transcript renames march on — the lookup must
    /// follow the alias chain to the current display name.
    #[test]
    fn embedding_for_speaker_follows_the_alias_chain_to_the_current_name() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();
        store.finalize_note(&meta.id, 60.0, 1).unwrap();
        store
            .write_transcript(
                &meta.id,
                &Transcript {
                    segments: vec![StoredSegment {
                        speaker: "Speaker 2".to_string(),
                        start: 0.0,
                        end: 1.0,
                        text: "hello".to_string(),
                    }],
                },
            )
            .unwrap();
        let embeddings = BTreeMap::from([("Speaker 2".to_string(), vec![0.5_f32, 0.5])]);
        store.write_speaker_embeddings(&meta.id, &embeddings).unwrap();

        // Direct hit on the original label.
        assert_eq!(
            store.embedding_for_speaker(&meta.id, "Speaker 2").unwrap(),
            Some(vec![0.5, 0.5])
        );

        // Two renames deep: Speaker 2 → Sarah → Sara.
        store.rename_speaker(&meta.id, "Speaker 2", "Sarah").unwrap();
        store.rename_speaker(&meta.id, "Sarah", "Sara").unwrap();
        assert_eq!(
            store.embedding_for_speaker(&meta.id, "Sara").unwrap(),
            Some(vec![0.5, 0.5])
        );
        assert_eq!(store.embedding_for_speaker(&meta.id, "Nobody").unwrap(), None);
    }

    #[test]
    fn corrupt_speaker_embeddings_read_as_none_not_an_error() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        fs::write(store.note_dir(&meta.id).join("speakers.json"), "not json").unwrap();
        assert_eq!(store.read_speaker_embeddings(&meta.id).unwrap(), None);
    }

    #[test]
    fn delete_note_removes_it_from_listing() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("To delete", "whisper-small", now)
            .unwrap();

        let undo = store.delete_note(&meta.id).unwrap();

        let notes = store.list_notes().unwrap();
        assert!(notes.iter().all(|n| n.id != meta.id));
        assert!(!store.note_dir(&meta.id).exists());
        assert!(store.root.join(RECOVERY_DIR).join(undo.trash_name).is_dir());
    }

    #[test]
    fn delete_note_can_be_restored_without_overwriting_an_existing_note() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("Recover me", "whisper-small", now)
            .unwrap();
        let undo = store.delete_note(&meta.id).unwrap();

        assert!(!store.note_dir(&meta.id).exists());
        let restored = store.restore_note(&undo).unwrap();
        assert_eq!(restored, meta);
        assert!(store.note_dir(&meta.id).is_dir());
        assert!(store.restore_note(&undo).is_err());

        let mut tampered = undo;
        tampered.trash_name.push_str("-changed");
        assert!(store.restore_note(&tampered).is_err());
    }

    #[test]
    fn diagnostics_exclude_private_note_content() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let meta = store
            .create_note(
                "Confidential acquisition target",
                "whisper-small",
                datetime!(2026-07-23 10:15:30 UTC),
            )
            .unwrap();
        store
            .append_segment(
                &meta.id,
                StoredSegment {
                    speaker: "Alice".to_string(),
                    start: 0.0,
                    end: 1.0,
                    text: "Project Nightingale is secret".to_string(),
                },
            )
            .unwrap();

        let path = store.export_diagnostics("0.6.0").unwrap();
        let report = fs::read_to_string(path).unwrap();
        assert!(!report.contains(&meta.id));
        assert!(!report.contains("Confidential acquisition target"));
        assert!(!report.contains("Project Nightingale"));
        assert!(!report.contains("Alice"));
        assert!(report.contains("\"noteCount\": 1"));
    }

    #[test]
    fn per_note_storage_and_audio_cleanup_preserve_documents() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let meta = store
            .create_note(
                "Storage test",
                "whisper-small",
                datetime!(2026-07-23 10:15:30 UTC),
            )
            .unwrap();
        fs::write(store.note_dir(&meta.id).join(AUDIO_FILE), vec![0u8; 4_096]).unwrap();
        store
            .append_segment(
                &meta.id,
                StoredSegment {
                    speaker: "Speaker 1".into(),
                    start: 0.0,
                    end: 1.0,
                    text: "Preserve this transcript.".into(),
                },
            )
            .unwrap();

        let before = store.note_storage_stats(&meta.id).unwrap();
        assert_eq!(before.audio_bytes, 4_096);
        assert!(before.document_bytes > 0);

        let updated = store.delete_note_audio(&meta.id).unwrap();
        assert!(updated.audio_deleted);
        assert!(!store.note_dir(&meta.id).join(AUDIO_FILE).exists());
        let (_, transcript) = store.get_note(&meta.id).unwrap();
        assert_eq!(transcript.segments[0].text, "Preserve this transcript.");
        assert_eq!(store.note_storage_stats(&meta.id).unwrap().audio_bytes, 0);
    }

    #[test]
    fn bulk_export_writes_markdown_and_manifest() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let first = store
            .create_note(
                "Alpha / planning",
                "whisper-small",
                datetime!(2026-07-23 10:15:30 UTC),
            )
            .unwrap();
        let second = store
            .create_note(
                "Beta review",
                "whisper-small",
                datetime!(2026-07-23 10:15:31 UTC),
            )
            .unwrap();

        let export = store
            .export_notes(&[first.id.clone(), second.id.clone()])
            .unwrap();
        assert!(export.join("001-Alpha---planning.md").is_file());
        assert!(export.join("002-Beta-review.md").is_file());
        let manifest = fs::read_to_string(export.join("manifest.json")).unwrap();
        assert!(manifest.contains("Alpha / planning"));
        assert!(manifest.contains("Beta review"));
    }

    // --- write_summary / read_summary ------------------------------------------

    use crate::llm::ActionItem;

    fn sample_summary() -> SummaryDoc {
        SummaryDoc {
            summary: "Discussed Q3 roadmap.".to_string(),
            topics: Vec::new(),
            decisions: vec!["Ship by Friday".to_string()],
            action_items: vec![ActionItem {
                text: "Write release notes".to_string(),
                done: false,
            }],
        }
    }

    #[test]
    fn write_summary_then_read_summary_roundtrips() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        store.write_summary(&meta.id, &sample_summary()).unwrap();
        let read_back = store.read_summary(&meta.id).unwrap();

        assert_eq!(read_back, Some(sample_summary()));
    }

    #[test]
    fn write_summary_is_atomic_and_leaves_no_tmp_file() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        store.write_summary(&meta.id, &sample_summary()).unwrap();

        assert!(store.summary_path(&meta.id).exists());
        assert!(!store.summary_tmp_path(&meta.id).exists());
    }

    #[test]
    fn read_summary_absent_returns_none() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        assert_eq!(store.read_summary(&meta.id).unwrap(), None);
    }

    /// Issue #14 added `topics` to `SummaryDoc`. Every `summary.json`
    /// already on disk predates it, and `SummaryDoc` has no struct-level
    /// serde default — without `#[serde(default)]` on the field, this read
    /// fails and every previously-summarized note silently loses its
    /// summary (`read_summary` logs and returns `None` on a parse error).
    #[test]
    fn read_summary_without_topics_still_parses_as_an_empty_topic_list() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        // Byte-for-byte the shape Minute wrote before this change.
        fs::write(
            store.summary_path(&meta.id),
            r#"{"summary":"We shipped it.","decisions":["Ship Friday"],"actionItems":[{"text":"Write notes","done":false}]}"#,
        )
        .unwrap();

        let summary = store
            .read_summary(&meta.id)
            .unwrap()
            .expect("a pre-topics summary.json must still load");
        assert_eq!(summary.summary, "We shipped it.");
        assert_eq!(summary.decisions, vec!["Ship Friday"]);
        assert_eq!(summary.action_items.len(), 1);
        assert!(summary.topics.is_empty());
    }

    #[test]
    fn read_summary_corrupt_warns_and_returns_none() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();
        fs::write(store.summary_path(&meta.id), "not valid json {{{").unwrap();

        assert_eq!(store.read_summary(&meta.id).unwrap(), None);
    }

    // --- write_summary_and_finalize ---------------------------------------------

    #[test]
    fn write_summary_and_finalize_sets_status_ready_and_persists_summary() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();
        store.finalize_note(&meta.id, 42.0, 1).unwrap();

        let updated = store
            .write_summary_and_finalize(&meta.id, &sample_summary())
            .unwrap();

        assert_eq!(updated.status, NoteStatus::Ready);
        assert_eq!(
            store.read_summary(&meta.id).unwrap(),
            Some(sample_summary())
        );
    }

    #[test]
    fn write_summary_and_finalize_also_writes_note_md() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        store
            .write_summary_and_finalize(&meta.id, &sample_summary())
            .unwrap();

        let markdown = fs::read_to_string(store.note_md_path(&meta.id)).unwrap();
        assert!(markdown.contains("## Summary"));
        assert!(markdown.contains("Discussed Q3 roadmap."));
    }

    // --- toggle_action_item -------------------------------------------------------

    #[test]
    fn toggle_action_item_flips_done_and_persists() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();
        store.write_summary(&meta.id, &sample_summary()).unwrap();

        let updated = store.toggle_action_item(&meta.id, 0, true).unwrap();

        assert!(updated.action_items[0].done);
        let read_back = store.read_summary(&meta.id).unwrap().unwrap();
        assert!(read_back.action_items[0].done);
    }

    #[test]
    fn toggle_action_item_regenerates_note_md_with_the_flipped_checkbox() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();
        store.write_summary(&meta.id, &sample_summary()).unwrap();
        store.write_note_md(&meta.id).unwrap();

        let before = fs::read_to_string(store.note_md_path(&meta.id)).unwrap();
        assert!(before.contains("- [ ] Write release notes"));

        store.toggle_action_item(&meta.id, 0, true).unwrap();

        let after = fs::read_to_string(store.note_md_path(&meta.id)).unwrap();
        assert!(after.contains("- [x] Write release notes"));
        assert!(!after.contains("- [ ] Write release notes"));
    }

    #[test]
    fn toggle_action_item_out_of_bounds_index_errors() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();
        store.write_summary(&meta.id, &sample_summary()).unwrap();

        let result = store.toggle_action_item(&meta.id, 5, true);

        assert!(result.is_err());
    }

    #[test]
    fn toggle_action_item_without_a_summary_errors() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        let result = store.toggle_action_item(&meta.id, 0, true);

        assert!(result.is_err());
    }

    // --- write_note_md / rename_note re-rendering ---------------------------------

    #[test]
    fn write_note_md_writes_a_file_matching_render_note_md() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        store.write_note_md(&meta.id).unwrap();

        let on_disk = fs::read_to_string(store.note_md_path(&meta.id)).unwrap();
        let (meta, transcript) = store.get_note(&meta.id).unwrap();
        assert_eq!(on_disk, render_note_md(&meta, None, &transcript));
    }

    #[test]
    fn write_note_md_is_atomic_and_leaves_no_tmp_file() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        store.write_note_md(&meta.id).unwrap();

        assert!(store.note_md_path(&meta.id).exists());
        assert!(!store.note_md_tmp_path(&meta.id).exists());
    }

    #[test]
    fn rename_note_re_renders_note_md_with_the_new_title() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Original", "whisper-small", now).unwrap();
        store.write_note_md(&meta.id).unwrap();

        store.rename_note(&meta.id, "Renamed").unwrap();

        let markdown = fs::read_to_string(store.note_md_path(&meta.id)).unwrap();
        assert!(markdown.starts_with("# Renamed"));
    }

    // --- render_note_md: golden strings -----------------------------------------

    fn md_meta(overrides: impl FnOnce(&mut NoteMeta)) -> NoteMeta {
        let mut meta = NoteMeta {
            id: "20260521-140000".to_string(),
            title: "Client call — Acme".to_string(),
            created_at: "2026-05-21T14:00:00.000Z".to_string(),
            duration_sec: 48.0 * 60.0,
            model: "whisper-small".to_string(),
            status: NoteStatus::Transcribed,
            speakers: 4,
            capture_warning: None,
            audio_deleted: false,
            audio_compressed: false,
            sources: default_sources(),
            pinned: false,
            markers: Vec::new(),
            speaker_aliases: HashMap::new(),
            speaker_suggestions: HashMap::new(),
            speaker_auto_applied: HashMap::new(),
        };
        overrides(&mut meta);
        meta
    }

    #[test]
    fn render_note_md_without_summary_matches_the_frontend_generators_output() {
        // Byte-for-byte port of noteToMarkdown.test.ts's
        // "renders the full template shape for a note with segments" case.
        let meta = md_meta(|_| {});
        let transcript = Transcript {
            segments: vec![
                StoredSegment {
                    speaker: "Speaker 1".into(),
                    start: 41.0,
                    end: 62.0,
                    text: "Thanks for making time.".into(),
                },
                StoredSegment {
                    speaker: "Speaker 1".into(),
                    start: 94.0,
                    end: 110.0,
                    text: "Short answer: nowhere.".into(),
                },
            ],
        };

        let markdown = render_note_md(&meta, None, &transcript);

        assert_eq!(
            markdown,
            "# Client call — Acme\n\
             \n\
             **Date:** May 21, 2026 · **Duration:** 48 min · **Speakers:** 4\n\
             \n\
             ## Transcript\n\
             \n\
             **Speaker 1** (00:41)\n\
             Thanks for making time.\n\
             \n\
             **Speaker 1** (01:34)\n\
             Short answer: nowhere.",
        );
    }

    #[test]
    fn render_note_md_without_summary_and_empty_transcript_matches_frontend() {
        let meta = md_meta(|_| {});

        let markdown = render_note_md(&meta, None, &Transcript::default());

        assert_eq!(
            markdown,
            "# Client call — Acme\n\
             \n\
             **Date:** May 21, 2026 · **Duration:** 48 min · **Speakers:** 4\n\
             \n\
             ## Transcript\n\
             \n\
             _No speech detected._",
        );
    }

    #[test]
    fn render_note_md_date_label_matches_frontend_month_day_year_format() {
        let meta = md_meta(|m| m.created_at = "2026-01-03T09:00:00.000Z".to_string());
        let markdown = render_note_md(&meta, None, &Transcript::default());
        assert!(markdown.contains("**Date:** January 3, 2026"));
    }

    #[test]
    fn render_note_md_rounds_duration_to_whole_minutes() {
        let meta = md_meta(|m| {
            m.duration_sec = 95.0;
            m.speakers = 1;
        });
        let markdown = render_note_md(&meta, None, &Transcript::default());
        assert!(markdown.contains("**Duration:** 2 min · **Speakers:** 1"));
    }

    #[test]
    fn render_note_md_with_summary_includes_summary_decisions_and_action_items() {
        let meta = md_meta(|_| {});
        let summary = SummaryDoc {
            summary: "Reviewed the roadmap and aligned on priorities.".to_string(),
            topics: Vec::new(),
            decisions: vec![
                "Ship the beta by Friday".to_string(),
                "Skip the redesign this quarter".to_string(),
            ],
            action_items: vec![
                ActionItem {
                    text: "Write release notes".to_string(),
                    done: true,
                },
                ActionItem {
                    text: "Schedule the retro".to_string(),
                    done: false,
                },
            ],
        };

        let markdown = render_note_md(&meta, Some(&summary), &Transcript::default());

        assert_eq!(
            markdown,
            "# Client call — Acme\n\
             \n\
             **Date:** May 21, 2026 · **Duration:** 48 min · **Speakers:** 4\n\
             \n\
             ## Summary\n\
             \n\
             Reviewed the roadmap and aligned on priorities.\n\
             \n\
             ## Decisions\n\
             \n\
             - Ship the beta by Friday\n\
             - Skip the redesign this quarter\n\
             \n\
             ## Action items\n\
             \n\
             - [x] Write release notes\n\
             - [ ] Schedule the retro\n\
             \n\
             ## Transcript\n\
             \n\
             _No speech detected._",
        );
    }

    /// Issue #14: the topic breakdown renders between the overview and the
    /// decisions — the same reading order the AI notes panel and the
    /// overview tab use. A title-only topic (see
    /// `llm::summary_topic_from_value`) is a bare heading, not a heading
    /// followed by a blank line.
    #[test]
    fn render_note_md_renders_the_topic_breakdown_between_summary_and_decisions() {
        let meta = md_meta(|_| {});
        let summary = SummaryDoc {
            summary: "Reviewed the roadmap.".to_string(),
            topics: vec![
                SummaryTopic {
                    title: "Pricing".to_string(),
                    summary: "Locked at $29. The annual discount was deferred.".to_string(),
                },
                SummaryTopic {
                    title: "Rollout".to_string(),
                    summary: String::new(),
                },
            ],
            decisions: vec!["Ship the beta by Friday".to_string()],
            action_items: Vec::new(),
        };

        let markdown = render_note_md(&meta, Some(&summary), &Transcript::default());

        assert_eq!(
            markdown,
            "# Client call — Acme\n\
             \n\
             **Date:** May 21, 2026 · **Duration:** 48 min · **Speakers:** 4\n\
             \n\
             ## Summary\n\
             \n\
             Reviewed the roadmap.\n\
             \n\
             ## Topics\n\
             \n\
             ### Pricing\n\
             \n\
             Locked at $29. The annual discount was deferred.\n\
             \n\
             ### Rollout\n\
             \n\
             ## Decisions\n\
             \n\
             - Ship the beta by Friday\n\
             \n\
             ## Transcript\n\
             \n\
             _No speech detected._",
        );
    }

    /// A note summarized under Short or Standard has no topics, and must
    /// render exactly as it did before issue #14 — no empty `## Topics`
    /// heading.
    #[test]
    fn render_note_md_omits_the_topics_section_entirely_when_there_are_none() {
        let meta = md_meta(|_| {});
        let summary = SummaryDoc {
            summary: "Reviewed the roadmap.".to_string(),
            topics: Vec::new(),
            decisions: Vec::new(),
            action_items: Vec::new(),
        };

        let markdown = render_note_md(&meta, Some(&summary), &Transcript::default());

        assert!(!markdown.contains("## Topics"));
        assert!(!markdown.contains("###"));
    }

    #[test]
    fn render_note_md_omits_empty_decisions_and_action_items_sections() {
        let meta = md_meta(|_| {});
        let summary = SummaryDoc {
            summary: "Quick sync, nothing decided.".to_string(),
            topics: Vec::new(),
            decisions: vec![],
            action_items: vec![],
        };

        let markdown = render_note_md(&meta, Some(&summary), &Transcript::default());

        assert!(markdown.contains("## Summary"));
        assert!(!markdown.contains("## Decisions"));
        assert!(!markdown.contains("## Action items"));
        assert_eq!(
            markdown,
            "# Client call — Acme\n\
             \n\
             **Date:** May 21, 2026 · **Duration:** 48 min · **Speakers:** 4\n\
             \n\
             ## Summary\n\
             \n\
             Quick sync, nothing decided.\n\
             \n\
             ## Transcript\n\
             \n\
             _No speech detected._",
        );
    }

    #[test]
    fn render_note_md_omits_only_decisions_when_action_items_present() {
        let meta = md_meta(|_| {});
        let summary = SummaryDoc {
            summary: "x".to_string(),
            topics: Vec::new(),
            decisions: vec![],
            action_items: vec![ActionItem {
                text: "Follow up".to_string(),
                done: false,
            }],
        };

        let markdown = render_note_md(&meta, Some(&summary), &Transcript::default());

        assert!(!markdown.contains("## Decisions"));
        assert!(markdown.contains("## Action items"));
        assert!(markdown.contains("- [ ] Follow up"));
    }

    // --- find_snippet ---------------------------------------------------------

    #[test]
    fn find_snippet_no_match_returns_none() {
        assert_eq!(find_snippet("Hello there", "goodbye"), None);
    }

    #[test]
    fn find_snippet_empty_needle_returns_none() {
        assert_eq!(find_snippet("Hello there", ""), None);
    }

    #[test]
    fn find_snippet_is_case_insensitive() {
        let snippet = find_snippet("The Roadmap Discussion", "roadmap").unwrap();
        assert!(snippet.contains("Roadmap"));
    }

    #[test]
    fn find_snippet_preserves_original_casing_not_lowercased() {
        let snippet = find_snippet("The Roadmap Discussion", "roadmap").unwrap();
        assert_eq!(snippet, "The Roadmap Discussion");
    }

    #[test]
    fn find_snippet_windows_around_the_match_with_radius_40_chars() {
        let filler_before = "x".repeat(100);
        let filler_after = "y".repeat(100);
        let haystack = format!("{filler_before}NEEDLE{filler_after}");

        let snippet = find_snippet(&haystack, "needle").unwrap();

        assert!(snippet.contains("NEEDLE"));
        // Truncated on both sides (100 chars of filler each side, only 40
        // kept) — both ends get an ellipsis marker.
        assert!(snippet.starts_with('…'));
        assert!(snippet.ends_with('…'));
        let before_in_snippet = snippet.split("NEEDLE").next().unwrap();
        let after_in_snippet = snippet.split("NEEDLE").nth(1).unwrap();
        // 40 chars of filler on each side, not the full 100, plus the
        // ellipsis marker itself — char count, not byte length, since '…'
        // is multi-byte.
        assert_eq!(before_in_snippet.chars().count(), 41); // '…' + 40 'x's
        assert_eq!(after_in_snippet.chars().count(), 41); // 40 'y's + '…'
    }

    #[test]
    fn find_snippet_no_ellipsis_when_the_whole_haystack_fits_in_the_window() {
        let snippet = find_snippet("A short title with NEEDLE inside", "needle").unwrap();
        assert!(!snippet.contains('…'));
    }

    #[test]
    fn find_snippet_match_near_the_start_does_not_underflow() {
        let haystack = "NEEDLE and then some more trailing text after it";
        let snippet = find_snippet(haystack, "needle").unwrap();
        assert!(snippet.starts_with("NEEDLE"));
        // Nothing precedes the match — no leading ellipsis.
        assert!(!snippet.starts_with('…'));
    }

    #[test]
    fn find_snippet_match_near_the_end_does_not_overflow() {
        let haystack = "some leading text before the NEEDLE";
        let snippet = find_snippet(haystack, "needle").unwrap();
        assert!(snippet.ends_with("NEEDLE"));
        // The whole (short) haystack fits in the window — no ellipsis at all.
        assert!(!snippet.contains('…'));
    }

    #[test]
    fn find_snippet_handles_emoji_around_the_match_without_panicking() {
        let haystack = "🎉🎉🎉 celebrating the NEEDLE launch 🚀🚀🚀";
        let snippet = find_snippet(haystack, "needle").unwrap();
        assert!(snippet.contains("NEEDLE"));
        assert!(snippet.contains('🎉'));
        assert!(snippet.contains('🚀'));
    }

    #[test]
    fn find_snippet_handles_cjk_text_without_panicking() {
        let haystack = "会議の議題は来週のNEEDLE予算計画についてです";
        let snippet = find_snippet(haystack, "needle").unwrap();
        assert!(snippet.contains("NEEDLE"));
        assert!(snippet.contains('議'));
    }

    #[test]
    fn find_snippet_handles_accented_latin_text_without_panicking() {
        let haystack = "L'équipe a discuté du NEEDLE budget à Zürich, café compris";
        let snippet = find_snippet(haystack, "needle").unwrap();
        assert!(snippet.contains("NEEDLE"));
        assert!(snippet.contains('é'));
    }

    #[test]
    fn find_snippet_needle_longer_than_haystack_returns_none() {
        assert_eq!(find_snippet("hi", "hello there"), None);
    }

    #[test]
    fn find_snippet_turkish_capital_i_with_dot_preserves_original_casing_and_does_not_panic() {
        // U+0130 (LATIN CAPITAL LETTER I WITH DOT ABOVE) lowercases to a
        // *two*-char sequence ('i' + a combining dot above) — the char
        // count of the lowercased haystack no longer matches the original,
        // which is exactly the case that broke a naive "slice a lowercased
        // copy" implementation. The snippet must still come back in the
        // *original* casing, not lowercased.
        let haystack = "MEETING İ NOTES";
        let snippet = find_snippet(haystack, "meeting").unwrap();
        assert_eq!(snippet, "MEETING İ NOTES");
        assert!(snippet.starts_with("MEETING"));
        assert!(!snippet.starts_with("meeting"));
    }

    #[test]
    fn find_snippet_turkish_capital_i_with_dot_matches_a_query_after_it_too() {
        // Same haystack, but the match falls *after* the char whose
        // lowercase mapping expands to two chars — pins that the original-
        // index mapping still lines up correctly past that point, not just
        // for text preceding it.
        let haystack = "MEETING İ NOTES";
        let snippet = find_snippet(haystack, "notes").unwrap();
        assert_eq!(snippet, "MEETING İ NOTES");
        assert!(snippet.ends_with("NOTES"));
    }

    #[test]
    fn find_snippet_german_eszett_matches_itself_case_insensitively_without_panicking() {
        // 'ß' (U+00DF) lowercases to itself (already lowercase) — searching
        // with the actual eszett should find it and preserve original
        // casing around it.
        let haystack = "Wir treffen uns in der Straße heute";
        let snippet = find_snippet(haystack, "straße").unwrap();
        assert!(snippet.contains("Straße"));
    }

    #[test]
    fn find_snippet_german_eszett_vs_double_s_spelling_does_not_panic_either_way() {
        // 'ß' does NOT expand to "ss" under `to_lowercase()` (that's an
        // uppercasing convention, not a lowercasing one) — so a
        // double-s-spelled query against an eszett-spelled haystack (and
        // vice versa) is expected to come back with no match, not a panic
        // or a mangled snippet.
        assert_eq!(
            find_snippet("Wir treffen uns in der Straße heute", "strasse"),
            None
        );
        assert_eq!(
            find_snippet("Wir treffen uns in der Strasse heute", "straße"),
            None
        );
        // The double-s spelling on both sides still matches normally.
        assert!(find_snippet("Wir treffen uns in der Strasse heute", "strasse").is_some());
    }

    // --- search_notes -----------------------------------------------------

    #[test]
    fn search_notes_empty_query_returns_empty_without_scanning() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        store.create_note("Standup", "whisper-small", now).unwrap();

        assert_eq!(store.search_notes("").unwrap(), Vec::new());
        assert_eq!(store.search_notes("   ").unwrap(), Vec::new());
    }

    #[test]
    fn search_notes_finds_a_title_match_case_insensitively() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("Client Call — Acme", "whisper-small", now)
            .unwrap();

        let hits = store.search_notes("acme").unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_id, meta.id);
        assert_eq!(hits[0].kind, SearchHitKind::Title);
        assert_eq!(hits[0].segment_start, None);
        assert!(hits[0].snippet.contains("Acme"));
    }

    #[test]
    fn search_notes_finds_a_transcript_segment_match_case_insensitively() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();
        store
            .append_segment(
                &meta.id,
                StoredSegment {
                    speaker: "Speaker 1".into(),
                    start: 12.5,
                    end: 15.0,
                    text: "Let's discuss the ROADMAP next.".into(),
                },
            )
            .unwrap();

        let hits = store.search_notes("roadmap").unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].note_id, meta.id);
        assert_eq!(hits[0].kind, SearchHitKind::Transcript);
        assert_eq!(hits[0].segment_start, Some(12.5));
        assert!(hits[0].snippet.contains("ROADMAP"));
    }

    #[test]
    fn search_notes_matches_on_both_title_and_transcript_for_the_same_query() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("Budget planning", "whisper-small", now)
            .unwrap();
        store
            .append_segment(
                &meta.id,
                StoredSegment {
                    speaker: "Speaker 1".into(),
                    start: 0.0,
                    end: 2.0,
                    text: "The budget is tight this quarter.".into(),
                },
            )
            .unwrap();

        let hits = store.search_notes("budget").unwrap();

        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].kind, SearchHitKind::Title);
        assert_eq!(hits[1].kind, SearchHitKind::Transcript);
    }

    #[test]
    fn search_notes_title_hits_are_ranked_before_transcript_hits_across_different_notes() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        // Older note only matches via its transcript.
        let transcript_note = store
            .create_note("Standup", "whisper-small", now - Duration::hours(2))
            .unwrap();
        store
            .append_segment(
                &transcript_note.id,
                StoredSegment {
                    speaker: "Speaker 1".into(),
                    start: 0.0,
                    end: 2.0,
                    text: "Sprint update".into(),
                },
            )
            .unwrap();

        // Newer note matches via its title.
        let title_note = store
            .create_note("Sprint kickoff", "whisper-small", now)
            .unwrap();

        let hits = store.search_notes("sprint").unwrap();

        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].note_id, title_note.id);
        assert_eq!(hits[0].kind, SearchHitKind::Title);
        assert_eq!(hits[1].note_id, transcript_note.id);
        assert_eq!(hits[1].kind, SearchHitKind::Transcript);
    }

    #[test]
    fn search_notes_orders_hits_within_a_kind_by_created_desc() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);

        let older = store
            .create_note(
                "Roadmap review — v1",
                "whisper-small",
                now - Duration::hours(3),
            )
            .unwrap();
        let newer = store
            .create_note("Roadmap review — v2", "whisper-small", now)
            .unwrap();

        let hits = store.search_notes("roadmap").unwrap();

        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].note_id, newer.id);
        assert_eq!(hits[1].note_id, older.id);
    }

    #[test]
    fn search_notes_caps_transcript_hits_at_3_per_note() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("Long meeting", "whisper-small", now)
            .unwrap();
        for i in 0..5 {
            store
                .append_segment(
                    &meta.id,
                    StoredSegment {
                        speaker: "Speaker 1".into(),
                        start: i as f64,
                        end: i as f64 + 1.0,
                        text: format!("mention number {i} of the keyword"),
                    },
                )
                .unwrap();
        }

        let hits = store.search_notes("keyword").unwrap();

        assert_eq!(hits.len(), 3);
        assert!(hits.iter().all(|h| h.kind == SearchHitKind::Transcript));
    }

    #[test]
    fn search_notes_caps_total_hits_at_50() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        for i in 0..60i64 {
            store
                .create_note(
                    &format!("Keyword meeting {i}"),
                    "whisper-small",
                    now - Duration::minutes(i),
                )
                .unwrap();
        }

        let hits = store.search_notes("keyword").unwrap();

        assert_eq!(hits.len(), 50);
    }

    #[test]
    fn search_notes_tolerates_a_note_with_no_transcript_json() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        // create_note never writes transcript.json — only append_segment does.
        store
            .create_note("Keyword title only", "whisper-small", now)
            .unwrap();

        let hits = store.search_notes("keyword").unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, SearchHitKind::Title);
    }

    #[test]
    fn search_notes_tolerates_a_corrupt_transcript_json() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("Keyword title", "whisper-small", now)
            .unwrap();
        fs::write(store.transcript_path(&meta.id), "not valid json {{{").unwrap();

        let hits = store.search_notes("keyword").unwrap();

        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, SearchHitKind::Title);
    }

    #[test]
    fn search_notes_no_matches_returns_empty_vec() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        store.create_note("Standup", "whisper-small", now).unwrap();

        assert_eq!(store.search_notes("nonexistent-term").unwrap(), Vec::new());
    }

    #[test]
    fn search_notes_handles_unicode_titles_without_panicking() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        store
            .create_note("会議 🎉 planning NEEDLE session", "whisper-small", now)
            .unwrap();

        let hits = store.search_notes("needle").unwrap();

        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("NEEDLE"));
        assert!(hits[0].snippet.contains('会'));
    }

    // --- move_library -------------------------------------------------------

    #[test]
    fn move_library_moves_notes_and_reroots_the_store() {
        let old = tempdir().unwrap();
        let new = tempdir().unwrap();
        let mut store = store_at(old.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("Standup", "whisper-small", now).unwrap();

        store.move_library(new.path().to_path_buf()).unwrap();

        // The store now reads the same note from the new location…
        let (read_back, _) = store.get_note(&meta.id).unwrap();
        assert_eq!(read_back.title, "Standup");
        assert!(store.root().starts_with(new.path().canonicalize().unwrap()));
        // …and the old location no longer holds a library.
        assert!(!old.path().join("notes").exists());
        assert!(new
            .path()
            .join("notes")
            .join(&meta.id)
            .join("meta.json")
            .exists());
    }

    #[test]
    fn move_library_rejects_a_destination_with_an_existing_notes_folder() {
        let old = tempdir().unwrap();
        let new = tempdir().unwrap();
        std::fs::create_dir(new.path().join("notes")).unwrap();
        let mut store = store_at(old.path());

        let err = store.move_library(new.path().to_path_buf()).unwrap_err();

        assert!(err.to_string().contains("already contains"));
        // Untouched: the store still reads/writes the old root.
        assert!(old.path().join("notes").exists());
        assert!(store.root().ends_with(old.path().file_name().unwrap()));
    }

    #[test]
    fn move_library_rejects_the_current_root() {
        let old = tempdir().unwrap();
        let mut store = store_at(old.path());

        let err = store.move_library(old.path().to_path_buf()).unwrap_err();

        assert!(err.to_string().contains("already lives"));
        assert!(old.path().join("notes").exists());
    }

    #[test]
    fn move_library_rejects_a_missing_destination() {
        let old = tempdir().unwrap();
        let mut store = store_at(old.path());

        let err = store
            .move_library(old.path().join("does-not-exist"))
            .unwrap_err();

        assert!(err.to_string().contains("does not exist"));
    }

    #[test]
    fn move_library_rejects_a_folder_inside_the_current_library() {
        let old = tempdir().unwrap();
        let mut store = store_at(old.path());
        let inside = old.path().join("notes").join("sub");
        std::fs::create_dir_all(&inside).unwrap();

        let err = store.move_library(inside).unwrap_err();

        assert!(err.to_string().contains("inside the current library"));
    }
}
