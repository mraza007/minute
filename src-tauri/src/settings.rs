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

/// How long/detailed generated summaries should be — adjusts the summary
/// prompt's instructions and the generation token cap (see
/// `llm::generation_params_for`/`llm::build_summary_prompt`). Serialized
/// lowercase (`"short"`/`"standard"`/`"detailed"`) in `settings.json` and
/// over the IPC wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SummaryStyle {
    Short,
    #[default]
    Standard,
    Detailed,
}

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
    /// Stage 5 Task 5: opt-in "also capture system audio" default for new
    /// recordings (see `audio::start_recording`'s `includeSystemAudio`
    /// param, which falls back to this when the frontend doesn't pass an
    /// explicit override). `#[serde(default)]` so a `settings.json` written
    /// before this field existed loads as `false` — off by default, same
    /// opt-in rationale as `meetingDetection` above (and honest regardless:
    /// even when `true`, `start_recording` only actually honors it once
    /// `syscap::sys_audio_status()` reports `Ready` — see that command's
    /// docs).
    #[serde(default)]
    pub capture_system_audio: bool,
    /// Absolute path of the folder the notes library lives in, when the user
    /// has moved it via Settings → Storage (the `move_library` command is the
    /// only writer — deliberately not part of [`SettingsPatch`], so a plain
    /// `set_settings` can never re-point the library without actually moving
    /// it). `None` means the default app-data root. `#[serde(default)]` so
    /// older `settings.json` files load unchanged.
    #[serde(default)]
    pub library_root: Option<String>,
    /// Preferred summarizer context window in tokens; `None` = automatic
    /// (RAM-tiered, capped at the model's trained context — see
    /// `llm::context_tokens_for`). Set from Settings → Summary behavior.
    /// `#[serde(default)]` so older `settings.json` files load as automatic.
    #[serde(default)]
    pub llm_context_tokens: Option<u32>,
    /// How long/detailed generated summaries should be. `#[serde(default)]`
    /// so older `settings.json` files load as [`SummaryStyle::Standard`] —
    /// exactly the behavior they had before the setting existed.
    #[serde(default)]
    pub summary_style: SummaryStyle,
    /// Free-text user instructions appended to the summary prompt's rules
    /// (language, tone, focus areas — see `llm::build_summary_prompt`).
    /// Empty means none; the prompt's JSON-schema scaffolding and
    /// transcript delimiters are never editable, only augmented by this.
    /// `#[serde(default)]` so older `settings.json` files load as empty.
    #[serde(default)]
    pub summary_instructions: String,
    /// Whether the app checks GitHub for a newer release (issue #4) — one
    /// HTTPS request for release metadata, never anything about the user or
    /// their notes; the check itself lives in the frontend (see
    /// `useAppState`'s update-check effect), gated on this. On by default —
    /// the one deliberate exception to this app's opt-in convention, with a
    /// Settings toggle and plain-language copy explaining exactly what's
    /// sent. `#[serde(default = ...)]` so older `settings.json` files load
    /// as `true` rather than bool's `false` default.
    #[serde(default = "default_true")]
    pub auto_update_check: bool,
    /// Issue #6's speaker half: run the local diarization post-pass
    /// (`diar.rs`) after each recording finishes transcribing, labeling
    /// turns "Speaker 1..N". Opt-in (`#[serde(default)]` = `false`), same
    /// convention as `meetingDetection` — and only effective once both
    /// diarization models from the catalog are actually downloaded (the
    /// Settings toggle downloads them on enable; `audio::stop_recording`'s
    /// trigger re-checks install state every time).
    #[serde(default)]
    pub detect_speakers: bool,
    /// Issue #9: when both audio sources stay effectively silent — or
    /// nothing transcribable has been said (issue #38) — for 2 minutes
    /// mid-recording, warn with a 2-minute countdown and then
    /// stop & transcribe (see `audio`'s `auto_stop_tick`; retuned from
    /// 10+10 minutes for issue #28, and armed after just 1 minute
    /// when the transcript ends with a closing phrase — issue #36). On by
    /// default — like
    /// `autoUpdateCheck`, a deliberate exception to the opt-in
    /// convention: the failure it prevents (an accidental overnight
    /// recording — hours of dead air, a huge transcription job, wasted
    /// disk) is far worse than its false-positive mode (a banner with a
    /// "Keep recording" button and a 2-minute grace window). `#[serde
    /// (default = "default_true")]` so older `settings.json` files load
    /// as enabled.
    #[serde(default = "default_true")]
    pub auto_stop_recording: bool,
    /// Issue #16: after this many days, compress a note's `audio.wav` to a
    /// lossy `audio.m4a` (AAC, via macOS's `afconvert`) and remove the WAV —
    /// see `store::compress_candidates`/`Store::run_compression_sweep`.
    /// `None` = off (default) — unlike `deleteAudioAfter30d`'s fixed 30-day
    /// window, this is a user-chosen day count, so `Option<u32>` rather than
    /// a bool. `#[serde(default)]` so older `settings.json` files load as
    /// off, same opt-in convention as `meetingDetection`/`detectSpeakers`.
    #[serde(default)]
    pub compress_audio_after_days: Option<u32>,
    /// Issue #22: remember named speakers' voices. When on, renaming a
    /// "Speaker N" label saves that voice's embedding as a profile under
    /// the new name (`profiles.rs`), and later diarization passes suggest
    /// names for voices that match a saved profile. Opt-in
    /// (`#[serde(default)]` = `false`), same convention as
    /// `detectSpeakers` — this one stores voice fingerprints on disk, so
    /// the user must ask for it.
    #[serde(default)]
    pub speaker_profiles: bool,
    /// Issue #32: apply confident voice-profile matches straight into the
    /// transcript (and so into the summary) instead of only suggesting.
    /// Default-on as a deliberate exception to the opt-in convention: it
    /// only ever acts when `speakerProfiles` (opt-in) is already on, it is
    /// the natural point of saving profiles at all, and every application
    /// shows an Undo. `default_true` so existing settings.json files load
    /// as enabled.
    #[serde(default = "default_true")]
    pub auto_apply_speaker_names: bool,
    /// Issue #47: save each finished summary into an Obsidian vault as a
    /// Markdown note with YAML frontmatter (see `obsidian.rs`, hooked in
    /// from `llm::run_summarize`). Opt-in (`#[serde(default)]` = `false`),
    /// same convention as `meetingDetection` — this one writes files
    /// outside the library, so the user must ask for it.
    #[serde(default)]
    pub obsidian_enabled: bool,
    /// Absolute path of the vault folder notes are saved into. `None` until
    /// the user picks one in Settings → Obsidian — the toggle alone does
    /// nothing without it (the export reports "no vault folder is set"
    /// instead of guessing). `#[serde(default)]` so older `settings.json`
    /// files load unchanged.
    #[serde(default)]
    pub obsidian_vault_path: Option<String>,
    /// Subfolder inside the vault the notes land in — `"Meetings"` by
    /// default, empty for the vault root. Always relative: `apply_and_save`
    /// rejects a value with `..` or a leading slash before it's persisted,
    /// and `obsidian::resolve_target_dir` re-checks at write time, so even a
    /// hand-edited `settings.json` can't point exports outside the vault.
    /// `#[serde(default = "default_obsidian_folder")]` so older files load
    /// as `"Meetings"`.
    #[serde(default = "default_obsidian_folder")]
    pub obsidian_folder: String,
    /// Filename template for the vault note, without `.md` (always
    /// appended): `{date}`, `{time}`, `{title}`, `{id}` — see
    /// `obsidian::render_filename` for the exact expansion and the
    /// sanitizing that follows. `#[serde(default =
    /// "default_obsidian_filename_template")]` so older files load as
    /// `"{date} - {title}"`.
    #[serde(default = "default_obsidian_filename_template")]
    pub obsidian_filename_template: String,
    /// Whether the vault note carries the full `## Transcript` section —
    /// the same content `note.md` has. On by default so the vault copy
    /// loses nothing; off keeps vault notes to the summary for people who
    /// find hour-long transcripts noisy in Obsidian. `default_true` so
    /// older files load as `true`.
    #[serde(default = "default_true")]
    pub obsidian_include_transcript: bool,
}

/// `serde(default = ...)` helper for fields that default to `true` —
/// serde's plain `#[serde(default)]` on a `bool` gives `false`.
fn default_true() -> bool {
    true
}

/// `serde(default = ...)` helper for [`Settings::obsidian_folder`] — the
/// subfolder new installs (and pre-#47 `settings.json` files) save into.
fn default_obsidian_folder() -> String {
    crate::obsidian::DEFAULT_FOLDER.to_string()
}

/// `serde(default = ...)` helper for [`Settings::obsidian_filename_template`].
fn default_obsidian_filename_template() -> String {
    crate::obsidian::DEFAULT_FILENAME_TEMPLATE.to_string()
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
            capture_system_audio: false,
            library_root: None,
            llm_context_tokens: None,
            summary_style: SummaryStyle::default(),
            summary_instructions: String::new(),
            auto_update_check: true,
            detect_speakers: false,
            auto_stop_recording: true,
            compress_audio_after_days: None,
            speaker_profiles: false,
            auto_apply_speaker_names: true,
            obsidian_enabled: false,
            obsidian_vault_path: None,
            obsidian_folder: default_obsidian_folder(),
            obsidian_filename_template: default_obsidian_filename_template(),
            obsidian_include_transcript: true,
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
    pub capture_system_audio: Option<bool>,
    /// `Some(0)` means "back to automatic" (`Settings::llm_context_tokens =
    /// None`) — the one field here that *does* need an explicit clear,
    /// expressed as a sentinel rather than a double-`Option` (which serde
    /// can't distinguish from an omitted field without custom
    /// deserialization). Any other `Some(n)` sets the override to `n`.
    pub llm_context_tokens: Option<u32>,
    pub summary_style: Option<SummaryStyle>,
    /// `Some("")` clears the instructions — unlike the model ids above, an
    /// empty value is meaningful here, so no sentinel is needed.
    pub summary_instructions: Option<String>,
    pub auto_update_check: Option<bool>,
    pub detect_speakers: Option<bool>,
    pub auto_stop_recording: Option<bool>,
    /// `Some(0)` means "back to off" (`Settings::compress_audio_after_days =
    /// None`) — same sentinel trick as `llm_context_tokens` above, for the
    /// same reason (a single `Option<u32>` can't otherwise distinguish
    /// "leave unchanged" from "explicitly clear" without a double-`Option`).
    /// Any other `Some(n)` sets the day count to `n`.
    pub compress_audio_after_days: Option<u32>,
    pub speaker_profiles: Option<bool>,
    pub auto_apply_speaker_names: Option<bool>,
    pub obsidian_enabled: Option<bool>,
    /// `Some("")` clears the vault path back to `None` — the same
    /// empty-string-clears convention as `summary_instructions`, chosen
    /// over a `Some(0)`-style sentinel because an empty path is never a
    /// valid vault anyway. Any other value replaces the path (trimmed).
    pub obsidian_vault_path: Option<String>,
    /// `Some("")` means the vault root — an empty folder is meaningful
    /// here, so no sentinel is needed. `apply_and_save` rejects a value
    /// that could escape the vault (`..`, a leading slash).
    pub obsidian_folder: Option<String>,
    /// `Some("")` (or all whitespace) resets to the default template, since
    /// an empty template can't name a file — the same "a zero value means
    /// back to the default" idea as `llm_context_tokens`'s `Some(0)`.
    pub obsidian_filename_template: Option<String>,
    pub obsidian_include_transcript: Option<bool>,
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
    if let Some(v) = patch.capture_system_audio {
        settings.capture_system_audio = v;
    }
    if let Some(v) = patch.llm_context_tokens {
        settings.llm_context_tokens = if v == 0 { None } else { Some(v) };
    }
    if let Some(v) = patch.summary_style {
        settings.summary_style = v;
    }
    if let Some(v) = patch.summary_instructions {
        settings.summary_instructions = v;
    }
    if let Some(v) = patch.auto_update_check {
        settings.auto_update_check = v;
    }
    if let Some(v) = patch.detect_speakers {
        settings.detect_speakers = v;
    }
    if let Some(v) = patch.auto_stop_recording {
        settings.auto_stop_recording = v;
    }
    if let Some(v) = patch.compress_audio_after_days {
        settings.compress_audio_after_days = if v == 0 { None } else { Some(v) };
    }
    if let Some(v) = patch.speaker_profiles {
        settings.speaker_profiles = v;
    }
    if let Some(v) = patch.auto_apply_speaker_names {
        settings.auto_apply_speaker_names = v;
    }
    if let Some(v) = patch.obsidian_enabled {
        settings.obsidian_enabled = v;
    }
    if let Some(v) = patch.obsidian_vault_path {
        let trimmed = v.trim();
        settings.obsidian_vault_path = if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        };
    }
    if let Some(v) = patch.obsidian_folder {
        settings.obsidian_folder = v.trim().to_string();
    }
    if let Some(v) = patch.obsidian_filename_template {
        let trimmed = v.trim();
        settings.obsidian_filename_template = if trimmed.is_empty() {
            default_obsidian_filename_template()
        } else {
            trimmed.to_string()
        };
    }
    if let Some(v) = patch.obsidian_include_transcript {
        settings.obsidian_include_transcript = v;
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
    state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
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
pub fn apply_and_save(
    root: &Path,
    state: &SharedSettings,
    patch: SettingsPatch,
) -> Result<Settings> {
    // Issue #47: refuse an Obsidian subfolder that could escape the vault
    // before it's ever persisted. The export path re-checks the stored
    // value at write time regardless (see `obsidian::resolve_target_dir`),
    // but rejecting it here surfaces the mistake while the user is still
    // looking at the Settings field that caused it. Checked only when the
    // patch actually carries the field, so a bad value that somehow got
    // onto disk can't wedge every unrelated toggle afterwards.
    if let Some(folder) = patch.obsidian_folder.as_deref() {
        crate::obsidian::vault_subfolder_components(folder)?;
    }
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
        assert!(!settings.capture_system_audio);
    }

    #[test]
    fn save_then_load_roundtrips_exactly() {
        let dir = tempdir().unwrap();
        let settings = Settings {
            stt_model: Some("whisper-medium".to_string()),
            llm_model: Some("qwen3.5-4b".to_string()),
            delete_audio_after_30d: false,
            meeting_detection: true,
            capture_system_audio: true,
            library_root: None,
            llm_context_tokens: None,
            summary_style: SummaryStyle::Standard,
            summary_instructions: String::new(),
            auto_update_check: true,
            detect_speakers: false,
            auto_stop_recording: true,
            compress_audio_after_days: None,
            speaker_profiles: false,
            auto_apply_speaker_names: true,
            obsidian_enabled: false,
            obsidian_vault_path: None,
            obsidian_folder: "Meetings".to_string(),
            obsidian_filename_template: "{date} - {title}".to_string(),
            obsidian_include_transcript: true,
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
        fs::write(
            settings_path(dir.path()),
            serde_json::to_string(&legacy_json).unwrap(),
        )
        .unwrap();

        let loaded = load_settings(dir.path());

        assert_eq!(
            loaded,
            Settings {
                stt_model: Some("whisper-medium".to_string()),
                llm_model: None,
                delete_audio_after_30d: false,
                meeting_detection: false,
                capture_system_audio: false,
                library_root: None,
                llm_context_tokens: None,
                summary_style: SummaryStyle::Standard,
                summary_instructions: String::new(),
                auto_update_check: true,
                detect_speakers: false,
                auto_stop_recording: true,
                compress_audio_after_days: None,
            speaker_profiles: false,
            auto_apply_speaker_names: true,
            obsidian_enabled: false,
            obsidian_vault_path: None,
            obsidian_folder: "Meetings".to_string(),
            obsidian_filename_template: "{date} - {title}".to_string(),
            obsidian_include_transcript: true,
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
                capture_system_audio: false,
                library_root: None,
                llm_context_tokens: None,
                summary_style: SummaryStyle::Standard,
                summary_instructions: String::new(),
                auto_update_check: true,
                detect_speakers: false,
                auto_stop_recording: true,
                compress_audio_after_days: None,
            speaker_profiles: false,
            auto_apply_speaker_names: true,
            obsidian_enabled: false,
            obsidian_vault_path: None,
            obsidian_folder: "Meetings".to_string(),
            obsidian_filename_template: "{date} - {title}".to_string(),
            obsidian_include_transcript: true,
            }
        );
    }

    #[test]
    fn settings_json_without_capture_system_audio_field_defaults_to_false() {
        // Stage 5 Task 5's own migration case: a settings.json written by
        // any pre-Task-5 build has no "captureSystemAudio" key at all —
        // `#[serde(default)]` must make that load as `false` (opt-in, off),
        // not fail to parse or fall back to full defaults for the rest of
        // the file.
        let dir = tempdir().unwrap();
        let pre_task5_json = serde_json::json!({
            "sttModel": "whisper-medium",
            "llmModel": "qwen3.5-4b",
            "deleteAudioAfter30d": false,
            "meetingDetection": true,
        });
        fs::write(
            settings_path(dir.path()),
            serde_json::to_string(&pre_task5_json).unwrap(),
        )
        .unwrap();

        let loaded = load_settings(dir.path());

        assert_eq!(
            loaded,
            Settings {
                stt_model: Some("whisper-medium".to_string()),
                llm_model: Some("qwen3.5-4b".to_string()),
                delete_audio_after_30d: false,
                meeting_detection: true,
                capture_system_audio: false,
                library_root: None,
                llm_context_tokens: None,
                summary_style: SummaryStyle::Standard,
                summary_instructions: String::new(),
                auto_update_check: true,
                detect_speakers: false,
                auto_stop_recording: true,
                compress_audio_after_days: None,
            speaker_profiles: false,
            auto_apply_speaker_names: true,
            obsidian_enabled: false,
            obsidian_vault_path: None,
            obsidian_folder: "Meetings".to_string(),
            obsidian_filename_template: "{date} - {title}".to_string(),
            obsidian_include_transcript: true,
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
            capture_system_audio: true,
            library_root: None,
            llm_context_tokens: None,
            summary_style: SummaryStyle::Standard,
            summary_instructions: String::new(),
            auto_update_check: true,
            detect_speakers: false,
            auto_stop_recording: true,
            compress_audio_after_days: None,
            speaker_profiles: false,
            auto_apply_speaker_names: true,
            obsidian_enabled: false,
            obsidian_vault_path: None,
            obsidian_folder: "Meetings".to_string(),
            obsidian_filename_template: "{date} - {title}".to_string(),
            obsidian_include_transcript: true,
        };
        save_settings(dir.path(), &settings).unwrap();

        let raw = fs::read_to_string(settings_path(dir.path())).unwrap();
        assert!(raw.contains("\"sttModel\""));
        assert!(raw.contains("\"llmModel\""));
        assert!(raw.contains("\"deleteAudioAfter30d\""));
        assert!(raw.contains("\"meetingDetection\""));
        assert!(raw.contains("\"captureSystemAudio\""));
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
            capture_system_audio: Some(true),
            llm_context_tokens: Some(16_384),
            summary_style: Some(SummaryStyle::Detailed),
            summary_instructions: Some("Write in German.".to_string()),
            auto_update_check: Some(false),
            detect_speakers: Some(true),
            auto_stop_recording: Some(false),
            compress_audio_after_days: Some(14),
            speaker_profiles: Some(true),
            auto_apply_speaker_names: Some(false),
            obsidian_enabled: Some(true),
            obsidian_vault_path: Some("/Users/sam/Vault".to_string()),
            obsidian_folder: Some("Work/Meetings".to_string()),
            obsidian_filename_template: Some("{date} {title}".to_string()),
            obsidian_include_transcript: Some(false),
        };

        apply_patch(&mut settings, patch);

        assert_eq!(settings.stt_model, Some("whisper-medium".to_string()));
        assert_eq!(settings.llm_model, Some("gemma-4-e4b".to_string()));
        assert!(!settings.delete_audio_after_30d);
        assert!(settings.meeting_detection);
        assert!(settings.capture_system_audio);
        assert_eq!(settings.llm_context_tokens, Some(16_384));
        assert_eq!(settings.summary_style, SummaryStyle::Detailed);
        assert!(settings.detect_speakers);
        assert!(!settings.auto_stop_recording);
        assert_eq!(settings.compress_audio_after_days, Some(14));
        assert!(settings.speaker_profiles);
        assert!(settings.obsidian_enabled);
        assert_eq!(settings.obsidian_vault_path, Some("/Users/sam/Vault".to_string()));
        assert_eq!(settings.obsidian_folder, "Work/Meetings");
        assert_eq!(settings.obsidian_filename_template, "{date} {title}");
        assert!(!settings.obsidian_include_transcript);
    }

    #[test]
    fn settings_json_without_auto_stop_recording_defaults_to_true() {
        // Auto-stop's migration case (issue #9): a settings.json written by
        // any earlier build has no "autoStopRecording" key — it must load
        // as `true` (the deliberate on-by-default exception, same rationale
        // and serde shape as autoUpdateCheck).
        let dir = tempdir().unwrap();
        let pre_auto_stop_json = serde_json::json!({
            "sttModel": "whisper-small",
            "llmModel": "qwen3.5-4b",
            "deleteAudioAfter30d": true,
        });
        fs::write(
            settings_path(dir.path()),
            serde_json::to_string(&pre_auto_stop_json).unwrap(),
        )
        .unwrap();

        assert!(load_settings(dir.path()).auto_stop_recording);
    }

    #[test]
    fn settings_json_without_detect_speakers_field_defaults_to_false() {
        // Diarization's migration case: a settings.json written by any
        // pre-diarization build has no "detectSpeakers" key at all —
        // `#[serde(default)]` must make that load as `false` (opt-in, off),
        // same shape as the meetingDetection/captureSystemAudio cases above.
        let dir = tempdir().unwrap();
        let pre_diar_json = serde_json::json!({
            "sttModel": "whisper-medium",
            "llmModel": "qwen3.5-4b",
            "deleteAudioAfter30d": false,
        });
        fs::write(
            settings_path(dir.path()),
            serde_json::to_string(&pre_diar_json).unwrap(),
        )
        .unwrap();

        assert!(!load_settings(dir.path()).detect_speakers);
    }

    #[test]
    fn summary_behavior_fields_roundtrip_through_disk() {
        let dir = tempdir().unwrap();
        let settings = Settings {
            llm_context_tokens: Some(32_768),
            summary_style: SummaryStyle::Short,
            ..Settings::default()
        };

        save_settings(dir.path(), &settings).unwrap();
        let loaded = load_settings(dir.path());

        assert_eq!(loaded, settings);
        // Wire shape: camelCase key, lowercase style value.
        let raw = fs::read_to_string(settings_path(dir.path())).unwrap();
        assert!(raw.contains("\"llmContextTokens\": 32768"));
        assert!(raw.contains("\"summaryStyle\": \"short\""));
    }

    #[test]
    fn settings_json_without_auto_update_check_defaults_to_true() {
        // Migration case for the updater (issue #4): a settings.json written
        // by any pre-updater build has no "autoUpdateCheck" key — it must
        // load as `true` (the deliberate on-by-default exception; see the
        // field's docs), which is what `#[serde(default = "default_true")]`
        // exists for: plain `#[serde(default)]` on a bool would give `false`.
        let dir = tempdir().unwrap();
        let pre_updater_json = serde_json::json!({
            "sttModel": "whisper-small",
            "llmModel": "qwen3.5-4b",
            "deleteAudioAfter30d": true,
        });
        fs::write(
            settings_path(dir.path()),
            serde_json::to_string(&pre_updater_json).unwrap(),
        )
        .unwrap();

        assert!(load_settings(dir.path()).auto_update_check);
    }

    #[test]
    fn apply_patch_turns_auto_update_check_off_and_it_persists() {
        let dir = tempdir().unwrap();
        let shared: SharedSettings = Arc::new(Mutex::new(Settings::default()));
        let patch = SettingsPatch {
            auto_update_check: Some(false),
            ..SettingsPatch::default()
        };

        let returned = apply_and_save(dir.path(), &shared, patch).unwrap();

        assert!(!returned.auto_update_check);
        assert!(!load_settings(dir.path()).auto_update_check);
    }

    #[test]
    fn apply_patch_zero_context_tokens_means_back_to_automatic() {
        let mut settings = Settings {
            llm_context_tokens: Some(32_768),
            ..Settings::default()
        };
        let patch = SettingsPatch {
            llm_context_tokens: Some(0),
            ..SettingsPatch::default()
        };

        apply_patch(&mut settings, patch);

        assert_eq!(settings.llm_context_tokens, None);
    }

    #[test]
    fn apply_patch_sets_compress_audio_after_days() {
        let mut settings = Settings::default();
        let patch = SettingsPatch {
            compress_audio_after_days: Some(7),
            ..SettingsPatch::default()
        };

        apply_patch(&mut settings, patch);

        assert_eq!(settings.compress_audio_after_days, Some(7));
    }

    #[test]
    fn apply_patch_zero_compress_audio_after_days_means_back_to_off() {
        // Same sentinel trick as `llmContextTokens`'s `0` — see
        // `SettingsPatch::compress_audio_after_days`'s docs.
        let mut settings = Settings {
            compress_audio_after_days: Some(30),
            ..Settings::default()
        };
        let patch = SettingsPatch {
            compress_audio_after_days: Some(0),
            ..SettingsPatch::default()
        };

        apply_patch(&mut settings, patch);

        assert_eq!(settings.compress_audio_after_days, None);
    }

    #[test]
    fn settings_json_without_compress_audio_after_days_field_defaults_to_off() {
        // Issue #16's migration case: a settings.json written by any
        // pre-compression build has no "compressAudioAfterDays" key at
        // all — `#[serde(default)]` must make that load as `None` (off),
        // not fail to parse or fall back to full defaults for the rest of
        // the file.
        let dir = tempdir().unwrap();
        let pre_compression_json = serde_json::json!({
            "sttModel": "whisper-medium",
            "llmModel": "qwen3.5-4b",
            "deleteAudioAfter30d": false,
        });
        fs::write(
            settings_path(dir.path()),
            serde_json::to_string(&pre_compression_json).unwrap(),
        )
        .unwrap();

        assert_eq!(load_settings(dir.path()).compress_audio_after_days, None);
    }

    #[test]
    fn apply_patch_with_only_one_field_leaves_the_rest_unchanged() {
        let mut settings = Settings {
            stt_model: Some("whisper-small".to_string()),
            llm_model: Some("qwen3.5-4b".to_string()),
            delete_audio_after_30d: true,
            meeting_detection: false,
            capture_system_audio: false,
            library_root: None,
            llm_context_tokens: None,
            summary_style: SummaryStyle::Standard,
            summary_instructions: String::new(),
            auto_update_check: true,
            detect_speakers: false,
            auto_stop_recording: true,
            compress_audio_after_days: None,
            speaker_profiles: false,
            auto_apply_speaker_names: true,
            obsidian_enabled: false,
            obsidian_vault_path: None,
            obsidian_folder: "Meetings".to_string(),
            obsidian_filename_template: "{date} - {title}".to_string(),
            obsidian_include_transcript: true,
        };
        let patch = SettingsPatch {
            delete_audio_after_30d: Some(false),
            ..SettingsPatch::default()
        };

        apply_patch(&mut settings, patch);

        assert_eq!(settings.stt_model, Some("whisper-small".to_string()));
        assert_eq!(settings.llm_model, Some("qwen3.5-4b".to_string()));
        assert!(!settings.delete_audio_after_30d);
        assert!(!settings.meeting_detection);
        assert!(!settings.capture_system_audio);
    }

    #[test]
    fn apply_patch_with_no_fields_is_a_no_op() {
        let original = Settings {
            stt_model: Some("whisper-small".to_string()),
            llm_model: None,
            delete_audio_after_30d: true,
            meeting_detection: true,
            capture_system_audio: true,
            library_root: None,
            llm_context_tokens: None,
            summary_style: SummaryStyle::Standard,
            summary_instructions: String::new(),
            auto_update_check: true,
            detect_speakers: false,
            auto_stop_recording: true,
            compress_audio_after_days: None,
            speaker_profiles: false,
            auto_apply_speaker_names: true,
            obsidian_enabled: false,
            obsidian_vault_path: None,
            obsidian_folder: "Meetings".to_string(),
            obsidian_filename_template: "{date} - {title}".to_string(),
            obsidian_include_transcript: true,
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
    fn apply_and_save_toggles_capture_system_audio_and_persists_it() {
        // Mirrors `apply_and_save_toggles_meeting_detection_and_persists_it`
        // — the path `set_settings` (lib.rs) drives when the frontend flips
        // Settings' "Capture system audio" toggle. Confirms the whole round
        // trip (patch -> shared state -> disk) carries `captureSystemAudio`,
        // which is what `audio::start_recording` reads as its default when
        // the frontend doesn't pass an explicit `includeSystemAudio`.
        let dir = tempdir().unwrap();
        let shared: SharedSettings = Arc::new(Mutex::new(Settings::default()));
        let patch = SettingsPatch {
            capture_system_audio: Some(true),
            ..SettingsPatch::default()
        };

        let returned = apply_and_save(dir.path(), &shared, patch).unwrap();

        assert!(returned.capture_system_audio);
        assert!(lock_settings(&shared).capture_system_audio);
        assert!(load_settings(dir.path()).capture_system_audio);
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

    #[test]
    fn settings_json_without_obsidian_fields_defaults_to_off_with_meetings_folder() {
        // Issue #47's migration case: a settings.json written by any
        // pre-Obsidian build has none of the five "obsidian*" keys — they
        // must load as off / no vault / "Meetings" / the default template /
        // transcript included, not fail to parse or fall back to full
        // defaults for the rest of the file.
        let dir = tempdir().unwrap();
        let pre_obsidian_json = serde_json::json!({
            "sttModel": "whisper-medium",
            "llmModel": "qwen3.5-4b",
            "deleteAudioAfter30d": false,
        });
        fs::write(
            settings_path(dir.path()),
            serde_json::to_string(&pre_obsidian_json).unwrap(),
        )
        .unwrap();

        let loaded = load_settings(dir.path());

        assert_eq!(loaded.stt_model, Some("whisper-medium".to_string()));
        assert!(!loaded.delete_audio_after_30d);
        assert!(!loaded.obsidian_enabled);
        assert_eq!(loaded.obsidian_vault_path, None);
        assert_eq!(loaded.obsidian_folder, "Meetings");
        assert_eq!(loaded.obsidian_filename_template, "{date} - {title}");
        assert!(loaded.obsidian_include_transcript);
    }

    #[test]
    fn obsidian_fields_roundtrip_through_disk_in_camel_case() {
        let dir = tempdir().unwrap();
        let settings = Settings {
            obsidian_enabled: true,
            obsidian_vault_path: Some("/Users/sam/Vault".to_string()),
            obsidian_folder: "Work/Meetings".to_string(),
            obsidian_filename_template: "{date} {title}".to_string(),
            obsidian_include_transcript: false,
            ..Settings::default()
        };

        save_settings(dir.path(), &settings).unwrap();

        assert_eq!(load_settings(dir.path()), settings);
        let raw = fs::read_to_string(settings_path(dir.path())).unwrap();
        assert!(raw.contains("\"obsidianEnabled\": true"));
        assert!(raw.contains("\"obsidianVaultPath\": \"/Users/sam/Vault\""));
        assert!(raw.contains("\"obsidianFolder\": \"Work/Meetings\""));
        assert!(raw.contains("\"obsidianFilenameTemplate\": \"{date} {title}\""));
        assert!(raw.contains("\"obsidianIncludeTranscript\": false"));
    }

    #[test]
    fn apply_patch_empty_obsidian_vault_path_clears_it() {
        // `Some("")` (or whitespace) is the clear sentinel — see
        // `SettingsPatch::obsidian_vault_path`'s docs.
        let mut settings = Settings {
            obsidian_vault_path: Some("/Users/sam/Vault".to_string()),
            ..Settings::default()
        };
        let patch = SettingsPatch {
            obsidian_vault_path: Some("   ".to_string()),
            ..SettingsPatch::default()
        };

        apply_patch(&mut settings, patch);

        assert_eq!(settings.obsidian_vault_path, None);
    }

    #[test]
    fn apply_patch_trims_the_obsidian_vault_path_and_folder() {
        let mut settings = Settings::default();
        let patch = SettingsPatch {
            obsidian_vault_path: Some("  /Users/sam/Vault \n".to_string()),
            obsidian_folder: Some(" Meetings/2026 ".to_string()),
            ..SettingsPatch::default()
        };

        apply_patch(&mut settings, patch);

        assert_eq!(settings.obsidian_vault_path, Some("/Users/sam/Vault".to_string()));
        assert_eq!(settings.obsidian_folder, "Meetings/2026");
    }

    #[test]
    fn apply_patch_empty_obsidian_folder_means_the_vault_root() {
        let mut settings = Settings::default();
        let patch = SettingsPatch {
            obsidian_folder: Some(String::new()),
            ..SettingsPatch::default()
        };

        apply_patch(&mut settings, patch);

        assert_eq!(settings.obsidian_folder, "");
    }

    #[test]
    fn apply_patch_empty_obsidian_filename_template_resets_to_the_default() {
        // An empty template can't name a file, so `Some("")` means "back to
        // the default" — see `SettingsPatch::obsidian_filename_template`.
        let mut settings = Settings {
            obsidian_filename_template: "{title}".to_string(),
            ..Settings::default()
        };
        let patch = SettingsPatch {
            obsidian_filename_template: Some("  ".to_string()),
            ..SettingsPatch::default()
        };

        apply_patch(&mut settings, patch);

        assert_eq!(settings.obsidian_filename_template, "{date} - {title}");
    }

    #[test]
    fn apply_and_save_rejects_an_obsidian_folder_that_escapes_the_vault() {
        // The subfolder is checked before anything is persisted (issue
        // #47): neither disk nor the shared settings may end up holding a
        // folder that points outside the vault.
        let dir = tempdir().unwrap();
        let shared: SharedSettings = Arc::new(Mutex::new(Settings::default()));
        for bad in ["../Elsewhere", "Meetings/../../Elsewhere", "/Users/sam/Elsewhere"] {
            let patch = SettingsPatch {
                obsidian_folder: Some(bad.to_string()),
                ..SettingsPatch::default()
            };

            let result = apply_and_save(dir.path(), &shared, patch);

            assert!(result.is_err(), "{bad:?} must be rejected");
            assert_eq!(lock_settings(&shared).obsidian_folder, "Meetings");
        }
        // Nothing was ever written — a fresh load is still all defaults.
        assert_eq!(load_settings(dir.path()), Settings::default());
    }

    #[test]
    fn apply_and_save_persists_a_nested_obsidian_folder() {
        let dir = tempdir().unwrap();
        let shared: SharedSettings = Arc::new(Mutex::new(Settings::default()));
        let patch = SettingsPatch {
            obsidian_enabled: Some(true),
            obsidian_folder: Some("Work/Meetings".to_string()),
            ..SettingsPatch::default()
        };

        let returned = apply_and_save(dir.path(), &shared, patch).unwrap();

        assert!(returned.obsidian_enabled);
        assert_eq!(returned.obsidian_folder, "Work/Meetings");
        assert_eq!(*lock_settings(&shared), returned);
        assert_eq!(load_settings(dir.path()), returned);
    }
}
