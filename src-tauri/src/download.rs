//! Resumable, checksummed model downloads with throttled progress events.
//!
//! The pure, filesystem-only pieces (resume offset/hash recovery, digest
//! verification + promote-or-delete, progress throttling, the
//! per-chunk cancellation check) are factored out so they're unit-testable
//! without a real network stream. `execute_download` wires them into an
//! actual `reqwest` streaming download and is itself Tauri-agnostic (it
//! reports progress via a callback rather than emitting events directly),
//! so it can also be driven from the `#[ignore]`d network smoke test
//! without a running Tauri app. `download_model` is the thin Tauri command
//! wrapper around it — see `store.rs` for the same
//! pure-core-plus-thin-command shape used by the note store.

use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::AsyncWriteExt;

use crate::audio::{self, SharedRecorderState};
use crate::catalog::{self, CatalogEntry};
use crate::error::{MinuteError, Result};
use crate::llm::LlmBusy;

/// Where a target model file's in-progress download lives: `<target>.part`.
pub fn part_path(target: &Path) -> PathBuf {
    let mut os = target.as_os_str().to_owned();
    os.push(".part");
    PathBuf::from(os)
}

/// Hash + byte-offset state recovered from an existing `.part` file, so a
/// resumed download continues the digest exactly where the bytes on disk
/// leave off instead of restarting the hash from zero (which would produce
/// a final digest for only the tail of the file, not the whole thing).
pub struct ResumeState {
    pub offset: u64,
    pub hasher: Sha256,
}

/// Re-hashes an existing part file from disk and reports its length as the
/// resume offset. A missing part file resumes from a fresh, empty state
/// (offset 0, empty hasher) rather than erroring — "no part file yet" is
/// the normal starting condition for a first-time download.
pub fn resume_from_part(part_path: &Path) -> Result<ResumeState> {
    let mut hasher = Sha256::new();
    let mut offset = 0u64;

    match fs::File::open(part_path) {
        Ok(mut file) => {
            let mut buf = [0u8; 64 * 1024];
            loop {
                let n = file.read(&mut buf)?;
                if n == 0 {
                    break;
                }
                hasher.update(&buf[..n]);
                offset += n as u64;
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }

    Ok(ResumeState { offset, hasher })
}

/// Hex-encodes a digest. `sha2`'s digest output doesn't implement
/// `LowerHex` itself, so this is a small manual encoder rather than
/// pulling in the `hex` crate for one call site.
fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Verifies a completed download's digest against the catalog's pinned
/// sha256 and either promotes the part file to its final path, or deletes
/// it and reports a mismatch. Pure filesystem-only helper so the
/// verify/rename/delete decision is unit-testable without a real network
/// stream.
pub fn finalize_download(
    part_path: &Path,
    target_path: &Path,
    expected_sha256: &str,
    actual_digest_hex: &str,
) -> Result<()> {
    if actual_digest_hex.eq_ignore_ascii_case(expected_sha256) {
        fs::rename(part_path, target_path)?;
        Ok(())
    } else {
        match fs::remove_file(part_path) {
            Ok(()) => {}
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        Err(MinuteError::Other("checksum mismatch".to_string()))
    }
}

/// Rate-limits progress emission to at most one event per `min_interval`.
/// Takes `now` as an explicit parameter on every call (rather than reading
/// a system clock itself) so throttling behavior is unit-testable with
/// synthetic timestamps instead of real sleeps.
pub struct ProgressThrottle {
    min_interval: Duration,
    last_emitted: Option<Instant>,
}

impl ProgressThrottle {
    pub fn new(min_interval: Duration) -> Self {
        Self {
            min_interval,
            last_emitted: None,
        }
    }

    /// Whether the caller should emit a progress event for `now`. The very
    /// first call always emits (nothing has ever gone out yet); after
    /// that, only once at least `min_interval` has elapsed since the last
    /// emission.
    pub fn should_emit(&mut self, now: Instant) -> bool {
        let due = match self.last_emitted {
            None => true,
            Some(last) => now.duration_since(last) >= self.min_interval,
        };
        if due {
            self.last_emitted = Some(now);
        }
        due
    }
}

/// Feeds `chunks` through `sink` one at a time, checking `cancel_flag`
/// before each chunk. Returns `Ok(true)` if cancellation was observed —
/// chunks already passed to `sink` before that point are not undone, so
/// whatever partial state `sink` produced (e.g. bytes already appended to
/// a `.part` file) is left exactly as-is. Mirrors the per-chunk check the
/// real streaming loop in `execute_download` performs; factored out so the
/// cancellation contract is unit-testable without a real network stream.
///
/// Not called from `execute_download` itself — that loop pulls chunks from
/// an async `reqwest` byte stream rather than a sync `Vec<u8>` iterator, so
/// the two can't literally share a call site. This documents and tests the
/// contract `execute_download`'s loop must uphold; kept `#[allow(dead_code)]`
/// since its only caller is the test below.
#[allow(dead_code)]
pub fn feed_chunks_checking_cancel(
    chunks: impl IntoIterator<Item = Vec<u8>>,
    cancel_flag: &AtomicBool,
    mut sink: impl FnMut(&[u8]) -> Result<()>,
) -> Result<bool> {
    for chunk in chunks {
        if cancel_flag.load(Ordering::SeqCst) {
            return Ok(true);
        }
        sink(&chunk)?;
    }
    Ok(false)
}

/// Tracks which model ids currently have an in-flight download, and lets
/// `cancel_download` signal that download's loop to stop. Type-alias +
/// free-function shape (rather than a method-bearing struct) to match
/// `store::SharedStore` / `lock_store` — see store.rs.
pub type DownloadRegistry = Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>;

/// Creates an empty, ready-to-`app.manage()` registry — the
/// `store::open_shared`-style factory for `DownloadRegistry`.
pub fn open_registry() -> DownloadRegistry {
    Arc::new(Mutex::new(HashMap::new()))
}

/// Locks a [`DownloadRegistry`], recovering from lock poisoning instead of
/// propagating it — same rationale as `store::lock_store`: one panicking
/// download must not brick every later download command for the rest of
/// the session.
fn lock_registry(registry: &DownloadRegistry) -> MutexGuard<'_, HashMap<String, Arc<AtomicBool>>> {
    registry
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Registers a new active download for `id` and returns its cancellation
/// flag. Errors — the concurrent-download guard — if one is already in
/// flight for that id.
pub fn registry_start(registry: &DownloadRegistry, id: &str) -> Result<Arc<AtomicBool>> {
    let mut map = lock_registry(registry);
    if map.contains_key(id) {
        return Err(MinuteError::Other(format!(
            "download already in progress for {id}"
        )));
    }
    let flag = Arc::new(AtomicBool::new(false));
    map.insert(id.to_string(), flag.clone());
    Ok(flag)
}

/// Signals the active download for `id` to stop at its next chunk check.
/// Errors if no download is currently active for that id.
pub fn registry_cancel(registry: &DownloadRegistry, id: &str) -> Result<()> {
    let map = lock_registry(registry);
    let flag = map
        .get(id)
        .ok_or_else(|| MinuteError::Other(format!("no active download for {id}")))?;
    flag.store(true, Ordering::SeqCst);
    Ok(())
}

/// Clears the active-download entry for `id`, whether it finished,
/// errored, or was cancelled. Frees the id up for a fresh `registry_start`.
pub fn registry_finish(registry: &DownloadRegistry, id: &str) {
    lock_registry(registry).remove(id);
}

/// Whether `id` currently has an in-flight download — drives
/// `list_models`' `InstallState::Downloading` reporting (see lib.rs): a
/// stray `.part` file with no active registry entry means an idle,
/// resumable-but-not-installed download, not an in-progress one.
pub fn registry_is_active(registry: &DownloadRegistry, id: &str) -> bool {
    lock_registry(registry).contains_key(id)
}

/// Whether a resumed download must restart from scratch instead of
/// appending: true only when we asked the server to resume
/// (`requested_range`) but it didn't honor that — answering with a full
/// `200` instead of a partial `206` means the body about to stream down is
/// the *whole* file, not just the tail, so continuing to append it onto
/// existing part bytes (and continuing their hash) would silently corrupt
/// both. Pure function so this decision is unit-testable independent of a
/// real HTTP response.
fn should_restart(requested_range: bool, status: reqwest::StatusCode) -> bool {
    requested_range && status != reqwest::StatusCode::PARTIAL_CONTENT
}

/// Downloads one catalog entry's model file into `models_root`, resuming
/// from an existing `.part` file if present, verifying its sha256 on
/// completion, and reporting progress via `on_progress(downloaded, total)`.
///
/// Doesn't touch Tauri types itself — `download_model` wraps this with
/// event emission, and the network smoke test below calls it directly.
///
/// Checks `cancel_flag` before writing each chunk; on cancellation, returns
/// `Err` (message `"cancelled"`) and leaves the `.part` file exactly as far
/// as it got, so a later call resumes from there.
///
/// Async-IO note: `resume_from_part` re-hashes a `.part` file synchronously
/// (it's a small, already-unit-tested, self-contained sync function) — run
/// once via `tokio::task::spawn_blocking` here so that blocking read loop
/// doesn't stall the async executor thread. The per-chunk writes inside the
/// streaming loop below use `tokio::fs`/`AsyncWriteExt` directly instead
/// (simpler than buffering + a `spawn_blocking` flush per chunk, and avoids
/// spawning a blocking task on every single network chunk).
pub async fn execute_download(
    entry: &CatalogEntry,
    models_root: &Path,
    cancel_flag: &Arc<AtomicBool>,
    mut on_progress: impl FnMut(u64, u64),
) -> Result<()> {
    let target = catalog::installed_path(entry, models_root);
    let part = part_path(&target);

    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent)?;
    }

    let part_for_resume = part.clone();
    let resume = tokio::task::spawn_blocking(move || resume_from_part(&part_for_resume))
        .await
        .map_err(|e| MinuteError::Other(format!("resume task panicked: {e}")))??;

    let client = reqwest::Client::new();
    let mut request = client.get(&entry.url);
    let requested_range = resume.offset > 0;
    if requested_range {
        request = request.header(reqwest::header::RANGE, format!("bytes={}-", resume.offset));
    }

    let response = request
        .send()
        .await
        .map_err(|e| MinuteError::Other(format!("request failed: {e}")))?;

    if !response.status().is_success() {
        return Err(MinuteError::Other(format!(
            "download failed: HTTP {}",
            response.status()
        )));
    }

    let restart = should_restart(requested_range, response.status());

    let (mut hasher, mut downloaded) = if restart {
        (Sha256::new(), 0u64)
    } else {
        (resume.hasher, resume.offset)
    };

    let total = match response.content_length() {
        Some(len) => downloaded + len,
        None => entry.size_bytes,
    };

    let mut file = tokio::fs::OpenOptions::new()
        .create(true)
        .write(true)
        .append(!restart)
        .truncate(restart)
        .open(&part)
        .await?;

    let mut throttle = ProgressThrottle::new(Duration::from_millis(250));
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        if cancel_flag.load(Ordering::SeqCst) {
            return Err(MinuteError::Cancelled);
        }
        let chunk = chunk.map_err(|e| MinuteError::Other(format!("stream error: {e}")))?;
        file.write_all(&chunk).await?;
        hasher.update(&chunk);
        downloaded += chunk.len() as u64;

        if throttle.should_emit(Instant::now()) {
            on_progress(downloaded, total);
        }
    }

    file.flush().await?;
    drop(file);

    let digest = to_hex(&hasher.finalize());
    finalize_download(&part, &target, &entry.sha256, &digest)?;
    on_progress(downloaded, total);
    Ok(())
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadProgressEvent {
    model_id: String,
    downloaded: u64,
    total: u64,
}

/// `cancelled` is a separate structured field (not something the frontend
/// has to derive by string-matching `error == "cancelled"`) — it's set
/// from the actual cancellation flag's state, independent of whatever text
/// ended up in `error`.
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct DownloadDoneEvent {
    model_id: String,
    ok: bool,
    cancelled: bool,
    error: Option<String>,
}

fn emit_progress(app: &AppHandle, model_id: &str, downloaded: u64, total: u64) {
    let event = DownloadProgressEvent {
        model_id: model_id.to_string(),
        downloaded,
        total,
    };
    if let Err(e) = app.emit("model-download-progress", event) {
        log::warn!("failed to emit model-download-progress for {model_id}: {e}");
    }
}

fn emit_done(app: &AppHandle, model_id: &str, ok: bool, cancelled: bool, error: Option<String>) {
    let event = DownloadDoneEvent {
        model_id: model_id.to_string(),
        ok,
        cancelled,
        error,
    };
    if let Err(e) = app.emit("model-download-done", event) {
        log::warn!("failed to emit model-download-done for {model_id}: {e}");
    }
}

/// Ensures the registry entry for `id` is removed when this guard drops —
/// created right after a successful `registry_start`, so `id` is freed up
/// for a future download no matter how the rest of `download_model` exits:
/// normal completion, an early `?` return, or even a panic unwinding
/// through the `.await`. Holds an owned (cheap, `Arc`-backed) clone of the
/// registry rather than a borrow so it's unaffected by lifetimes across
/// await points.
struct RegistryGuard {
    registry: DownloadRegistry,
    id: String,
}

impl Drop for RegistryGuard {
    fn drop(&mut self) {
        registry_finish(&self.registry, &self.id);
    }
}

/// Downloads (or resumes) a catalog entry's model file, emitting
/// `model-download-progress` events (throttled to >=250ms apart) while it
/// runs and a single terminal `model-download-done` event when it stops —
/// on success, checksum mismatch, cancellation, or a network error.
///
/// The command's own `Result` is reserved for failures that mean the
/// download never started at all (unknown model id, or one already in
/// flight for this id — the concurrent-download guard). Once it starts,
/// every other outcome is reported via the done event rather than a
/// command error.
#[tauri::command]
pub async fn download_model(
    app: AppHandle,
    registry: State<'_, DownloadRegistry>,
    id: String,
) -> std::result::Result<(), String> {
    let registry = registry.inner().clone();
    let models_root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    let catalog = catalog::load_catalog().map_err(|e| e.to_string())?;
    let entry = catalog
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("unknown model id: {id}"))?;

    let cancel_flag = registry_start(&registry, &id).map_err(|e| e.to_string())?;
    let _cleanup = RegistryGuard {
        registry: registry.clone(),
        id: id.clone(),
    };

    let app_for_progress = app.clone();
    let id_for_progress = id.clone();
    let result = execute_download(
        &entry,
        &models_root,
        &cancel_flag,
        move |downloaded, total| {
            emit_progress(&app_for_progress, &id_for_progress, downloaded, total);
        },
    )
    .await;

    // `cancelled` is derived from the error variant itself, not a
    // post-hoc read of the shared flag: a late `cancel_download` call
    // arriving after `execute_download` has already returned a genuine
    // (non-cancellation) failure would otherwise race that flag read and
    // mislabel a real failure as a cancellation.
    match result {
        Ok(()) => emit_done(&app, &id, true, false, None),
        Err(MinuteError::Cancelled) => emit_done(
            &app,
            &id,
            false,
            true,
            Some(MinuteError::Cancelled.to_string()),
        ),
        Err(e) => emit_done(&app, &id, false, false, Some(e.to_string())),
    }

    Ok(())
}

/// Sets the cancellation flag for `id`'s in-flight download. The download
/// loop notices at its next chunk boundary, keeps the `.part` file as-is,
/// and reports `model-download-done { ok: false, cancelled: true, error:
/// Some("cancelled") }`.
#[tauri::command]
pub fn cancel_download(
    registry: State<'_, DownloadRegistry>,
    id: String,
) -> std::result::Result<(), String> {
    registry_cancel(&registry, &id).map_err(|e| e.to_string())
}

fn remove_file_tolerant(path: &Path) -> Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}

/// Whether `delete_model` should refuse to run, and why — an active
/// download for the model being deleted takes priority over an active
/// recording or LLM generation (both being true is still just "cancel the
/// download first"; that's the more specific, actionable message). Pure so
/// the guard combination is unit-testable without a running Tauri app or
/// real audio hardware.
///
/// `generating` covers *either* an in-flight summarize or an in-flight ask
/// — both share the one [`LlmBusy`] flag (see that type's docs), so this
/// guard can't (and doesn't need to) tell which one is actually running;
/// the message stays honest about that by not claiming it's specifically a
/// summary.
fn delete_model_blocked(
    downloading: bool,
    recording: bool,
    generating: bool,
) -> Option<&'static str> {
    if downloading {
        return Some("model is downloading — cancel first");
    }
    if recording {
        return Some("cannot remove models while recording");
    }
    if generating {
        return Some("cannot remove models while the assistant is generating");
    }
    None
}

/// Deletes an installed model's file and any stray `.part` left from an
/// interrupted download. Missing files are tolerated, not an error —
/// deleting an already-absent model is a no-op success.
///
/// Refuses while a download for `id` is active (per the registry) — an
/// unlink racing the streaming loop's open file handle would either fail
/// underneath it or, worse, silently leave a `.part` renamed out from under
/// a download that's still writing to it. The frontend must cancel first.
///
/// Also refuses while *any* recording is active (conservative — not just
/// the model currently in use) — the live `SttWorker` holds a loaded
/// `WhisperContext` from that model's file on disk for the duration of the
/// recording, so removing it out from under a running recording is unsafe
/// regardless of which model id the frontend thinks it's deleting.
///
/// Also refuses while *any* LLM generation (a summarize or an ask) is in
/// flight (same conservative, not-just-the-model-in-use shape as the
/// recording check, and the same global-not-per-note tradeoff as
/// `toggle_action_item`'s busy guard in `lib.rs`) — the worker holds a
/// loaded LLM file from disk for the duration via `llm::LlmEngineState`.
#[tauri::command]
pub fn delete_model(
    app: AppHandle,
    registry: State<'_, DownloadRegistry>,
    recorder: State<'_, SharedRecorderState>,
    llm_busy: State<'_, LlmBusy>,
    id: String,
) -> std::result::Result<(), String> {
    if let Some(msg) = delete_model_blocked(
        registry_is_active(&registry, &id),
        audio::is_recording_active(&recorder),
        llm_busy.load(Ordering::SeqCst),
    ) {
        return Err(msg.to_string());
    }

    let models_root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    let catalog = catalog::load_catalog().map_err(|e| e.to_string())?;
    let entry = catalog
        .into_iter()
        .find(|e| e.id == id)
        .ok_or_else(|| format!("unknown model id: {id}"))?;

    let target = catalog::installed_path(&entry, &models_root);
    let part = part_path(&target);

    remove_file_tolerant(&target).map_err(|e| e.to_string())?;
    remove_file_tolerant(&part).map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use tempfile::tempdir;

    // --- resume offset / hash continuation ---------------------------------

    #[test]
    fn resume_from_missing_part_starts_at_zero() {
        let dir = tempdir().unwrap();
        let part = dir.path().join("model.bin.part");

        let resume = resume_from_part(&part).unwrap();

        assert_eq!(resume.offset, 0);
        let digest = resume.hasher.finalize();
        let empty_digest = Sha256::new().finalize();
        assert_eq!(digest, empty_digest);
    }

    #[test]
    fn resume_offset_and_hash_continuation_matches_full_file_hash() {
        let dir = tempdir().unwrap();
        let part = dir.path().join("model.bin.part");
        let first_half = b"hello, this is the first chunk of bytes on disk ";
        let second_half = b"and this is the rest of the file streamed later";
        fs::write(&part, first_half).unwrap();

        let resume = resume_from_part(&part).unwrap();
        assert_eq!(resume.offset, first_half.len() as u64);

        let mut hasher = resume.hasher;
        hasher.update(second_half);
        let resumed_digest = hasher.finalize();

        let mut full_hasher = Sha256::new();
        full_hasher.update(first_half);
        full_hasher.update(second_half);
        let full_digest = full_hasher.finalize();

        assert_eq!(resumed_digest, full_digest);
    }

    // --- digest verification / finalize -------------------------------------

    fn hex_digest_of(bytes: &[u8]) -> String {
        let mut hasher = Sha256::new();
        hasher.update(bytes);
        to_hex(&hasher.finalize())
    }

    #[test]
    fn finalize_download_matching_digest_renames_part_to_target() {
        let dir = tempdir().unwrap();
        let part = dir.path().join("model.bin.part");
        let target = dir.path().join("model.bin");
        let bytes = b"correct model bytes";
        fs::write(&part, bytes).unwrap();
        let digest = hex_digest_of(bytes);

        finalize_download(&part, &target, &digest, &digest).unwrap();

        assert!(!part.exists());
        assert_eq!(fs::read(&target).unwrap(), bytes);
    }

    #[test]
    fn finalize_download_mismatch_deletes_part_and_errors() {
        let dir = tempdir().unwrap();
        let part = dir.path().join("model.bin.part");
        let target = dir.path().join("model.bin");
        fs::write(&part, b"wrong bytes entirely").unwrap();
        let expected = hex_digest_of(b"correct model bytes");
        let actual = hex_digest_of(b"wrong bytes entirely");

        let result = finalize_download(&part, &target, &expected, &actual);

        assert!(result.is_err());
        assert!(!part.exists());
        assert!(!target.exists());
    }

    #[test]
    fn finalize_download_digest_compare_is_case_insensitive() {
        let dir = tempdir().unwrap();
        let part = dir.path().join("model.bin.part");
        let target = dir.path().join("model.bin");
        let bytes = b"case insensitive check";
        fs::write(&part, bytes).unwrap();
        let digest_lower = hex_digest_of(bytes);
        let digest_upper = digest_lower.to_uppercase();

        finalize_download(&part, &target, &digest_upper, &digest_lower).unwrap();

        assert!(target.exists());
    }

    // --- progress throttling -------------------------------------------------

    #[test]
    fn throttle_emits_at_zero_then_only_after_min_interval_elapses() {
        let mut throttle = ProgressThrottle::new(Duration::from_millis(250));
        let base = Instant::now();
        // 250 sits exactly on the min_interval boundary — pins that
        // `should_emit` treats "exactly min_interval elapsed" as due
        // (`>=`), not "must be strictly more" (`>`).
        let offsets_ms = [0u64, 100, 250, 300, 600];

        let emitted: Vec<u64> = offsets_ms
            .iter()
            .copied()
            .filter(|&ms| throttle.should_emit(base + Duration::from_millis(ms)))
            .collect();

        assert_eq!(emitted, vec![0, 250, 600]);
    }

    #[test]
    fn throttle_never_emitted_always_emits_first_call() {
        let mut throttle = ProgressThrottle::new(Duration::from_millis(250));
        assert!(throttle.should_emit(Instant::now()));
    }

    // --- cancellation loop helper ---------------------------------------------

    #[test]
    fn cancellation_flag_stops_loop_and_keeps_partial_writes() {
        let dir = tempdir().unwrap();
        let part_path = dir.path().join("model.bin.part");
        let mut file = fs::File::create(&part_path).unwrap();

        let cancel_flag = AtomicBool::new(false);
        let chunks: Vec<Vec<u8>> = vec![b"aaaa".to_vec(), b"bbbb".to_vec(), b"cccc".to_vec()];
        let mut seen = 0usize;

        let cancelled = feed_chunks_checking_cancel(chunks, &cancel_flag, |chunk| {
            seen += 1;
            if seen == 2 {
                cancel_flag.store(true, Ordering::SeqCst);
            }
            file.write_all(chunk).map_err(MinuteError::from)
        })
        .unwrap();

        drop(file);
        assert!(cancelled);
        assert_eq!(seen, 2);
        assert_eq!(fs::read(&part_path).unwrap(), b"aaaabbbb");
    }

    #[test]
    fn no_cancellation_processes_all_chunks() {
        let cancel_flag = AtomicBool::new(false);
        let chunks: Vec<Vec<u8>> = vec![b"a".to_vec(), b"b".to_vec(), b"c".to_vec()];
        let mut collected = Vec::new();

        let cancelled = feed_chunks_checking_cancel(chunks, &cancel_flag, |chunk| {
            collected.extend_from_slice(chunk);
            Ok(())
        })
        .unwrap();

        assert!(!cancelled);
        assert_eq!(collected, b"abc");
    }

    // --- registry --------------------------------------------------------------

    #[test]
    fn registry_double_start_same_id_errors() {
        let registry = open_registry();
        registry_start(&registry, "whisper-small").unwrap();

        let result = registry_start(&registry, "whisper-small");

        assert!(result.is_err());
    }

    #[test]
    fn registry_start_after_cancel_and_finish_succeeds() {
        let registry = open_registry();
        let flag = registry_start(&registry, "whisper-small").unwrap();

        registry_cancel(&registry, "whisper-small").unwrap();
        assert!(flag.load(Ordering::SeqCst));

        registry_finish(&registry, "whisper-small");

        assert!(!registry_is_active(&registry, "whisper-small"));
        let result = registry_start(&registry, "whisper-small");
        assert!(result.is_ok());
    }

    #[test]
    fn registry_cancel_unknown_id_errors() {
        let registry = open_registry();
        let result = registry_cancel(&registry, "not-downloading");
        assert!(result.is_err());
    }

    #[test]
    fn registry_is_active_reflects_start_and_finish() {
        let registry = open_registry();
        assert!(!registry_is_active(&registry, "whisper-small"));

        registry_start(&registry, "whisper-small").unwrap();
        assert!(registry_is_active(&registry, "whisper-small"));

        registry_finish(&registry, "whisper-small");
        assert!(!registry_is_active(&registry, "whisper-small"));
    }

    // --- delete_model guard combination --------------------------------------

    #[test]
    fn delete_model_blocked_allows_when_nothing_is_active() {
        assert_eq!(delete_model_blocked(false, false, false), None);
    }

    #[test]
    fn delete_model_blocked_by_active_download() {
        assert_eq!(
            delete_model_blocked(true, false, false),
            Some("model is downloading — cancel first")
        );
    }

    #[test]
    fn delete_model_blocked_by_active_recording() {
        assert_eq!(
            delete_model_blocked(false, true, false),
            Some("cannot remove models while recording")
        );
    }

    #[test]
    fn delete_model_blocked_by_active_generation() {
        assert_eq!(
            delete_model_blocked(false, false, true),
            Some("cannot remove models while the assistant is generating")
        );
    }

    #[test]
    fn delete_model_blocked_prioritizes_the_download_message_when_all_are_true() {
        assert_eq!(
            delete_model_blocked(true, true, true),
            Some("model is downloading — cancel first")
        );
    }

    #[test]
    fn delete_model_blocked_prioritizes_recording_over_generating() {
        assert_eq!(
            delete_model_blocked(false, true, true),
            Some("cannot remove models while recording")
        );
    }

    // --- resume-restart decision ------------------------------------------------

    #[test]
    fn should_restart_false_when_server_honors_range_with_206() {
        assert!(!should_restart(true, reqwest::StatusCode::PARTIAL_CONTENT));
    }

    #[test]
    fn should_restart_true_when_range_requested_but_server_answers_full_200() {
        assert!(should_restart(true, reqwest::StatusCode::OK));
    }

    #[test]
    fn should_restart_false_when_no_range_was_requested() {
        // A fresh download (no existing .part, nothing to resume) never
        // requests a Range, so a plain 200 here is the expected, normal
        // response — not a signal to restart anything.
        assert!(!should_restart(false, reqwest::StatusCode::OK));
    }

    #[test]
    fn part_path_appends_dot_part_suffix() {
        let target = Path::new("/tmp/models/whisper/ggml-small.bin");
        assert_eq!(
            part_path(target),
            Path::new("/tmp/models/whisper/ggml-small.bin.part")
        );
    }

    // --- network smoke (manual only) --------------------------------------------

    /// Downloads the real whisper-small model (~466 MB) into the actual app
    /// data dir so it's available for Task 6's e2e whisper test too. Not
    /// run in CI/normal `cargo test`.
    ///
    /// Skips the network round-trip entirely (just logs and returns) if the
    /// model is already installed with a matching size — same short-circuit
    /// `real_download_of_qwen3_5_4b` below uses — without it, every run of
    /// this test would re-download the full 466 MB even when it's already
    /// on disk. Run manually:
    ///
    /// ```sh
    /// cargo test --manifest-path src-tauri/Cargo.toml -- --ignored real_download_of_whisper_small
    /// ```
    #[test]
    #[ignore]
    fn real_download_of_whisper_small_verifies_checksum_and_marks_installed() {
        let catalog = catalog::load_catalog().unwrap();
        let entry = catalog
            .iter()
            .find(|e| e.id == "whisper-small")
            .expect("catalog must contain whisper-small")
            .clone();

        let home = std::env::var("HOME").expect("HOME must be set");
        let models_root = PathBuf::from(home).join("Library/Application Support/dev.minute.app");

        if catalog::install_state(&entry, &models_root) == catalog::InstallState::Installed {
            eprintln!("whisper-small already installed at the expected size — skipping download");
            return;
        }

        let cancel_flag = Arc::new(AtomicBool::new(false));
        let runtime = tokio::runtime::Runtime::new().unwrap();

        let start = Instant::now();
        let result = runtime.block_on(execute_download(
            &entry,
            &models_root,
            &cancel_flag,
            |downloaded, total| {
                eprintln!("progress: {downloaded}/{total}");
            },
        ));
        let elapsed = start.elapsed();

        result.expect("real download should succeed");
        eprintln!("whisper-small download took {elapsed:?}");

        let state = catalog::install_state(&entry, &models_root);
        assert_eq!(state, catalog::InstallState::Installed);
    }

    /// Downloads the real Qwen3.5-4B LLM (~2.5 GB) into the actual app data
    /// dir — Stage 3 Task 1's model-support proof needs the real GGUF on
    /// disk before `llm::tests::real_llm_loads_and_generates` can load it.
    /// Skips the network round-trip entirely (just logs and returns) if the
    /// model is already installed with a matching size, same as re-running
    /// `real_download_of_whisper_small` would do implicitly via
    /// `execute_download`'s own resume/skip logic — except this check avoids
    /// even opening a connection. Run manually:
    ///
    /// ```sh
    /// cargo test --manifest-path src-tauri/Cargo.toml -- --ignored \
    ///     real_download_of_qwen3_5_4b
    /// ```
    #[test]
    #[ignore]
    fn real_download_of_qwen3_5_4b_verifies_checksum_and_marks_installed() {
        let catalog = catalog::load_catalog().unwrap();
        let entry = catalog
            .iter()
            .find(|e| e.id == "qwen3.5-4b")
            .expect("catalog must contain qwen3.5-4b")
            .clone();

        let home = std::env::var("HOME").expect("HOME must be set");
        let models_root = PathBuf::from(home).join("Library/Application Support/dev.minute.app");

        if catalog::install_state(&entry, &models_root) == catalog::InstallState::Installed {
            eprintln!("qwen3.5-4b already installed at the expected size — skipping download");
            return;
        }

        let cancel_flag = Arc::new(AtomicBool::new(false));
        let runtime = tokio::runtime::Runtime::new().unwrap();

        let start = Instant::now();
        let result = runtime.block_on(execute_download(
            &entry,
            &models_root,
            &cancel_flag,
            |downloaded, total| {
                eprintln!("progress: {downloaded}/{total}");
            },
        ));
        let elapsed = start.elapsed();

        result.expect("real download should succeed");
        eprintln!("qwen3.5-4b download took {elapsed:?}");

        let state = catalog::install_state(&entry, &models_root);
        assert_eq!(state, catalog::InstallState::Installed);
    }
}
