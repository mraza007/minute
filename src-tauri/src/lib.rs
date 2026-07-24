mod catalog;
mod store;
mod audio;
mod stt;
mod download;
mod error;
mod llm;
mod settings;

use catalog::{Hardware, InstallState, ModelStatus, Recommendation};
use download::DownloadRegistry;
use llm::{SharedLlmEngine, SummarizeBusy, SummaryDoc};
use settings::{Settings, SettingsPatch, SharedSettings};
use std::sync::atomic::Ordering;
use store::{lock_store, render_note_md, NoteMeta, SharedStore, StorageStats, Transcript};
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
/// a named object for the frontend. `summary` is the note's persisted
/// summary if one exists (`None` for a note that hasn't been summarized
/// yet); `markdown` is `store::render_note_md`'s output for the same
/// meta/transcript/summary, rendered fresh on every read rather than read
/// back off `note.md` — the file and this field are two renderings of the
/// same source of truth, not two sources of truth.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct NoteWithTranscript {
  meta: NoteMeta,
  transcript: Transcript,
  summary: Option<SummaryDoc>,
  markdown: String,
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
  Ok(NoteWithTranscript { meta, transcript, summary, markdown })
}

#[tauri::command]
fn rename_note(state: State<SharedStore>, id: String, title: String) -> Result<NoteMeta, String> {
  lock_store(&state)
    .rename_note(&id, &title)
    .map_err(|e| e.to_string())
}

/// Toggles one action item's `done` state in a note's summary — read-
/// modify-write of `summary.json` under the store's mutex (see
/// `store::Store::toggle_action_item`), also re-rendering `note.md`.
/// `summarize_note` itself (the command that produces the summary in the
/// first place) is Task 4.
///
/// Refuses while *any* summarization is in flight (a plain load of
/// [`SummarizeBusy`], same cheap fast-path shape as `summarize_note`'s own
/// pre-check) — a regenerate overwrites the displayed summary's
/// `actionItems` array wholesale when it completes, and a toggle that lands
/// after that overwrite would patch the wrong item by index against the new
/// array. This is a conservative *global* check (busy from summarizing any
/// note blocks toggling on every note), not per-note, by design: `busy` has
/// no note id attached to it (see [`SummarizeBusy`]'s docs), and the race it
/// guards against is rare enough that "toggling on some other note briefly
/// blocked" is an acceptable trade for not threading note-scoped busy
/// tracking through the store. The frontend's own checkbox-disable-while-
/// running (`AiNotesPanel`) is the primary defense for the common case; this
/// is the cheap backend backstop for anything that slips past it (a toggle
/// already in flight when Regenerate is clicked, a stale UI, ...).
#[tauri::command]
fn toggle_action_item(
  state: State<SharedStore>,
  busy: State<SummarizeBusy>,
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

/// Whether `toggle_action_item` should refuse to run because a
/// summarization is in flight — see the command's docs for why this is a
/// conservative *global* (not per-note) check. Pure, mirroring
/// `download::delete_model_blocked`, so the guard is unit-testable without a
/// running Tauri app.
fn toggle_action_item_blocked(summarizing: bool) -> Option<&'static str> {
  if summarizing {
    return Some("summary is being regenerated");
  }
  None
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn toggle_action_item_blocked_while_summarizing() {
    assert_eq!(
      toggle_action_item_blocked(true),
      Some("summary is being regenerated")
    );
  }

  #[test]
  fn toggle_action_item_blocked_allows_when_not_summarizing() {
    assert_eq!(toggle_action_item_blocked(false), None);
  }
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
#[tauri::command]
fn set_settings(
  app: AppHandle,
  state: State<SharedSettings>,
  patch: SettingsPatch,
) -> Result<Settings, String> {
  let root = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
  settings::apply_and_save(&root, &state, patch).map_err(|e| e.to_string())
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
  let settings = app.state::<SharedSettings>();
  let engine = app.state::<SharedLlmEngine>();
  let summarize_busy = app.state::<SummarizeBusy>();
  match audio::stop_recording(app.clone(), store, recorder, settings, engine, summarize_busy) {
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
      toggle_action_item,
      llm::summarize_note,
      delete_note,
      storage_stats,
      reveal_note,
      get_settings,
      set_settings,
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

      // Loaded once here (from `settings.json`, defaults if missing/corrupt
      // — see `settings::load_settings`) and shared the same way as every
      // other managed handle below; `start_recording` reads `sttModel` off
      // this to resolve a default model when the frontend doesn't pass one
      // explicitly.
      let shared_settings: SharedSettings = settings::open_shared(&app_data_dir);
      app.manage(shared_settings);

      // A single shared handle: Tauri commands and the recording/
      // transcription worker threads (Task 5/6) all clone this same
      // `SharedStore` rather than each opening their own `Store` — see the
      // concurrency contract on `store::Store`. `open_shared` is the only
      // way to obtain one; `Store::new` itself is private to `store.rs`.
      let shared_store: SharedStore = store::open_shared(app_data_dir);
      app.manage(shared_store);

      // Managed state guarding the single loaded summarization LLM — see
      // `llm::SharedLlmEngine`.
      let llm_engine: SharedLlmEngine = llm::open_shared();
      app.manage(llm_engine);

      // Single-summarization-at-a-time gate, deliberately a separate atomic
      // from `llm_engine`'s mutex (see `llm::LlmEngineState`'s concurrency
      // note) — checking or claiming it never blocks on a long-running
      // generation.
      let summarize_busy: SummarizeBusy = llm::open_busy_flag();
      app.manage(summarize_busy);

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
