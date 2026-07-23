#[allow(dead_code)]
mod catalog;
#[allow(dead_code)]
mod store;
#[allow(dead_code)]
mod audio;
#[allow(dead_code)]
mod stt;
#[allow(dead_code)]
mod error;

use catalog::{Hardware, ModelStatus};
use tauri::{AppHandle, Manager};

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .invoke_handler(tauri::generate_handler![hardware_info, list_models])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
