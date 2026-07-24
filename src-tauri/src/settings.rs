//! Persisted app settings (`settings.json`, at the app-data root): model
//! selections and the two storage/privacy toggles. Same folder-store shape
//! as `store.rs`'s note metadata — atomic writes (tmp + rename), tolerant
//! reads (missing/corrupt file degrades to defaults rather than failing the
//! app), and a poison-tolerant `Arc<Mutex<_>>` managed handle.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use serde::{Deserialize, Serialize};

use crate::error::{MinuteError, Result};

const SETTINGS_FILE: &str = "settings.json";
const SETTINGS_TMP_FILE: &str = "settings.json.tmp";

/// Persisted settings, stored as `<app-data-root>/settings.json`.
///
/// `sttModel`/`llmModel` are `None` until the user (or onboarding) actually
/// makes a selection — `None` is a real, meaningful "no explicit selection
/// yet" state, distinct from any particular catalog id, so callers that need
/// a concrete model (e.g. `start_recording`) fall back to a hardcoded
/// default themselves rather than this module inventing one.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub stt_model: Option<String>,
    pub llm_model: Option<String>,
    pub delete_audio_after_30d: bool,
    pub encrypt_library: bool,
}

impl Default for Settings {
    /// Matches the Stage 1 mock's initial toggle states: delete-after-30d
    /// on, encryption off, no model selected yet.
    fn default() -> Self {
        Self {
            stt_model: None,
            llm_model: None,
            delete_audio_after_30d: true,
            encrypt_library: false,
        }
    }
}

/// A partial update to [`Settings`]: every field is `Option<T>`, where
/// `None` means "leave this field unchanged" (not "clear it"). Applying a
/// patch can therefore only ever *set* `sttModel`/`llmModel` to `Some` id,
/// never reset one back to `None` — a double-`Option` (`Option<Option<T>>`)
/// would be needed to distinguish "leave unchanged" from "explicitly
/// clear", but there's no UX today that clears a model selection (Settings
/// only ever lets you pick a different installed model), so the simpler
/// single-`Option` shape is deliberate, not an oversight.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsPatch {
    pub stt_model: Option<String>,
    pub llm_model: Option<String>,
    pub delete_audio_after_30d: Option<bool>,
    pub encrypt_library: Option<bool>,
}

/// Merges `patch` into `settings` in place — only fields present (`Some`) in
/// the patch overwrite the corresponding field; everything else is left as
/// it was.
pub fn apply_patch(settings: &mut Settings, patch: SettingsPatch) {
    if let Some(v) = patch.stt_model {
        settings.stt_model = Some(v);
    }
    if let Some(v) = patch.llm_model {
        settings.llm_model = Some(v);
    }
    if let Some(v) = patch.delete_audio_after_30d {
        settings.delete_audio_after_30d = v;
    }
    if let Some(v) = patch.encrypt_library {
        settings.encrypt_library = v;
    }
}

fn settings_path(root: &Path) -> PathBuf {
    root.join(SETTINGS_FILE)
}

fn settings_tmp_path(root: &Path) -> PathBuf {
    root.join(SETTINGS_TMP_FILE)
}

/// Loads settings from `<root>/settings.json`. A missing file (first launch)
/// or a corrupt/unparseable one both degrade to [`Settings::default`] rather
/// than failing app startup — a corrupt file is logged via `log::warn!` so
/// it's visible without being fatal.
pub fn load_settings(root: &Path) -> Settings {
    let raw = match fs::read_to_string(settings_path(root)) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Settings::default(),
        Err(e) => {
            log::warn!("failed to read settings.json ({e}); using defaults");
            return Settings::default();
        }
    };

    match serde_json::from_str(&raw) {
        Ok(settings) => settings,
        Err(e) => {
            log::warn!("failed to parse settings.json ({e}); using defaults");
            Settings::default()
        }
    }
}

/// Atomically writes `settings` to `<root>/settings.json` (write to `.tmp`,
/// then rename over the final path) — same pattern as
/// `store::Store::write_transcript`, so readers never observe a partially
/// written file. Creates `root` if it doesn't exist yet.
pub fn save_settings(root: &Path, settings: &Settings) -> Result<()> {
    fs::create_dir_all(root)?;
    let json = serde_json::to_string_pretty(settings)
        .map_err(|e| MinuteError::Other(format!("failed to serialize settings.json: {e}")))?;
    let tmp_path = settings_tmp_path(root);
    fs::write(&tmp_path, json)?;
    fs::rename(&tmp_path, settings_path(root))?;
    Ok(())
}

/// Resolves the STT model id to use for a new recording: the caller-supplied
/// `explicit` id (the frontend may still pass one directly) if given, else
/// the persisted `Settings::sttModel`, else the hardcoded fallback
/// `"whisper-small"`. Pure and free-standing so it's unit-testable without
/// touching the filesystem or a real `start_recording` call.
pub fn resolve_stt_model(explicit: Option<String>, settings: &Settings) -> String {
    explicit
        .or_else(|| settings.stt_model.clone())
        .unwrap_or_else(|| "whisper-small".to_string())
}

/// Shared handle to [`Settings`] — an `Arc<Mutex<Settings>>`. Same shape as
/// `store::SharedStore`/`audio::SharedRecorderState`: Tauri commands (and
/// `audio::start_recording`, which reads `sttModel` to resolve a default)
/// all hold clones of one shared handle rather than each reading the file
/// themselves.
pub type SharedSettings = Arc<Mutex<Settings>>;

/// Locks a [`SharedSettings`], recovering from lock poisoning instead of
/// propagating it — same rationale as `store::lock_store`.
pub fn lock_settings(state: &SharedSettings) -> MutexGuard<'_, Settings> {
    state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Loads settings from `root` once and hands them back already wrapped as a
/// [`SharedSettings`] — called once from `lib.rs`'s `setup`, mirroring
/// `store::open_shared`.
pub(crate) fn open_shared(root: &Path) -> SharedSettings {
    Arc::new(Mutex::new(load_settings(root)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn default_settings_matches_the_mocks_initial_toggle_states() {
        let settings = Settings::default();
        assert_eq!(settings.stt_model, None);
        assert_eq!(settings.llm_model, None);
        assert!(settings.delete_audio_after_30d);
        assert!(!settings.encrypt_library);
    }

    #[test]
    fn save_then_load_roundtrips_exactly() {
        let dir = tempdir().unwrap();
        let settings = Settings {
            stt_model: Some("whisper-medium".to_string()),
            llm_model: Some("qwen3.5-4b".to_string()),
            delete_audio_after_30d: false,
            encrypt_library: true,
        };

        save_settings(dir.path(), &settings).unwrap();
        let loaded = load_settings(dir.path());

        assert_eq!(loaded, settings);
    }

    #[test]
    fn missing_settings_file_loads_as_defaults() {
        let dir = tempdir().unwrap();
        let loaded = load_settings(dir.path());
        assert_eq!(loaded, Settings::default());
    }

    #[test]
    fn corrupt_settings_file_loads_as_defaults_without_panicking() {
        let dir = tempdir().unwrap();
        fs::write(settings_path(dir.path()), "not valid json {{{").unwrap();

        let loaded = load_settings(dir.path());

        assert_eq!(loaded, Settings::default());
    }

    #[test]
    fn settings_json_wire_shape_is_camel_case() {
        let dir = tempdir().unwrap();
        let settings = Settings {
            stt_model: Some("whisper-small".to_string()),
            llm_model: None,
            delete_audio_after_30d: true,
            encrypt_library: false,
        };
        save_settings(dir.path(), &settings).unwrap();

        let raw = fs::read_to_string(settings_path(dir.path())).unwrap();
        assert!(raw.contains("\"sttModel\""));
        assert!(raw.contains("\"llmModel\""));
        assert!(raw.contains("\"deleteAudioAfter30d\""));
        assert!(raw.contains("\"encryptLibrary\""));
    }

    #[test]
    fn save_settings_is_atomic_and_leaves_no_tmp_file() {
        let dir = tempdir().unwrap();
        save_settings(dir.path(), &Settings::default()).unwrap();

        assert!(settings_path(dir.path()).exists());
        assert!(!settings_tmp_path(dir.path()).exists());
    }

    #[test]
    fn save_settings_creates_the_root_dir_if_missing() {
        let dir = tempdir().unwrap();
        let root = dir.path().join("nested").join("app-data");
        assert!(!root.exists());

        save_settings(&root, &Settings::default()).unwrap();

        assert!(settings_path(&root).exists());
    }

    #[test]
    fn apply_patch_with_all_fields_overwrites_every_field() {
        let mut settings = Settings::default();
        let patch = SettingsPatch {
            stt_model: Some("whisper-medium".to_string()),
            llm_model: Some("gemma-4-e4b".to_string()),
            delete_audio_after_30d: Some(false),
            encrypt_library: Some(true),
        };

        apply_patch(&mut settings, patch);

        assert_eq!(settings.stt_model, Some("whisper-medium".to_string()));
        assert_eq!(settings.llm_model, Some("gemma-4-e4b".to_string()));
        assert!(!settings.delete_audio_after_30d);
        assert!(settings.encrypt_library);
    }

    #[test]
    fn apply_patch_with_only_one_field_leaves_the_rest_unchanged() {
        let mut settings = Settings {
            stt_model: Some("whisper-small".to_string()),
            llm_model: Some("qwen3.5-4b".to_string()),
            delete_audio_after_30d: true,
            encrypt_library: false,
        };
        let patch = SettingsPatch {
            stt_model: None,
            llm_model: None,
            delete_audio_after_30d: Some(false),
            encrypt_library: None,
        };

        apply_patch(&mut settings, patch);

        assert_eq!(settings.stt_model, Some("whisper-small".to_string()));
        assert_eq!(settings.llm_model, Some("qwen3.5-4b".to_string()));
        assert!(!settings.delete_audio_after_30d);
        assert!(!settings.encrypt_library);
    }

    #[test]
    fn apply_patch_with_no_fields_is_a_no_op() {
        let original = Settings {
            stt_model: Some("whisper-small".to_string()),
            llm_model: None,
            delete_audio_after_30d: true,
            encrypt_library: false,
        };
        let mut settings = original.clone();

        apply_patch(&mut settings, SettingsPatch::default());

        assert_eq!(settings, original);
    }

    #[test]
    fn resolve_stt_model_prefers_the_explicit_arg() {
        let settings = Settings {
            stt_model: Some("whisper-medium".to_string()),
            ..Settings::default()
        };
        let resolved = resolve_stt_model(Some("whisper-large-v3-turbo".to_string()), &settings);
        assert_eq!(resolved, "whisper-large-v3-turbo");
    }

    #[test]
    fn resolve_stt_model_falls_back_to_settings_when_explicit_is_none() {
        let settings = Settings {
            stt_model: Some("whisper-medium".to_string()),
            ..Settings::default()
        };
        let resolved = resolve_stt_model(None, &settings);
        assert_eq!(resolved, "whisper-medium");
    }

    #[test]
    fn resolve_stt_model_falls_back_to_whisper_small_when_both_are_none() {
        let resolved = resolve_stt_model(None, &Settings::default());
        assert_eq!(resolved, "whisper-small");
    }

    #[test]
    fn open_shared_loads_existing_settings_from_disk() {
        let dir = tempdir().unwrap();
        let settings = Settings {
            stt_model: Some("whisper-medium".to_string()),
            ..Settings::default()
        };
        save_settings(dir.path(), &settings).unwrap();

        let shared = open_shared(dir.path());

        assert_eq!(*lock_settings(&shared), settings);
    }

    #[test]
    fn open_shared_on_a_fresh_root_starts_at_defaults() {
        let dir = tempdir().unwrap();
        let shared = open_shared(dir.path());
        assert_eq!(*lock_settings(&shared), Settings::default());
    }
}
