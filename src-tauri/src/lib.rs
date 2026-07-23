mod catalog;
// create_note/finalize_note/write_transcript/append_segment/create_note_now
// aren't called yet — Task 5 (audio.rs) drives note creation/finalization
// during recording, and Task 6 (stt.rs) drives segment appends. Keep the
// module-level allow until those callers land, matching audio/stt below.
#[allow(dead_code)]
mod store;
#[allow(dead_code)]
mod audio;
#[allow(dead_code)]
mod stt;
mod error;

use catalog::{Hardware, ModelStatus, Recommendation};
use store::{lock_store, NoteMeta, SharedStore, StorageStats, Transcript};
use tauri::{AppHandle, Manager, State};

#[tauri::command]
fn hardware_info() -> Hardware {
  catalog::detect_hardware()
}

#[tauri::command]
fn list_models(app: AppHandle) -> Result<Vec<ModelStatus>, String> {
  let models_root = app
    .path()
    .app_data_dir()
    .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
  let entries = catalog::load_catalog().map_err(|e| e.to_string())?;
  Ok(
    entries
      .into_iter()
      .map(|entry| {
        let state = catalog::install_state(&entry, &models_root);
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

#[tauri::command]
fn storage_stats(state: State<SharedStore>) -> Result<StorageStats, String> {
  // Clone the root path out from under a brief lock, then run the
  // (potentially slow, recursive) disk walk lock-free — see the docs on
  // `store::storage_stats`.
  let root = lock_store(&state).root().to_path_buf();
  store::storage_stats(&root).map_err(|e| e.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![
      hardware_info,
      list_models,
      recommended_models,
      list_notes,
      get_note,
      rename_note,
      delete_note,
      storage_stats
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

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
