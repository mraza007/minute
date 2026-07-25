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
///
/// No `encryptLibrary` field (Stage 4 Task 3 removed it — the app never
/// implemented at-rest encryption of its own; the library only ever
/// inherited whatever FileVault protection macOS itself provides, so the
/// toggle was a fake capability). `serde` ignores unknown fields by default
/// (no `#[serde(deny_unknown_fields)]` here), so an old `settings.json`
/// still carrying `"encryptLibrary"` from a pre-Task-3 install still parses
/// fine — the field is just silently dropped on load, then absent from the
/// next save. See `settings_json_with_a_legacy_encrypt_library_field_still_parses`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    pub stt_model: Option<String>,
    pub llm_model: Option<String>,
    pub delete_audio_after_30d: bool,
    /// Stage 5 Task 1: opt-in meeting detection (mic-activity + running-app
    /// check, see `detect.rs`). `#[serde(default)]` so an old `settings.json`
    /// written before this field existed loads as `false` (opt-in, off by
    /// default — see the plan's callout to learn from Notion's opt-out
    /// backlash) rather than failing to parse — see
    /// `settings_json_without_meeting_detection_field_defaults_to_false`.
    #[serde(default)]
    pub meeting_detection: bool,
}

impl Default for Settings {
    /// Matches the Stage 1 mock's initial toggle state: delete-after-30d on,
    /// no model selected yet, meeting detection off (opt-in).
    fn default() -> Self {
        Self {
            stt_model: None,
            llm_model: None,
            delete_audio_after_30d: true,
            meeting_detection: false,
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
    pub meeting_detection: Option<bool>,
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
    if let Some(v) = patch.meeting_detection {
        settings.meeting_detection = v;
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

/// Applies `patch` and persists the result — the `set_settings` command's
/// actual logic, factored out here (rather than left inline in `lib.rs`) so
/// it's unit-testable without a running Tauri app, including the failure
/// path a real `AppHandle`-based test can't easily force.
///
/// Patches a *local clone* of the shared settings first, saves that clone to
/// disk, and only writes it back into the shared guard once the save has
/// actually succeeded. If `save_settings` fails (a disk error, an
/// unwritable/vanished app-data root, ...), the shared in-memory settings
/// are left exactly as they were before this call — never left holding a
/// patch that didn't actually make it to disk, which would otherwise let
/// memory and disk permanently disagree about what's persisted.
pub fn apply_and_save(root: &Path, state: &SharedSettings, patch: SettingsPatch) -> Result<Settings> {
    let mut guard = lock_settings(state);
    let mut candidate = guard.clone();
    apply_patch(&mut candidate, patch);
    save_settings(root, &candidate)?;
    *guard = candidate.clone();
    Ok(candidate)
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
        assert!(!settings.meeting_detection);
    }

    #[test]
    fn save_then_load_roundtrips_exactly() {
        let dir = tempdir().unwrap();
        let settings = Settings {
            stt_model: Some("whisper-medium".to_string()),
            llm_model: Some("qwen3.5-4b".to_string()),
            delete_audio_after_30d: false,
            meeting_detection: true,
        };

        save_settings(dir.path(), &settings).unwrap();
        let loaded = load_settings(dir.path());

        assert_eq!(loaded, settings);
    }

    #[test]
    fn settings_json_with_a_legacy_encrypt_library_field_still_parses() {
        // A settings.json written by a pre-Task-3 build of the app still has
        // `"encryptLibrary"` on disk — serde ignores unknown fields by
        // default (Settings has no `#[serde(deny_unknown_fields)]`), so this
        // must load cleanly, with the removed field simply dropped, rather
        // than falling back to defaults or failing to parse.
        let dir = tempdir().unwrap();
        let legacy_json = serde_json::json!({
            "sttModel": "whisper-medium",
            "llmModel": null,
            "deleteAudioAfter30d": false,
            "encryptLibrary": true,
        });
        fs::write(settings_path(dir.path()), serde_json::to_string(&legacy_json).unwrap()).unwrap();

        let loaded = load_settings(dir.path());

        assert_eq!(
            loaded,
            Settings {
                stt_model: Some("whisper-medium".to_string()),
                llm_model: None,
                delete_audio_after_30d: false,
                meeting_detection: false,
            }
        );
    }

    #[test]
    fn settings_json_without_meeting_detection_field_defaults_to_false() {
        // Stage 5 Task 1's own migration case: a settings.json written by any
        // pre-Stage-5 build has no "meetingDetection" key at all —
        // `#[serde(default)]` must make that load as `false` (opt-in, off),
        // not fail to parse or fall back to full defaults for the rest of
        // the file.
        let dir = tempdir().unwrap();
        let pre_stage5_json = serde_json::json!({
            "sttModel": "whisper-medium",
            "llmModel": "qwen3.5-4b",
            "deleteAudioAfter30d": false,
        });
        fs::write(
            settings_path(dir.path()),
            serde_json::to_string(&pre_stage5_json).unwrap(),
        )
        .unwrap();

        let loaded = load_settings(dir.path());

        assert_eq!(
            loaded,
            Settings {
                stt_model: Some("whisper-medium".to_string()),
                llm_model: Some("qwen3.5-4b".to_string()),
                delete_audio_after_30d: false,
                meeting_detection: false,
            }
        );
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
            meeting_detection: true,
        };
        save_settings(dir.path(), &settings).unwrap();

        let raw = fs::read_to_string(settings_path(dir.path())).unwrap();
        assert!(raw.contains("\"sttModel\""));
        assert!(raw.contains("\"llmModel\""));
        assert!(raw.contains("\"deleteAudioAfter30d\""));
        assert!(raw.contains("\"meetingDetection\""));
        assert!(!raw.contains("\"encryptLibrary\""));
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
            meeting_detection: Some(true),
        };

        apply_patch(&mut settings, patch);

        assert_eq!(settings.stt_model, Some("whisper-medium".to_string()));
        assert_eq!(settings.llm_model, Some("gemma-4-e4b".to_string()));
        assert!(!settings.delete_audio_after_30d);
        assert!(settings.meeting_detection);
    }

    #[test]
    fn apply_patch_with_only_one_field_leaves_the_rest_unchanged() {
        let mut settings = Settings {
            stt_model: Some("whisper-small".to_string()),
            llm_model: Some("qwen3.5-4b".to_string()),
            delete_audio_after_30d: true,
            meeting_detection: false,
        };
        let patch = SettingsPatch {
            stt_model: None,
            llm_model: None,
            delete_audio_after_30d: Some(false),
            meeting_detection: None,
        };

        apply_patch(&mut settings, patch);

        assert_eq!(settings.stt_model, Some("whisper-small".to_string()));
        assert_eq!(settings.llm_model, Some("qwen3.5-4b".to_string()));
        assert!(!settings.delete_audio_after_30d);
        assert!(!settings.meeting_detection);
    }

    #[test]
    fn apply_patch_with_no_fields_is_a_no_op() {
        let original = Settings {
            stt_model: Some("whisper-small".to_string()),
            llm_model: None,
            delete_audio_after_30d: true,
            meeting_detection: true,
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

    #[test]
    fn apply_and_save_commits_the_patch_to_both_disk_and_shared_state_on_success() {
        let dir = tempdir().unwrap();
        let shared: SharedSettings = Arc::new(Mutex::new(Settings::default()));
        let patch = SettingsPatch {
            stt_model: Some("whisper-medium".to_string()),
            ..SettingsPatch::default()
        };

        let returned = apply_and_save(dir.path(), &shared, patch).unwrap();
        assert!(!returned.meeting_detection);

        assert_eq!(returned.stt_model, Some("whisper-medium".to_string()));
        assert_eq!(*lock_settings(&shared), returned);
        assert_eq!(load_settings(dir.path()), returned);
    }

    #[test]
    fn apply_and_save_toggles_meeting_detection_and_persists_it() {
        // The path `set_settings` (lib.rs) drives when the frontend flips
        // the Settings toggle — confirms the whole round trip (patch ->
        // shared state -> disk) carries `meetingDetection`, which is what
        // `detect::set_enabled_live` reads to start/stop the detector
        // thread.
        let dir = tempdir().unwrap();
        let shared: SharedSettings = Arc::new(Mutex::new(Settings::default()));
        let patch = SettingsPatch {
            meeting_detection: Some(true),
            ..SettingsPatch::default()
        };

        let returned = apply_and_save(dir.path(), &shared, patch).unwrap();

        assert!(returned.meeting_detection);
        assert!(lock_settings(&shared).meeting_detection);
        assert!(load_settings(dir.path()).meeting_detection);
    }

    #[test]
    fn apply_and_save_leaves_shared_state_unchanged_when_the_save_fails() {
        let dir = tempdir().unwrap();
        // A file where the settings root is expected to be a directory —
        // `save_settings`'s `fs::create_dir_all` (and thus the whole call)
        // fails against this, forcing the failure path deterministically.
        let root = dir.path().join("not-a-dir");
        fs::write(&root, b"not a directory").unwrap();

        let original = Settings {
            stt_model: Some("whisper-small".to_string()),
            ..Settings::default()
        };
        let shared: SharedSettings = Arc::new(Mutex::new(original.clone()));
        let patch = SettingsPatch {
            stt_model: Some("whisper-medium".to_string()),
            ..SettingsPatch::default()
        };

        let result = apply_and_save(&root, &shared, patch);

        assert!(result.is_err());
        // The in-memory settings must be exactly what they were before the
        // failed call — not the patched candidate that never made it to disk.
        assert_eq!(*lock_settings(&shared), original);
    }
}
