mod audio;
mod catalog;
mod detect;
mod download;
mod error;
mod llm;
mod popup;
mod settings;
mod store;
mod stt;
mod syscap;

use catalog::{Hardware, InstallState, ModelStatus, Recommendation};
use download::DownloadRegistry;
use llm::{LlmBusy, SharedLlmEngine, SummaryDoc};
use settings::{Settings, SettingsPatch, SharedSettings};
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use store::{
    lock_store, render_note_md, DeletedNoteUndo, NoteMeta, NoteStorageStats, SearchHit,
    SharedStore, SpeakerMergeResult, SpeakerMergeUndo, SpeakerMergeUndoResult, StorageStats,
    Transcript,
};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
fn hardware_info() -> Hardware {
    catalog::detect_hardware()
}

/// Lists every catalog entry with its current install state. A model's
/// state is `Downloading` iff the download registry has an active
/// cancellation flag for it right now — not merely because a `.part` file
/// exists on disk. A `.part` with no active registry entry means an idle,
/// resumable-but-not-installed download (e.g. cancelled, or left over from
/// a killed app), which is reported the same as `NotInstalled` rather than
/// a misleading "still downloading".
#[tauri::command]
fn list_models(
    app: AppHandle,
    registry: State<DownloadRegistry>,
) -> Result<Vec<ModelStatus>, String> {
    let models_root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    let entries = catalog::load_catalog().map_err(|e| e.to_string())?;
    Ok(entries
        .into_iter()
        .map(|entry| {
            let state = if download::registry_is_active(&registry, &entry.id) {
                InstallState::Downloading
            } else {
                catalog::install_state(&entry, &models_root)
            };
            ModelStatus { entry, state }
        })
        .collect())
}

// `_app` is unused today (recommend only needs the catalog + detected
// hardware) but kept in the signature for parity with the other model
// commands and in case a future tier needs install-state awareness.
#[tauri::command]
fn recommended_models(_app: AppHandle) -> Result<Recommendation, String> {
    let catalog = catalog::load_catalog().map_err(|e| e.to_string())?;
    let hw = catalog::detect_hardware();
    Ok(catalog::recommend(&catalog, &hw))
}

/// JSON-friendly wrapper for the `get_note` command — `Store::get_note`
/// returns a `(NoteMeta, Transcript)` tuple internally, but a tuple
/// serializes as a bare JSON array, so the command boundary shapes it into
/// a named object for the frontend. `summary` is the note's persisted
/// summary if one exists (`None` for a note that hasn't been summarized
/// yet); `markdown` is `store::render_note_md`'s output for the same
/// meta/transcript/summary, rendered fresh on every read rather than read
/// back off `note.md` — the file and this field are two renderings of the
/// same source of truth, not two sources of truth. `audioPath` is the
/// absolute path to `audio.wav` (see `store::audio_path`) when it's actually
/// present on disk AND `meta.audioDeleted` is false, `None` otherwise — the
/// frontend's `PlayerBar` uses this (via `convertFileSrc`, over Tauri's
/// asset protocol — never bytes over IPC) to decide between real playback
/// and its honest "Audio removed" disabled state, rather than assuming
/// every note has audio. `meta.audioDeleted` is checked explicitly (not just
/// "does audio.wav exist") so a stray/leftover `audio.wav` from a race with
/// the sweep can never resurrect playback for a note the sweep has already
/// marked swept — `audioDeleted` is the single source of truth once it's
/// `true`.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteWithTranscript {
    meta: NoteMeta,
    transcript: Transcript,
    summary: Option<SummaryDoc>,
    markdown: String,
    audio_path: Option<String>,
}

#[tauri::command]
fn list_notes(state: State<SharedStore>) -> Result<Vec<NoteMeta>, String> {
    lock_store(&state).list_notes().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_note(state: State<SharedStore>, id: String) -> Result<NoteWithTranscript, String> {
    let store = lock_store(&state);
    let (meta, transcript) = store.get_note(&id).map_err(|e| e.to_string())?;
    let summary = store.read_summary(&id).map_err(|e| e.to_string())?;
    let markdown = render_note_md(&meta, summary.as_ref(), &transcript);
    let audio_path = store::resolved_audio_path(&meta, &store.note_dir(&id))
        .map(|p| p.to_string_lossy().into_owned());
    Ok(NoteWithTranscript {
        meta,
        transcript,
        summary,
        markdown,
        audio_path,
    })
}

/// Case-insensitive substring search over every note's title and transcript
/// text — see `store::Store::search_notes` for the ranking/cap/snippet
/// rules. Backs both the ⌘K search palette and the sidebar's filter input.
#[tauri::command]
fn search_notes(state: State<SharedStore>, query: String) -> Result<Vec<SearchHit>, String> {
    lock_store(&state)
        .search_notes(&query)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_note(state: State<SharedStore>, id: String, title: String) -> Result<NoteMeta, String> {
    lock_store(&state)
        .rename_note(&id, &title)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn set_note_pinned(
    state: State<SharedStore>,
    id: String,
    pinned: bool,
) -> Result<NoteMeta, String> {
    lock_store(&state)
        .set_note_pinned(&id, pinned)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn add_note_marker(
    state: State<SharedStore>,
    id: String,
    seconds: f64,
    label: String,
) -> Result<NoteMeta, String> {
    lock_store(&state)
        .add_note_marker(&id, seconds, &label)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn update_note_marker(
    state: State<SharedStore>,
    id: String,
    index: usize,
    label: String,
) -> Result<NoteMeta, String> {
    lock_store(&state)
        .update_note_marker(&id, index, &label)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_note_marker(
    state: State<SharedStore>,
    id: String,
    index: usize,
) -> Result<NoteMeta, String> {
    lock_store(&state)
        .delete_note_marker(&id, index)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn rename_speaker(
    state: State<SharedStore>,
    id: String,
    from: String,
    to: String,
) -> Result<Transcript, String> {
    lock_store(&state)
        .rename_speaker(&id, &from, &to)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn merge_speakers(
    state: State<SharedStore>,
    id: String,
    from: String,
    into: String,
) -> Result<SpeakerMergeResult, String> {
    lock_store(&state)
        .merge_speakers(&id, &from, &into)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn undo_speaker_merge(
    state: State<SharedStore>,
    id: String,
    undo: SpeakerMergeUndo,
) -> Result<SpeakerMergeUndoResult, String> {
    lock_store(&state)
        .undo_speaker_merge(&id, &undo)
        .map_err(|e| e.to_string())
}

/// Toggles one action item's `done` state in a note's summary — read-
/// modify-write of `summary.json` under the store's mutex (see
/// `store::Store::toggle_action_item`), also re-rendering `note.md`.
/// `summarize_note` itself (the command that produces the summary in the
/// first place) is Task 4.
///
/// Refuses while *any* LLM generation (a summarize or an ask) is in flight
/// (a plain load of [`LlmBusy`], same cheap fast-path shape as
/// `summarize_note`'s own pre-check) — a regenerate overwrites the displayed
/// summary's `actionItems` array wholesale when it completes, and a toggle
/// that lands after that overwrite would patch the wrong item by index
/// against the new array. This is a conservative *global* check (busy from
/// generating anything, for any note, blocks toggling on every note), not
/// per-note, by design: `busy` has no note id (or flow) attached to it (see
/// [`LlmBusy`]'s docs), and the race it guards against is rare enough that
/// "toggling briefly blocked while an unrelated ask is answering" is an
/// acceptable trade for not threading note/flow-scoped busy tracking
/// through the store. The frontend's own checkbox-disable-while-running
/// (`AiNotesPanel`) is the primary defense for the common case; this is the
/// cheap backend backstop for anything that slips past it (a toggle already
/// in flight when Regenerate is clicked, a stale UI, ...).
#[tauri::command]
fn toggle_action_item(
    state: State<SharedStore>,
    busy: State<LlmBusy>,
    id: String,
    index: usize,
    done: bool,
) -> Result<SummaryDoc, String> {
    if let Some(msg) = toggle_action_item_blocked(busy.load(Ordering::SeqCst)) {
        return Err(msg.to_string());
    }
    lock_store(&state)
        .toggle_action_item(&id, index, done)
        .map_err(|e| e.to_string())
}

/// Whether `toggle_action_item` should refuse to run because an LLM
/// generation is in flight — see the command's docs for why this is a
/// conservative *global* (not per-note/per-flow) check. The message stays
/// honest about not knowing which flow is actually running (it could be an
/// ask, not a regenerate) rather than assuming "summary". Pure, mirroring
/// `download::delete_model_blocked`, so the guard is unit-testable without a
/// running Tauri app.
fn toggle_action_item_blocked(generating: bool) -> Option<&'static str> {
    if generating {
        return Some("the assistant is generating — try again in a moment");
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn abbreviate_home_replaces_the_home_prefix_with_a_tilde() {
        assert_eq!(
            abbreviate_home("/Users/sam/Library/App Support/dev.minute.app", Some("/Users/sam")),
            "~/Library/App Support/dev.minute.app"
        );
        assert_eq!(abbreviate_home("/Users/sam", Some("/Users/sam")), "~");
    }

    #[test]
    fn abbreviate_home_leaves_foreign_and_lookalike_paths_alone() {
        assert_eq!(abbreviate_home("/Volumes/T7/Minute", Some("/Users/sam")), "/Volumes/T7/Minute");
        // A sibling like /Users/samantha must not be truncated to ~antha.
        assert_eq!(
            abbreviate_home("/Users/samantha/Minute", Some("/Users/sam")),
            "/Users/samantha/Minute"
        );
        assert_eq!(abbreviate_home("/Users/sam/Minute", None), "/Users/sam/Minute");
    }

    #[test]
    fn toggle_action_item_blocked_while_generating() {
        assert_eq!(
            toggle_action_item_blocked(true),
            Some("the assistant is generating — try again in a moment")
        );
    }

    #[test]
    fn toggle_action_item_blocked_allows_when_not_generating() {
        assert_eq!(toggle_action_item_blocked(false), None);
    }
}

#[tauri::command]
fn delete_note(state: State<SharedStore>, id: String) -> Result<DeletedNoteUndo, String> {
    lock_store(&state)
        .delete_note(&id)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn restore_note(state: State<SharedStore>, undo: DeletedNoteUndo) -> Result<NoteMeta, String> {
    lock_store(&state)
        .restore_note(&undo)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_notes(
    state: State<SharedStore>,
    ids: Vec<String>,
) -> Result<Vec<DeletedNoteUndo>, String> {
    if ids.is_empty() {
        return Err("select at least one note to delete".to_string());
    }
    let store = lock_store(&state);
    let mut deleted = Vec::new();
    for id in ids {
        match store.delete_note(&id) {
            Ok(undo) => deleted.push(undo),
            Err(error) => {
                for undo in deleted.iter().rev() {
                    let _ = store.restore_note(undo);
                }
                return Err(error.to_string());
            }
        }
    }
    Ok(deleted)
}

#[tauri::command]
fn restore_notes(
    state: State<SharedStore>,
    undo: Vec<DeletedNoteUndo>,
) -> Result<Vec<NoteMeta>, String> {
    let store = lock_store(&state);
    undo.iter()
        .map(|token| store.restore_note(token).map_err(|error| error.to_string()))
        .collect()
}

#[tauri::command]
fn note_storage_stats(state: State<SharedStore>, id: String) -> Result<NoteStorageStats, String> {
    lock_store(&state)
        .note_storage_stats(&id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn delete_note_audio(state: State<SharedStore>, id: String) -> Result<NoteMeta, String> {
    lock_store(&state)
        .delete_note_audio(&id)
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn export_notes(state: State<SharedStore>, ids: Vec<String>) -> Result<String, String> {
    let path = lock_store(&state)
        .export_notes(&ids)
        .map_err(|error| error.to_string())?;
    reveal_path(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
fn export_diagnostics(state: State<SharedStore>) -> Result<String, String> {
    let path = lock_store(&state)
        .export_diagnostics(env!("CARGO_PKG_VERSION"))
        .map_err(|error| error.to_string())?;
    reveal_path(&path)?;
    Ok(path.to_string_lossy().into_owned())
}

fn reveal_path(path: &std::path::Path) -> Result<(), String> {
    std::process::Command::new("open")
        .arg("-R")
        .arg(path)
        .status()
        .map_err(|error| format!("failed to reveal {path:?}: {error}"))?;
    Ok(())
}

/// Reveals a note in Finder: its `audio.wav` if present, else the note's
/// directory itself (see `store::reveal_target`) — via `open -R`, same as
/// clicking "Reveal in Finder" on a file. Tolerant of the note directory (or
/// its audio) being missing in the sense that it doesn't special-case that
/// beforehand — `open -R` itself is left to fail on a nonexistent path, and
/// that failure is surfaced as the command's `Err` like any other.
#[tauri::command]
fn reveal_note(state: State<SharedStore>, id: String) -> Result<(), String> {
    let target = lock_store(&state).reveal_target(&id);
    reveal_path(&target)
}

/// Returns the current persisted settings.
#[tauri::command]
fn get_settings(state: State<SharedSettings>) -> Settings {
    settings::lock_settings(&state).clone()
}

/// Merges `patch` into the current settings (only the fields it sets are
/// changed — see `settings::apply_patch`), persists the result to
/// `settings.json`, and returns the updated settings. All the actual logic
/// (including keeping the shared in-memory settings consistent with disk if
/// the save fails) lives in `settings::apply_and_save` — this command is
/// just the thin AppHandle-resolving wrapper around it.
///
/// Also live-applies a `meetingDetection` change: once the patch is
/// persisted, `detect::set_enabled_live` starts the detector thread if it's
/// now `true` and nothing's running, or stops it (fully — see
/// `detect::stop`'s docs) if it's now `false`. Applied unconditionally on
/// every call (not just when the patch actually touched the field) —
/// idempotent either way, and simpler than tracking whether this particular
/// patch happened to include it.
#[tauri::command]
fn set_settings(
    app: AppHandle,
    state: State<SharedSettings>,
    detector: State<detect::SharedDetectorHandle>,
    recorder: State<audio::SharedRecorderState>,
    patch: SettingsPatch,
) -> Result<Settings, String> {
    let root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    let updated = settings::apply_and_save(&root, &state, patch).map_err(|e| e.to_string())?;
    detect::set_enabled_live(
        app,
        state.inner().clone(),
        recorder.inner().clone(),
        &detector,
        updated.meeting_detection,
    );
    Ok(updated)
}

#[tauri::command]
fn storage_stats(state: State<SharedStore>) -> Result<StorageStats, String> {
    // Clone the root path out from under a brief lock, then run the
    // (potentially slow, recursive) disk walk lock-free — see the docs on
    // `store::storage_stats`.
    let root = lock_store(&state).root().to_path_buf();
    store::storage_stats(&root).map_err(|e| e.to_string())
}

/// Where the notes library currently lives — the folder Settings → Storage
/// displays. `is_default` distinguishes "still in app data" from a
/// user-chosen folder, without the frontend having to know the app-data path.
/// `display_path` is the same location with the home directory abbreviated to
/// `~` — what the Settings row shows; `path` stays absolute for tooltips and
/// as the folder picker's starting location.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LibraryInfo {
    path: String,
    display_path: String,
    is_default: bool,
}

/// `/Users/sam/Library/…` → `~/Library/…`; a path outside the home directory
/// (or with no resolvable home) is returned unchanged.
fn abbreviate_home(path: &str, home: Option<&str>) -> String {
    match home {
        Some(home) if !home.is_empty() => match path.strip_prefix(home) {
            Some(rest) if rest.is_empty() => "~".to_string(),
            Some(rest) if rest.starts_with('/') => format!("~{rest}"),
            _ => path.to_string(),
        },
        _ => path.to_string(),
    }
}

#[tauri::command]
fn library_info(app: AppHandle, state: State<SharedStore>) -> Result<LibraryInfo, String> {
    let root = lock_store(&state).root().to_path_buf();
    let default_root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    let is_default = default_root
        .canonicalize()
        .map(|canonical| canonical == root)
        .unwrap_or(root == default_root);
    let path = root.to_string_lossy().into_owned();
    let home = std::env::var("HOME").ok();
    Ok(LibraryInfo {
        display_path: abbreviate_home(&path, home.as_deref()),
        path,
        is_default,
    })
}

/// Moves the notes library to `new_root` (a folder the user picked) and
/// persists the choice as `settings.libraryRoot` — see
/// `store::Store::move_library` for the on-disk semantics and guards.
/// Rejected outright while a recording is active: the recorder and STT
/// worker hold open file handles and note paths under the old root, and a
/// mid-recording move would strand them. The freshly allowed asset-protocol
/// scope is what keeps audio playback working from the new location without
/// a restart; the `$APPDATA/notes/**` scope from `tauri.conf.json` covers
/// the default location only.
#[tauri::command]
fn move_library(
    app: AppHandle,
    state: State<SharedStore>,
    settings: State<SharedSettings>,
    recorder: State<audio::SharedRecorderState>,
    new_root: String,
) -> Result<LibraryInfo, String> {
    if audio::is_recording_active(&recorder) {
        return Err("stop the current recording before moving the library".to_string());
    }

    let new_root = PathBuf::from(new_root);
    {
        let mut store = lock_store(&state);
        store.move_library(new_root).map_err(|e| e.to_string())?;

        let moved_root = store.root().to_path_buf();
        // Persist while still holding the store lock, so a concurrent second
        // move can't interleave between the move and the save. Settings live
        // at the app-data root (not the library root) — the app must be able
        // to find the library before it has found the library.
        let app_data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
        let mut settings = settings::lock_settings(&settings);
        settings.library_root = Some(moved_root.to_string_lossy().into_owned());
        settings::save_settings(&app_data_dir, &settings).map_err(|e| e.to_string())?;

        app.asset_protocol_scope()
            .allow_directory(moved_root.join("notes"), true)
            .map_err(|e| format!("failed to allow the new library in the asset scope: {e}"))?;
    }

    library_info(app, state)
}

/// Best-effort recording finalize on app close/exit. If a recording is
/// still active — the user quit (⌘Q / red-button close) instead of
/// clicking "Stop & transcribe" — this runs the exact same stop path
/// `stop_recording` uses directly against the managed state (stop the
/// recorder, finalizing `audio.wav`; join the `SttWorker` thread, flushing
/// its tail window; finalize the note) so the note never gets left behind
/// on disk permanently stuck at status `"recording"`.
///
/// Deliberately synchronous and simple: `stop_recording` itself is a plain
/// (non-async) command, so calling it here just blocks the event-loop
/// thread for as long as the stop actually takes — normally a second or
/// two for the tail-window flush, matching `stop_recording`'s own docs.
/// Both `WindowEvent::CloseRequested` and `RunEvent::ExitRequested` call
/// this below; it's safe to call from both (and safe to call when nothing
/// is recording) because `stop_recording`'s first step atomically takes the
/// single active-recording slot out of `RecorderState` — a second call (or
/// a call with nothing active) just sees `None` and returns its ordinary
/// "no active recording" error, which is swallowed here without logging.
fn finalize_active_recording_on_exit(app: &AppHandle) {
    let store = app.state::<SharedStore>();
    let recorder = app.state::<audio::SharedRecorderState>();
    let settings = app.state::<SharedSettings>();
    let engine = app.state::<SharedLlmEngine>();
    let llm_busy = app.state::<LlmBusy>();
    match audio::stop_recording(app.clone(), store, recorder, settings, engine, llm_busy) {
        Ok(meta) => log::info!("finalized in-progress recording {} on app close", meta.id),
        Err(e) if e == "no active recording" => {}
        Err(e) => log::warn!("failed to finalize in-progress recording on app close: {e}"),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();
    // The `tauri-nspanel` plugin (Stage 5 Task 2) only exists as a macOS
    // target dependency (see Cargo.toml) — registering it unconditionally
    // wouldn't even compile on another target, so this whole plugin
    // registration is cfg-gated the same way `detect.rs`'s macOS-only shim
    // module is. `popup::show_meeting_prompt`'s own `#[cfg(not(target_os =
    // "macos"))]` stub never actually calls into any of this on other
    // platforms either way.
    #[cfg(target_os = "macos")]
    let builder = builder.plugin(tauri_nspanel::init());
    let builder = builder.plugin(tauri_plugin_dialog::init());

    let app = builder
        .invoke_handler(tauri::generate_handler![
            hardware_info,
            list_models,
            recommended_models,
            list_notes,
            get_note,
            search_notes,
            rename_note,
            set_note_pinned,
            add_note_marker,
            update_note_marker,
            delete_note_marker,
            rename_speaker,
            merge_speakers,
            undo_speaker_merge,
            toggle_action_item,
            llm::summarize_note,
            llm::ask_note,
            delete_note,
            restore_note,
            delete_notes,
            restore_notes,
            note_storage_stats,
            library_info,
            move_library,
            delete_note_audio,
            export_notes,
            export_diagnostics,
            storage_stats,
            reveal_note,
            get_settings,
            set_settings,
            download::download_model,
            download::cancel_download,
            download::delete_model,
            audio::audio_input_status,
            audio::request_microphone_permission,
            audio::start_audio_input_preview,
            audio::stop_audio_input_preview,
            audio::start_recording,
            audio::pause_recording,
            audio::resume_recording,
            audio::stop_recording,
            popup::popup_start,
            popup::popup_dismiss,
            syscap::sys_audio_status,
            syscap::request_sys_audio_permission
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            let app_data_dir = app
                .path()
                .app_data_dir()
                .expect("failed to resolve app data dir");

            // Loaded once here (from `settings.json`, defaults if missing/corrupt
            // — see `settings::load_settings`) and shared the same way as every
            // other managed handle below; `start_recording` reads `sttModel` off
            // this to resolve a default model when the frontend doesn't pass one
            // explicitly.
            let shared_settings: SharedSettings = settings::open_shared(&app_data_dir);
            // Read before `shared_settings` is moved into `app.manage` below —
            // this is the one-shot decision the background sweep thread further
            // down needs; it doesn't hold onto `shared_settings` itself (a toggle
            // flipped after launch only affects the *next* launch's sweep, not a
            // currently-running one).
            let sweep_enabled = settings::lock_settings(&shared_settings).delete_audio_after_30d;
            // Same one-shot read for the meeting detector below — unlike the
            // sweep flag, a later toggle *does* keep working live (via
            // `set_settings` -> `detect::set_enabled_live`), so this only decides
            // whether a detector thread starts at launch, not for the rest of the
            // session.
            let meeting_detection_enabled =
                settings::lock_settings(&shared_settings).meeting_detection;
            // A clone kept for the detector thread further down (see
            // `detect::start`'s call site) — `shared_settings` itself moves into
            // `app.manage` on the very next line.
            let detector_settings = shared_settings.clone();
            app.manage(shared_settings);

            // A single shared handle: Tauri commands and the recording/
            // transcription worker threads (Task 5/6) all clone this same
            // `SharedStore` rather than each opening their own `Store` — see the
            // concurrency contract on `store::Store`. `open_shared` is the only
            // way to obtain one; `Store::new` itself is private to `store.rs`.
            //
            // The store roots at `settings.libraryRoot` when the user has moved
            // the library (see the `move_library` command); a persisted folder
            // that no longer exists (unplugged disk, deleted folder) falls back
            // to the default app-data root rather than failing startup — the
            // library isn't lost, it's just wherever the folder went, and the
            // user can re-point Settings once it's back.
            let library_root = settings::lock_settings(
                app.state::<SharedSettings>().inner(),
            )
            .library_root
            .clone()
            .map(PathBuf::from)
            .filter(|root| root.is_dir());
            let store_root = library_root.unwrap_or_else(|| app_data_dir.clone());
            if store_root != app_data_dir {
                // The static `$APPDATA/notes/**` asset scope from
                // tauri.conf.json doesn't cover a custom library — allow it
                // here or audio playback silently 404s after a restart.
                app.asset_protocol_scope()
                    .allow_directory(store_root.join("notes"), true)?;
            }
            let shared_store: SharedStore = store::open_shared(store_root);

            // 30-day audio sweep (Task 3): if the user has opted into
            // `deleteAudioAfter30d`, walk the note library once at launch and
            // delete `audio.wav` for anything `store::sweep_candidates` selects —
            // see that function's docs for the exact eligibility rule
            // (createdAt strictly >30 days old, status ready/transcribed, not
            // already swept). Runs on a detached background thread — never the
            // Tauri event-loop thread — so a large library's directory walk never
            // delays startup. Deliberately fire-and-forget: no event is emitted,
            // nothing in the UI waits on it; the next `get_note`/`list_notes` a
            // screen happens to make just reflects whatever the sweep has
            // finished by then. `log::info!` reports the swept count for
            // visibility; a failure (e.g. the notes dir vanished) is
            // `log::warn!`'d rather than surfaced to the user — this is
            // best-effort housekeeping, not a user-facing operation.
            if sweep_enabled {
                let sweep_store = shared_store.clone();
                std::thread::spawn(move || {
                    match lock_store(&sweep_store).run_audio_sweep(time::OffsetDateTime::now_utc())
                    {
                        Ok(count) => {
                            log::info!("audio sweep: deleted audio.wav for {count} note(s)")
                        }
                        Err(e) => log::warn!("audio sweep failed: {e}"),
                    }
                });
            }

            app.manage(shared_store);

            // Managed state guarding the single loaded summarization LLM — see
            // `llm::SharedLlmEngine`.
            let llm_engine: SharedLlmEngine = llm::open_shared();
            app.manage(llm_engine.clone());

            // Single-generation-at-a-time gate, app-wide (a summarize and an ask
            // share it — see `llm::LlmBusy`'s docs), deliberately a separate
            // atomic from `llm_engine`'s mutex (see `llm::LlmEngineState`'s
            // concurrency note) — checking or claiming it never blocks on a
            // long-running generation.
            let llm_busy: LlmBusy = llm::open_busy_flag();
            app.manage(llm_busy.clone());

            // Idle-unload janitor (Stage 4 Task 7): a detached thread that drops
            // the loaded LLM after `llm::IDLE_UNLOAD_AFTER` of inactivity, freeing
            // its ~2.6 GB until the next `summarize_note`/`ask_note` transparently
            // reloads it — see `llm::spawn_janitor`/`llm::janitor_pass`. Takes the
            // original `llm_engine`/`llm_busy` handles (never joined, same
            // fire-and-forget shape as the audio sweep thread above); the clones
            // `app.manage`d just above are what the rest of the app (commands,
            // `finalize_active_recording_on_exit`) resolves via `State`/`app.state`.
            llm::spawn_janitor(llm_engine, llm_busy);

            // Tracks in-flight model downloads so `cancel_download` can signal
            // them and `list_models` can report `Downloading` state — see
            // `download::DownloadRegistry`.
            let download_registry: DownloadRegistry = download::open_registry();
            app.manage(download_registry);

            // Tracks the single in-progress recording (if any) so pause/resume/
            // stop commands can reach the active `Recorder` — see
            // `audio::SharedRecorderState`. Minute's own mic usage is exactly
            // what the meeting detector below must *not* mistake for someone
            // else's call — see `detect::DetectorCore`'s `!minute_recording` term.
            let recorder_state: audio::SharedRecorderState = audio::open_shared();
            app.manage(recorder_state.clone());

            // The preflight's read-only microphone meter has its own short-lived
            // cpal stream, separate from the recorder. `start_recording` drops it
            // before opening final capture so the same input is never owned twice.
            let input_preview: audio::SharedInputPreview = audio::open_input_preview();
            app.manage(input_preview);

            // Managed state for Stage 5 Task 1's meeting detector — see
            // `detect::DetectorHandle`'s docs. Empty (no thread) until started
            // just below (if enabled at launch) or later via `set_settings`
            // toggling `meetingDetection` live.
            // Note: unlike the recorder, there's no matching `detect::stop` call
            // anywhere in this file's app-exit handling — the detector thread (if
            // running) is never explicitly joined on quit. That's a deliberate
            // reliance on process teardown rather than an oversight: quitting
            // ends the process, which drops the `MicMonitor` (removing both
            // CoreAudio property listeners) same as any other thread-local
            // resource; and even short of that, CoreAudio's HAL itself cleans up
            // listeners registered by a client process that has gone away. There
            // is no in-progress work here (unlike `finalize_active_recording_on_exit`,
            // which exists precisely because a recording *does* have state to
            // flush) that would make an unclean detector-thread exit lossy.
            let detector_handle: detect::SharedDetectorHandle = detect::open_shared();
            app.manage(detector_handle.clone());
            if meeting_detection_enabled {
                detect::start(
                    app.handle().clone(),
                    detector_settings,
                    recorder_state,
                    &detector_handle,
                );
            }

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(|app_handle, event| match event {
        tauri::RunEvent::WindowEvent {
            event: tauri::WindowEvent::CloseRequested { .. },
            ..
        } => finalize_active_recording_on_exit(app_handle),
        tauri::RunEvent::ExitRequested { .. } => finalize_active_recording_on_exit(app_handle),
        _ => {}
    });
}

/// Proof that the app-level ACL manifest (`build.rs`'s `APP_COMMANDS` +
/// `capabilities/{default,popup}.json`) actually scopes commands per
/// window — not the crate's hand-written *source* JSON (asserting on that
/// directly would just be restating it), but `tauri-build`'s own
/// **resolved** output: `capabilities.json`, written to `OUT_DIR` by
/// `build.rs` on every build (see that file's `save_capabilities`/`build`
/// functions), the exact same artifact `tauri::generate_context!()` embeds
/// into the real app at compile time. Read here via `include_str!` off
/// `env!("OUT_DIR")` — this crate's own `OUT_DIR`, since this test lives in
/// the same crate the build script ran for.
///
/// (An earlier version of this test tried to go one step further — actually
/// dispatching a mock IPC call via `tauri::test::get_ipc_response` against
/// a `tauri::test::MockRuntime` app built from this same
/// `generate_context!()`, to prove denial at the real dispatch layer, not
/// just in the resolved config. That doesn't work: `generate_context!()`
/// embeds a process-global `_EMBED_INFO_PLIST` symbol at macro-expansion
/// time, and `run()`'s own call above already puts one copy of that symbol
/// into every compilation of this crate, including its `--lib` unit-test
/// binary — a second invocation in a test module is a hard link error
/// ("symbol already defined"), not just a logical duplicate, and there's no
/// way to keep `run()`'s copy out of the test binary without making a large
/// fraction of the crate's own production code look unused to `cargo
/// clippy --all-targets` (confirmed: gating `run()` behind
/// `#[cfg(not(test))]` fixes the link error but produces dozens of
/// "function/struct is never used" warnings crate-wide, since `run()` is
/// what wires almost everything else together). Reading the resolved
/// `capabilities.json` instead sidesteps that limitation entirely while
/// still exercising real `tauri-build` output rather than restating the
/// source files.)
///
/// `tauri-build`'s own `validate_capabilities` step (which runs — and would
/// hard-fail the whole build — on every `cargo build`/`test`/`clippy`
/// already proves every permission identifier referenced below actually
/// exists among the generated per-command `allow-*`/`deny-*` permissions;
/// what these assertions add on top is that the *shape* of each capability
/// (which window it's scoped to, which permissions it grants) is exactly
/// what least-privilege requires, not accidentally broader.
#[cfg(test)]
mod acl_tests {
    use serde_json::Value;

    fn resolved_capabilities() -> Value {
        let raw = include_str!(concat!(env!("OUT_DIR"), "/capabilities.json"));
        serde_json::from_str(raw).expect("OUT_DIR/capabilities.json should be valid JSON")
    }

    fn permissions_of(capability: &Value) -> Vec<&str> {
        capability["permissions"]
            .as_array()
            .expect("permissions should be an array")
            .iter()
            .map(|p| {
                p.as_str()
                    .expect("each permission entry should be a plain string identifier")
            })
            .collect()
    }

    fn windows_of(capability: &Value) -> Vec<&str> {
        capability["windows"]
            .as_array()
            .expect("windows should be an array")
            .iter()
            .map(|w| {
                w.as_str()
                    .expect("each window entry should be a plain string label")
            })
            .collect()
    }

    #[test]
    fn the_popup_capability_is_scoped_to_only_the_meeting_popup_window() {
        let capabilities = resolved_capabilities();
        let popup = &capabilities["popup"];
        assert_eq!(windows_of(popup), vec!["meeting-popup"]);
    }

    #[test]
    fn the_popup_capability_grants_exactly_its_own_two_commands_plus_core_event() {
        let capabilities = resolved_capabilities();
        let popup = &capabilities["popup"];
        let mut permissions = permissions_of(popup);
        permissions.sort_unstable();
        assert_eq!(
      permissions,
      vec!["allow-popup-dismiss", "allow-popup-start", "core:event:default"],
      "the popup window's capability must grant nothing beyond its own two commands and core event listening"
    );
    }

    #[test]
    fn the_default_capability_is_scoped_to_only_the_main_window() {
        let capabilities = resolved_capabilities();
        let default = &capabilities["default"];
        assert_eq!(
      windows_of(default),
      vec!["main"],
      "the main window's capability must not also cover meeting-popup — that's exactly the bug this whole fix closes"
    );
    }

    #[test]
    fn the_popup_capability_does_not_grant_the_sys_audio_commands() {
        // Stage 5 Task 4: `sys_audio_status`/`request_sys_audio_permission` are
        // main-window-only (Task 5 wires the settings toggle there) — the
        // meeting-popup pill has no business querying or requesting Screen
        // Recording permission.
        let capabilities = resolved_capabilities();
        let popup = &capabilities["popup"];
        let permissions = permissions_of(popup);
        assert!(
      !permissions.contains(&"allow-sys-audio-status")
        && !permissions.contains(&"allow-request-sys-audio-permission"),
      "the popup window has no business calling the sys-audio commands — got: {permissions:?}"
    );
    }

    #[test]
    fn the_default_capability_does_not_grant_the_popups_own_commands() {
        let capabilities = resolved_capabilities();
        let default = &capabilities["default"];
        let permissions = permissions_of(default);
        assert!(
      !permissions.contains(&"allow-popup-start") && !permissions.contains(&"allow-popup-dismiss"),
      "the main window has no business calling popup_start/popup_dismiss — got: {permissions:?}"
    );
    }

    #[test]
    fn the_default_capability_still_grants_every_command_the_main_frontend_actually_calls() {
        // A regression guard the other direction: tightening this ACL must not
        // have silently dropped a command the real main-window frontend (see
        // src/ipc/commands.ts) still needs — every one of these missing would
        // break a real feature (settings, notes, recording, ...), not just a
        // permissions test.
        let capabilities = resolved_capabilities();
        let default = &capabilities["default"];
        let permissions = permissions_of(default);
        for expected in [
            "allow-hardware-info",
            "allow-list-models",
            "allow-recommended-models",
            "allow-list-notes",
            "allow-get-note",
            "allow-search-notes",
            "allow-rename-note",
            "allow-toggle-action-item",
            "allow-summarize-note",
            "allow-ask-note",
            "allow-delete-note",
            "allow-restore-note",
            "allow-delete-notes",
            "allow-restore-notes",
            "allow-note-storage-stats",
            "allow-delete-note-audio",
            "allow-export-notes",
            "allow-export-diagnostics",
            "allow-set-note-pinned",
            "allow-add-note-marker",
            "allow-update-note-marker",
            "allow-delete-note-marker",
            "allow-rename-speaker",
            "allow-merge-speakers",
            "allow-undo-speaker-merge",
            "allow-storage-stats",
            "allow-reveal-note",
            "allow-get-settings",
            "allow-set-settings",
            "allow-download-model",
            "allow-cancel-download",
            "allow-delete-model",
            "allow-start-recording",
            "allow-pause-recording",
            "allow-resume-recording",
            "allow-stop-recording",
            "allow-sys-audio-status",
            "allow-request-sys-audio-permission",
        ] {
            assert!(
        permissions.contains(&expected),
        "main window is missing {expected} — this would break a real feature, not just a test"
      );
        }
    }

    /// The generated per-command permission's own `commands.allow` list
    /// (under `permissions/autogenerated/`, produced by `build.rs`'s
    /// `APP_COMMANDS`) — proves `allow-popup-start`/`allow-popup-dismiss`
    /// themselves are scoped to exactly `["popup_start"]`/`["popup_dismiss"]`
    /// and nothing broader, i.e. that even the *permission identifiers*
    /// granted to the popup window can't be walked to reach some other
    /// command.
    #[test]
    fn the_autogenerated_popup_permissions_allow_exactly_their_own_command() {
        let start_toml = include_str!("../permissions/autogenerated/popup_start.toml");
        assert!(start_toml.contains(r#"commands.allow = ["popup_start"]"#));
        let dismiss_toml = include_str!("../permissions/autogenerated/popup_dismiss.toml");
        assert!(dismiss_toml.contains(r#"commands.allow = ["popup_dismiss"]"#));
    }
}
