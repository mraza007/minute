mod catalog;
mod store;
mod audio;
mod stt;
mod download;
mod error;

use catalog::{Hardware, InstallState, ModelStatus, Recommendation};
use download::DownloadRegistry;
use store::{lock_store, NoteMeta, SharedStore, StorageStats, Transcript};
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
  Ok(
    entries
      .into_iter()
      .map(|entry| {
        let state = if download::registry_is_active(&registry, &entry.id) {
          InstallState::Downloading
        } else {
          catalog::install_state(&entry, &models_root)
        };
        ModelStatus { entry, state }
      })
      .collect(),
  )
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
/// a named object for the frontend.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteWithTranscript {
  meta: NoteMeta,
  transcript: Transcript,
}

#[tauri::command]
fn list_notes(state: State<SharedStore>) -> Result<Vec<NoteMeta>, String> {
  lock_store(&state).list_notes().map_err(|e| e.to_string())
}

#[tauri::command]
fn get_note(state: State<SharedStore>, id: String) -> Result<NoteWithTranscript, String> {
  let (meta, transcript) = lock_store(&state).get_note(&id).map_err(|e| e.to_string())?;
  Ok(NoteWithTranscript { meta, transcript })
}

#[tauri::command]
fn rename_note(state: State<SharedStore>, id: String, title: String) -> Result<NoteMeta, String> {
  lock_store(&state)
    .rename_note(&id, &title)
    .map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_note(state: State<SharedStore>, id: String) -> Result<(), String> {
  lock_store(&state).delete_note(&id).map_err(|e| e.to_string())
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
  std::process::Command::new("open")
    .arg("-R")
    .arg(&target)
    .status()
    .map_err(|e| format!("failed to reveal {target:?}: {e}"))?;
  Ok(())
}

#[tauri::command]
fn storage_stats(state: State<SharedStore>) -> Result<StorageStats, String> {
  // Clone the root path out from under a brief lock, then run the
  // (potentially slow, recursive) disk walk lock-free — see the docs on
  // `store::storage_stats`.
  let root = lock_store(&state).root().to_path_buf();
  store::storage_stats(&root).map_err(|e| e.to_string())
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
  match audio::stop_recording(app.clone(), store, recorder) {
    Ok(meta) => log::info!("finalized in-progress recording {} on app close", meta.id),
    Err(e) if e == "no active recording" => {}
    Err(e) => log::warn!("failed to finalize in-progress recording on app close: {e}"),
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  let app = tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      hardware_info,
      list_models,
      recommended_models,
      list_notes,
      get_note,
      rename_note,
      delete_note,
      storage_stats,
      reveal_note,
      download::download_model,
      download::cancel_download,
      download::delete_model,
      audio::start_recording,
      audio::pause_recording,
      audio::resume_recording,
      audio::stop_recording
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
      // A single shared handle: Tauri commands and the recording/
      // transcription worker threads (Task 5/6) all clone this same
      // `SharedStore` rather than each opening their own `Store` — see the
      // concurrency contract on `store::Store`. `open_shared` is the only
      // way to obtain one; `Store::new` itself is private to `store.rs`.
      let shared_store: SharedStore = store::open_shared(app_data_dir);
      app.manage(shared_store);

      // Tracks in-flight model downloads so `cancel_download` can signal
      // them and `list_models` can report `Downloading` state — see
      // `download::DownloadRegistry`.
      let download_registry: DownloadRegistry = download::open_registry();
      app.manage(download_registry);

      // Tracks the single in-progress recording (if any) so pause/resume/
      // stop commands can reach the active `Recorder` — see
      // `audio::SharedRecorderState`.
      let recorder_state: audio::SharedRecorderState = audio::open_shared();
      app.manage(recorder_state);

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
