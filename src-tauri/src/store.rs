//! Folder-per-note persistence: note metadata, transcripts, and library scanning.

use std::collections::{HashMap, HashSet};
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
    pub storage: StorageStats,
    pub privacy: String,
}

const META_FILE: &str = "meta.json";
const META_TMP_FILE: &str = "meta.json.tmp";
const TRANSCRIPT_FILE: &str = "transcript.json";
const TRANSCRIPT_TMP_FILE: &str = "transcript.json.tmp";
const AUDIO_FILE: &str = "audio.wav";
const SUMMARY_FILE: &str = "summary.json";
const SUMMARY_TMP_FILE: &str = "summary.json.tmp";
const NOTE_MD_FILE: &str = "note.md";
const NOTE_MD_TMP_FILE: &str = "note.md.tmp";
const RECOVERY_DIR: &str = ".minute-trash";
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
            sources: default_sources(),
            pinned: false,
            markers: Vec::new(),
            speaker_aliases: HashMap::new(),
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
        meta.speaker_aliases
            .insert(from.to_string(), to.to_string());
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

    /// Removes only the original audio while preserving the transcript,
    /// summary, metadata, and markdown.
    pub fn delete_note_audio(&self, id: &str) -> Result<NoteMeta> {
        let mut meta = self.read_meta(id)?;
        let audio_path = self.note_dir(id).join(AUDIO_FILE);
        if let Err(error) = fs::remove_file(&audio_path) {
            if error.kind() != std::io::ErrorKind::NotFound {
                return Err(error.into());
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
            let audio_path = self.note_dir(&meta.id).join(AUDIO_FILE);
            if let Err(e) = fs::remove_file(&audio_path) {
                if e.kind() != std::io::ErrorKind::NotFound {
                    log::warn!(
                        "audio sweep: failed to delete audio.wav for note {}: {e}",
                        meta.id
                    );
                    continue;
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

/// The path `reveal_note` should hand to Finder for a given note directory:
/// the note's `audio.wav` if it exists, else the note directory itself (e.g.
/// a note whose audio was never captured, or has since been removed). Pure
/// — no process spawn, no existence requirement on `note_dir` itself — so
/// the selection rule is unit-testable without touching `open`.
pub fn reveal_target(note_dir: &Path) -> PathBuf {
    let audio = note_dir.join(AUDIO_FILE);
    if audio.exists() {
        audio
    } else {
        note_dir.to_path_buf()
    }
}

/// The absolute path to a note's `audio.wav`, if it's actually present on
/// disk — `None` for a note whose audio was never captured, or has since
/// been deleted. Pure — a plain existence check, no process spawn —
/// mirroring [`reveal_target`]'s shape. Doesn't know about `audioDeleted` at
/// all (it's a raw filesystem check, nothing more) — [`reveal_target`] wants
/// exactly that (Finder should still find a stray `audio.wav` if one somehow
/// exists). The `get_note` command instead goes through
/// [`resolved_audio_path`], which layers the `audioDeleted` invariant on top
/// of this.
pub fn audio_path(note_dir: &Path) -> Option<PathBuf> {
    let audio = note_dir.join(AUDIO_FILE);
    if audio.exists() {
        Some(audio)
    } else {
        None
    }
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
        if entry.file_name() == AUDIO_FILE {
            audio = len;
        }
    }
    Ok((total, audio))
}

/// Storage breakdown: `models_bytes` = everything under `root/models`;
/// `audio_bytes` = sum of every note's `audio.wav`; `notes_bytes` =
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
            sources: default_sources(),
            pinned: false,
            markers: Vec::new(),
            speaker_aliases: HashMap::new(),
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
            sources: default_sources(),
            pinned: false,
            markers: Vec::new(),
            speaker_aliases: HashMap::new(),
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

    #[test]
    fn render_note_md_omits_empty_decisions_and_action_items_sections() {
        let meta = md_meta(|_| {});
        let summary = SummaryDoc {
            summary: "Quick sync, nothing decided.".to_string(),
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
        assert!(new.path().join("notes").join(&meta.id).join("meta.json").exists());
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
