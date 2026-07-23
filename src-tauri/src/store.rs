//! Folder-per-note persistence: note metadata, transcripts, and library scanning.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};
use time::{OffsetDateTime, UtcOffset};

use crate::error::{MinuteError, Result};

/// Lifecycle status of a note.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum NoteStatus {
    Recording,
    Transcribed,
    Ready,
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

/// Disk usage breakdown for the storage stats panel.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageStats {
    pub models_bytes: u64,
    pub audio_bytes: u64,
    pub notes_bytes: u64,
}

const META_FILE: &str = "meta.json";
const TRANSCRIPT_FILE: &str = "transcript.json";
const TRANSCRIPT_TMP_FILE: &str = "transcript.json.tmp";
const AUDIO_FILE: &str = "audio.wav";

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
/// meant to prevent.
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
    store.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
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

    fn notes_root(&self) -> PathBuf {
        self.root.join("notes")
    }

    /// Directory for a given note id — where audio.rs writes `audio.wav`.
    pub fn note_dir(&self, id: &str) -> PathBuf {
        self.notes_root().join(id)
    }

    fn meta_path(&self, id: &str) -> PathBuf {
        self.note_dir(id).join(META_FILE)
    }

    fn transcript_path(&self, id: &str) -> PathBuf {
        self.note_dir(id).join(TRANSCRIPT_FILE)
    }

    fn transcript_tmp_path(&self, id: &str) -> PathBuf {
        self.note_dir(id).join(TRANSCRIPT_TMP_FILE)
    }

    fn write_meta(&self, meta: &NoteMeta) -> Result<()> {
        let json = serde_json::to_string_pretty(meta)
            .map_err(|e| MinuteError::Other(format!("failed to serialize meta.json: {e}")))?;
        fs::write(self.meta_path(&meta.id), json)?;
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
    pub fn create_note(
        &self,
        title: &str,
        model: &str,
        now: OffsetDateTime,
    ) -> Result<NoteMeta> {
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

    /// Atomically writes a note's full transcript (write to `.tmp`, then
    /// rename over the final path so readers never see a partial file).
    pub fn write_transcript(&self, id: &str, transcript: &Transcript) -> Result<()> {
        let json = serde_json::to_string_pretty(transcript).map_err(|e| {
            MinuteError::Other(format!("failed to serialize transcript.json: {e}"))
        })?;
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
    pub fn append_segment(&self, id: &str, segment: StoredSegment) -> Result<()> {
        let mut transcript = self.read_transcript(id)?;
        transcript.segments.push(segment);
        self.write_transcript(id, &transcript)
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

    /// Renames a note's title, preserving its id and createdAt.
    pub fn rename_note(&self, id: &str, title: &str) -> Result<NoteMeta> {
        let mut meta = self.read_meta(id)?;
        meta.title = title.to_string();
        self.write_meta(&meta)?;
        Ok(meta)
    }

    /// Deletes a note's directory by moving it to the OS trash. If the trash
    /// call itself errors (e.g. unsupported/sandboxed CI environments), falls
    /// back to a permanent `fs::remove_dir_all` so the operation still
    /// succeeds rather than leaving a note the UI can no longer act on.
    pub fn delete_note(&self, id: &str) -> Result<()> {
        self.delete_note_impl(id, |dir| trash::delete(dir).map_err(|e| e.to_string()))
    }

    /// Implementation seam behind `delete_note`: `trash_fn` performs the
    /// actual trash call. Injected so tests can force the permanent-delete
    /// fallback path deterministically, without depending on a real OS
    /// trash being available in CI/sandboxed environments.
    fn delete_note_impl(
        &self,
        id: &str,
        trash_fn: impl Fn(&Path) -> std::result::Result<(), String>,
    ) -> Result<()> {
        let dir = self.note_dir(id);
        if let Err(trash_err) = trash_fn(&dir) {
            log::warn!(
                "trash::delete failed for note {id} ({trash_err}); falling back to permanent delete"
            );
            fs::remove_dir_all(&dir)?;
        }
        Ok(())
    }

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

        let meta = store.create_note("Standup", "whisper-small", local).unwrap();

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

        let good = store.create_note("Good note", "whisper-small", now).unwrap();

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
        let meta = store.create_note("No transcript yet", "whisper-small", now).unwrap();

        let (_meta, transcript) = store.get_note(&meta.id).unwrap();
        assert!(transcript.segments.is_empty());
    }

    #[test]
    fn storage_stats_counts_audio_separately_from_notes() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store.create_note("With audio", "whisper-small", now).unwrap();

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
        let meta = store.create_note("To delete", "whisper-small", now).unwrap();

        store.delete_note(&meta.id).unwrap();

        let notes = store.list_notes().unwrap();
        assert!(notes.iter().all(|n| n.id != meta.id));
        assert!(!store.note_dir(&meta.id).exists());
    }

    #[test]
    fn delete_note_falls_back_to_permanent_delete_when_trash_errors() {
        let dir = tempdir().unwrap();
        let store = store_at(dir.path());
        let now = datetime!(2026-07-23 10:15:30 UTC);
        let meta = store
            .create_note("Trash unavailable", "whisper-small", now)
            .unwrap();

        // Force the trash call to always fail, exercising the fallback path
        // deterministically instead of depending on a real OS trash.
        store
            .delete_note_impl(&meta.id, |_dir| {
                Err("simulated trash failure".to_string())
            })
            .unwrap();

        assert!(!store.note_dir(&meta.id).exists());
        let notes = store.list_notes().unwrap();
        assert!(notes.iter().all(|n| n.id != meta.id));
    }
}
