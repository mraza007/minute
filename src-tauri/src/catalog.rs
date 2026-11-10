//! Model catalog (STT + LLM entries) and hardware-aware model recommendations.

use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use sysinfo::System;

use crate::error::{MinuteError, Result};

const CATALOG_JSON: &str = include_str!("../catalog.json");

/// Whether a catalog entry is a speech-to-text model, a summarization LLM,
/// or one of the two speaker-diarization models (issue #6's speaker half —
/// see `diar.rs`). Diarization entries are downloaded as a pair when the
/// user enables "Detect speakers", never offered in the STT/LLM pickers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    Stt,
    Llm,
    Diarization,
}

/// One downloadable model, as described in `catalog.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogEntry {
    pub id: String,
    pub kind: ModelKind,
    pub display_name: String,
    /// Short editorial labels for tested entries ("Most accurate"). Size is
    /// never a trait: the UI formats `size_bytes` itself.
    #[serde(default)]
    pub traits: Vec<String>,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub min_ram_gb: u64,
    pub requires_apple_silicon: bool,
    #[serde(default)]
    pub origin: ModelOrigin,
}

/// Where an entry comes from. `Tested` entries ship in `catalog.json` and
/// were run through the app before release. `HuggingFace` entries were found
/// by browsing and carry only what Hugging Face reports about them.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ModelOrigin {
    #[default]
    Tested,
    #[serde(rename_all = "camelCase")]
    HuggingFace {
        /// `<publisher>/<name>`, exactly as Hugging Face spells it.
        repo: String,
        /// A file at the repo root.
        file: String,
        publisher: String,
        /// Recomputed from [`TRUSTED_PUBLISHERS`] whenever an entry is read
        /// back from disk, so a stored `true` cannot grant trust.
        trusted: bool,
        architecture: Option<String>,
        parameters: Option<u64>,
        quantization: Option<String>,
        updated_at: Option<String>,
        downloads: Option<u64>,
    },
}

/// Publishers whose models download without an extra confirmation. Matched
/// exactly, in the spelling Hugging Face uses for the account.
pub const TRUSTED_PUBLISHERS: &[&str] = &[
    "ggml-org",
    "ggerganov",
    "unsloth",
    "bartowski",
    "lmstudio-community",
    "Qwen",
    "google",
    "LiquidAI",
    "ibm-granite",
    "mistralai",
    "microsoft",
    "HuggingFaceTB",
    "meta-llama",
    "nvidia",
    "allenai",
];

pub fn is_trusted_publisher(publisher: &str) -> bool {
    TRUSTED_PUBLISHERS.contains(&publisher)
}

/// Detected machine capabilities used to pick a sensible default model pair.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hardware {
    pub total_ram_gb: u64,
    pub apple_silicon: bool,
    pub cores: usize,
}

/// Recommended STT + LLM model ids for the detected hardware.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Recommendation {
    pub stt: String,
    pub llm: String,
}

/// On-disk install status of a catalog entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum InstallState {
    NotInstalled,
    /// Placeholder — populated by the downloader in Task 4.
    Downloading,
    Installed,
}

/// A catalog entry annotated with its current on-disk install state, as
/// returned to the frontend by the `list_models` command.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelStatus {
    #[serde(flatten)]
    pub entry: CatalogEntry,
    pub state: InstallState,
}

/// Parses the embedded `catalog.json` into catalog entries.
pub fn load_catalog() -> Result<Vec<CatalogEntry>> {
    serde_json::from_str(CATALOG_JSON)
        .map_err(|e| MinuteError::Other(format!("failed to parse catalog.json: {e}")))
}

/// Detects total RAM, Apple Silicon, and available cores for the current machine.
pub fn detect_hardware() -> Hardware {
    let mut sys = System::new();
    sys.refresh_memory();
    let total_ram_gb = sys.total_memory() / (1024 * 1024 * 1024);
    let cores = std::thread::available_parallelism()
        .map(|n| n.get())
        .unwrap_or(1);
    Hardware {
        total_ram_gb,
        apple_silicon: std::env::consts::ARCH == "aarch64",
        cores,
    }
}

/// Picks a default STT + LLM pair for the given hardware.
///
/// Tiered by total RAM (< 16 GB / 16-31 GB / >= 32 GB), then constrained by
/// each catalog entry's `min_ram_gb` / `requires_apple_silicon` — an Intel
/// Mac that lands in the top tier gets downgraded off any Apple-Silicon-only
/// pick.
///
/// Takes the catalog as a parameter (rather than loading it itself) so it's
/// testable without touching the filesystem, and so a missing/typo'd/absent
/// catalog id is handled the same way as a genuine hardware constraint
/// mismatch: `fits` treats "id not found in catalog" as "does not fit" and
/// falls through to the hardcoded fallback pick, which is always a valid,
/// low-tier id independent of catalog contents. That makes `recommend`
/// total and safe even against an empty catalog slice (e.g. if the caller's
/// `load_catalog()` failed) — it still returns a well-formed `Recommendation`.
pub fn recommend(catalog: &[CatalogEntry], hw: &Hardware) -> Recommendation {
    let (stt_tier, llm_tier) = if hw.total_ram_gb < 16 {
        ("whisper-small", "qwen3.5-4b")
    } else if hw.total_ram_gb < 32 {
        ("whisper-medium", "gemma-4-e4b")
    } else {
        ("whisper-large-v3-turbo", "qwen3.5-9b")
    };

    let fits = |id: &str| -> bool {
        catalog
            .iter()
            .find(|e| e.id == id)
            .map(|e| {
                hw.total_ram_gb >= e.min_ram_gb && (!e.requires_apple_silicon || hw.apple_silicon)
            })
            .unwrap_or(false)
    };

    let stt = if fits(stt_tier) {
        stt_tier
    } else {
        "whisper-medium"
    };
    let llm = if fits(llm_tier) {
        llm_tier
    } else {
        "qwen3.5-4b"
    };

    Recommendation {
        stt: stt.to_string(),
        llm: llm.to_string(),
    }
}

/// Where an entry's model file lives under `models_root`, grouped by kind.
pub fn installed_path(entry: &CatalogEntry, models_root: &Path) -> PathBuf {
    let dir = match entry.kind {
        ModelKind::Stt => "whisper",
        ModelKind::Llm => "llm",
        ModelKind::Diarization => "diar",
    };
    let base = models_root.join("models").join(dir);
    match &entry.origin {
        ModelOrigin::Tested => {
            let file_name = entry.url.rsplit('/').next().unwrap_or(entry.id.as_str());
            base.join(file_name)
        }
        // An invalid entry never reaches here (`admit_hf_entries` drops it,
        // `execute_download` refuses it), but this function cannot fail, so
        // it still must not build a path from unchecked names.
        ModelOrigin::HuggingFace { repo, file, .. } => {
            match hf_install_subpath(entry.kind, repo, file) {
                Ok(sub) => base.join(sub),
                Err(_) => base.join("hf").join(".invalid"),
            }
        }
    }
}

const HF_URL_PREFIX: &str = "https://huggingface.co/";

/// One path component of a Hugging Face repo or file name. The allowlist is
/// what keeps a name inside the models folder: no separators, no NUL, no `.`
/// or `..` (nothing may start with a dot), nothing empty.
fn is_safe_component(name: &str, extra: &[char]) -> bool {
    !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('.')
        && name.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-') || extra.contains(&c)
        })
}

fn split_repo(repo: &str) -> Option<(&str, &str)> {
    let (publisher, name) = repo.split_once('/')?;
    (is_safe_component(publisher, &[]) && is_safe_component(name, &[]))
        .then_some((publisher, name))
}

/// Whether `file` is a model file the app can load for `kind`.
fn is_model_file(kind: ModelKind, file: &str) -> bool {
    is_safe_component(file, &['+'])
        && match kind {
            ModelKind::Llm => file.ends_with(".gguf"),
            ModelKind::Stt => file.starts_with("ggml-") && file.ends_with(".bin"),
            ModelKind::Diarization => false,
        }
}

/// `hf/<publisher>/<repo-name>/<file>`. The publisher and repo are part of
/// the path because two repos often ship the same file name.
pub fn hf_install_subpath(kind: ModelKind, repo: &str, file: &str) -> Result<PathBuf> {
    let (publisher, name) = split_repo(repo)
        .ok_or_else(|| MinuteError::Other(format!("invalid Hugging Face repo: {repo:?}")))?;
    if !is_model_file(kind, file) {
        return Err(MinuteError::Other(format!(
            "invalid Hugging Face model file: {file:?}"
        )));
    }
    Ok(Path::new("hf").join(publisher).join(name).join(file))
}

pub fn hf_entry_id(repo: &str, file: &str) -> String {
    format!("hf:{repo}/{file}")
}

pub fn hf_download_url(repo: &str, revision: &str, file: &str) -> String {
    format!("{HF_URL_PREFIX}{repo}/resolve/{revision}/{file}")
}

/// The `(repo, revision, file)` a Hugging Face download URL points at, for a
/// file at the repo root.
fn parse_hf_url(url: &str) -> Option<(String, &str, &str)> {
    let mut parts = url.strip_prefix(HF_URL_PREFIX)?.split('/');
    let (publisher, name) = (parts.next()?, parts.next()?);
    let (resolve, revision, file) = (parts.next()?, parts.next()?, parts.next()?);
    (resolve == "resolve" && parts.next().is_none())
        .then(|| (format!("{publisher}/{name}"), revision, file))
}

/// The `(repo, file)` an entry downloads, whatever its origin. Lets a browse
/// result be recognized as the same model as a built-in entry.
pub fn hf_coordinates(entry: &CatalogEntry) -> Option<(String, String)> {
    parse_hf_url(&entry.url).map(|(repo, _, file)| (repo, file.to_string()))
}

/// Checks everything the downloader and `installed_path` rely on. Entries
/// from `catalog.json` are trusted as shipped. A Hugging Face entry must be
/// self-consistent: its id, URL, and publisher all derive from one validated
/// `(repo, file)` pair, so no field can point somewhere the others do not.
pub fn validate_entry(entry: &CatalogEntry) -> Result<()> {
    let ModelOrigin::HuggingFace {
        repo,
        file,
        publisher,
        ..
    } = &entry.origin
    else {
        return Ok(());
    };
    let bad = |what: &str| MinuteError::Other(format!("invalid model entry {}: {what}", entry.id));
    hf_install_subpath(entry.kind, repo, file)?;
    if split_repo(repo).map(|(p, _)| p) != Some(publisher.as_str()) {
        return Err(bad("publisher does not match repo"));
    }
    if entry.id != hf_entry_id(repo, file) {
        return Err(bad("id does not match repo and file"));
    }
    let is_hex = |s: &str, len: usize| s.len() == len && s.chars().all(|c| c.is_ascii_hexdigit());
    match parse_hf_url(&entry.url) {
        Some((url_repo, rev, url_file))
            if url_repo == *repo && url_file == file && (rev == "main" || is_hex(rev, 40)) => {}
        _ => return Err(bad("url does not match repo and file")),
    }
    if !is_hex(&entry.sha256, 64) {
        return Err(bad("sha256 is not 64 hex characters"));
    }
    if entry.size_bytes == 0 {
        return Err(bad("size is zero"));
    }
    Ok(())
}

/// Keeps only well-formed Hugging Face entries and recomputes `trusted`.
/// Every entry read from a file the app wrote earlier (`added.json`, the
/// browse cache) passes through here, so an edited file cannot smuggle in a
/// path, a URL on another host, or a trust flag.
pub fn admit_hf_entries(entries: Vec<CatalogEntry>) -> Vec<CatalogEntry> {
    entries
        .into_iter()
        .filter_map(|mut entry| {
            let ModelOrigin::HuggingFace {
                publisher, trusted, ..
            } = &mut entry.origin
            else {
                log::warn!("dropping non-Hugging Face entry {}", entry.id);
                return None;
            };
            *trusted = is_trusted_publisher(publisher);
            match validate_entry(&entry) {
                Ok(()) => Some(entry),
                Err(e) => {
                    log::warn!("{e}");
                    None
                }
            }
        })
        .collect()
}

/// Serializes read-modify-write of `added.json` within this process.
static ADDED_LOCK: Mutex<()> = Mutex::new(());

fn added_path(models_root: &Path) -> PathBuf {
    models_root.join("models").join("added.json")
}

/// Reads a JSON file the app wrote earlier. A missing or unreadable file is
/// `None`: both callers treat that as "nothing saved yet".
pub fn read_json_file<T: serde::de::DeserializeOwned>(path: &Path) -> Option<T> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return None,
        Err(e) => {
            log::warn!("failed to read {}: {e}", path.display());
            return None;
        }
    };
    serde_json::from_slice(&bytes)
        .map_err(|e| log::warn!("failed to parse {}: {e}", path.display()))
        .ok()
}

/// Writes `value` as JSON through a temp file and a rename, so a crash
/// mid-write leaves the previous file intact.
pub fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let json = serde_json::to_vec_pretty(value)
        .map_err(|e| MinuteError::Other(format!("failed to serialize {}: {e}", path.display())))?;
    let mut tmp = path.as_os_str().to_owned();
    tmp.push(".tmp");
    let tmp = PathBuf::from(tmp);
    std::fs::write(&tmp, json)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// Hugging Face entries the user chose to download.
pub fn load_added(models_root: &Path) -> Vec<CatalogEntry> {
    admit_hf_entries(read_json_file(&added_path(models_root)).unwrap_or_default())
}

fn update_added(
    models_root: &Path,
    change: impl FnOnce(&mut Vec<CatalogEntry>) -> bool,
) -> Result<()> {
    let _guard = ADDED_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut entries = load_added(models_root);
    if change(&mut entries) {
        write_json_file(&added_path(models_root), &entries)?;
    }
    Ok(())
}

/// Saves a Hugging Face entry so it survives restarts. Saving the same id
/// again replaces it.
pub fn remember_added(models_root: &Path, entry: &CatalogEntry) -> Result<()> {
    if entry.origin == ModelOrigin::Tested {
        return Err(MinuteError::Other(format!(
            "{} is a built-in model",
            entry.id
        )));
    }
    validate_entry(entry)?;
    update_added(models_root, |entries| {
        entries.retain(|e| e.id != entry.id);
        entries.push(entry.clone());
        true
    })
}

/// Forgets a saved Hugging Face entry. An unknown id is a no-op.
pub fn forget_added(models_root: &Path, id: &str) -> Result<()> {
    update_added(models_root, |entries| {
        let before = entries.len();
        entries.retain(|e| e.id != id);
        entries.len() != before
    })
}

/// The built-in catalog followed by the user's saved Hugging Face entries.
/// Every command that turns a model id into an entry resolves it here.
pub fn merged_catalog(models_root: &Path) -> Result<Vec<CatalogEntry>> {
    let mut catalog = load_catalog()?;
    catalog.extend(load_added(models_root));
    Ok(catalog)
}

/// Whether an entry is installed under `models_root` — the file must exist
/// and match the catalog's pinned `size_bytes` exactly.
pub fn install_state(entry: &CatalogEntry, models_root: &Path) -> InstallState {
    let path = installed_path(entry, models_root);
    match std::fs::metadata(&path) {
        Ok(meta) if meta.len() == entry.size_bytes => InstallState::Installed,
        _ => InstallState::NotInstalled,
    }
}

/// Resolves which LLM entry summarization/ask should run: the persisted
/// `settings.llmModel` (`preferred`) if that entry is installed, else the
/// recommended LLM if *it* is installed, else `None`.
///
/// The recommended-model fallback must mirror the frontend's
/// `pickInitialLlmModel` (src/state/adapters.ts) exactly: Settings
/// preselects the recommended model with that same rule when nothing is
/// persisted, so without the identical fallback here a downloaded-but-
/// never-clicked recommended model shows as "Installed · in use" while
/// summarize/ask insist there is no model — issue #2.
pub fn resolve_llm_entry(
    catalog: &[CatalogEntry],
    recommendation: &Recommendation,
    preferred: Option<&str>,
    models_root: &Path,
) -> Option<CatalogEntry> {
    let installed_llm = |id: &str| {
        catalog
            .iter()
            .find(|e| e.id == id && e.kind == ModelKind::Llm)
            .filter(|e| install_state(e, models_root) == InstallState::Installed)
    };
    if let Some(entry) = preferred.and_then(installed_llm) {
        return Some(entry.clone());
    }
    installed_llm(&recommendation.llm).cloned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    fn hf_llm_entry(repo: &str, file: &str) -> CatalogEntry {
        let publisher = repo.split('/').next().unwrap().to_string();
        CatalogEntry {
            id: hf_entry_id(repo, file),
            kind: ModelKind::Llm,
            display_name: file.to_string(),
            traits: Vec::new(),
            url: hf_download_url(repo, "main", file),
            sha256: "a".repeat(64),
            size_bytes: 1024,
            min_ram_gb: 8,
            requires_apple_silicon: false,
            origin: ModelOrigin::HuggingFace {
                trusted: is_trusted_publisher(&publisher),
                repo: repo.to_string(),
                file: file.to_string(),
                publisher,
                architecture: Some("qwen35".to_string()),
                parameters: Some(4_205_751_296),
                quantization: Some("Q4_K_M".to_string()),
                updated_at: Some("2026-03-02T14:08:17.000Z".to_string()),
                downloads: Some(1_532_682),
            },
        }
    }

    #[test]
    fn built_in_entries_are_tested_and_carry_traits_without_sizes() {
        for entry in load_catalog().unwrap() {
            assert_eq!(entry.origin, ModelOrigin::Tested, "{}", entry.id);
            assert!(!entry.traits.is_empty(), "{} has no traits", entry.id);
            for t in &entry.traits {
                assert!(
                    !t.contains(" GB") && !t.contains(" MB"),
                    "{}: size is not a trait: {t}",
                    entry.id
                );
            }
        }
    }

    #[test]
    fn origin_serializes_to_the_contract_shape() {
        let tested = serde_json::to_value(ModelOrigin::Tested).unwrap();
        assert_eq!(tested, serde_json::json!({"kind": "tested"}));

        let entry = hf_llm_entry("unsloth/Qwen3.5-4B-GGUF", "Qwen3.5-4B-Q4_K_M.gguf");
        assert_eq!(
            entry.id,
            "hf:unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf"
        );
        let json = serde_json::to_value(&entry).unwrap();
        assert_eq!(
            json["origin"],
            serde_json::json!({
                "kind": "huggingFace",
                "repo": "unsloth/Qwen3.5-4B-GGUF",
                "file": "Qwen3.5-4B-Q4_K_M.gguf",
                "publisher": "unsloth",
                "trusted": true,
                "architecture": "qwen35",
                "parameters": 4205751296u64,
                "quantization": "Q4_K_M",
                "updatedAt": "2026-03-02T14:08:17.000Z",
                "downloads": 1532682
            })
        );
        let back: CatalogEntry = serde_json::from_value(json).unwrap();
        assert_eq!(back.origin, entry.origin);
    }

    #[test]
    fn hf_paths_stay_inside_the_models_folder() {
        let root = Path::new("/data");
        let ok = hf_llm_entry("unsloth/Qwen3.5-4B-GGUF", "Qwen3.5-4B-Q4_K_M.gguf");
        assert_eq!(
            installed_path(&ok, root),
            Path::new("/data/models/llm/hf/unsloth/Qwen3.5-4B-GGUF/Qwen3.5-4B-Q4_K_M.gguf")
        );

        let attempts: &[(&str, &str)] = &[
            ("../evil", "m.gguf"),
            ("..", "m.gguf"),
            ("a/..", "m.gguf"),
            ("a/.", "m.gguf"),
            ("a", "m.gguf"),
            ("a/b/c", "m.gguf"),
            ("/b", "m.gguf"),
            ("a/", "m.gguf"),
            ("a\\b/c", "m.gguf"),
            ("a/b\0", "m.gguf"),
            ("a/b", "../m.gguf"),
            ("a/b", "sub/m.gguf"),
            ("a/b", "..\\m.gguf"),
            ("a/b", "/etc/m.gguf"),
            ("a/b", ".gguf"),
            ("a/b", ""),
            ("a/b", "m\0.gguf"),
            ("a/b", "m.gguf.exe"),
            ("a/b", "m.bin"),
        ];
        for (repo, file) in attempts {
            assert!(
                hf_install_subpath(ModelKind::Llm, repo, file).is_err(),
                "accepted {repo:?} {file:?}"
            );
            let mut entry = hf_llm_entry("a/b", "m.gguf");
            entry.origin = ModelOrigin::HuggingFace {
                repo: repo.to_string(),
                file: file.to_string(),
                publisher: "a".to_string(),
                trusted: false,
                architecture: None,
                parameters: None,
                quantization: None,
                updated_at: None,
                downloads: None,
            };
            let path = installed_path(&entry, root);
            assert!(
                path.starts_with("/data/models/llm/hf")
                    && !path
                        .components()
                        .any(|c| c == std::path::Component::ParentDir),
                "{repo:?} {file:?} escaped to {path:?}"
            );
            assert!(validate_entry(&entry).is_err());
        }
    }

    #[test]
    fn hf_model_files_must_match_their_kind() {
        let whisper = "ggerganov/whisper.cpp";
        assert!(hf_install_subpath(ModelKind::Stt, whisper, "ggml-tiny.bin").is_ok());
        assert!(hf_install_subpath(ModelKind::Stt, whisper, "tiny.bin").is_err());
        assert!(hf_install_subpath(ModelKind::Stt, "a/b", "m.gguf").is_err());
        assert!(hf_install_subpath(ModelKind::Diarization, "a/b", "m.gguf").is_err());
    }

    #[test]
    fn two_repos_with_the_same_file_name_install_to_different_paths() {
        let root = Path::new("/data");
        let file = "Qwen3.8-27B-Q4_K_M.gguf";
        let a = hf_llm_entry("unsloth/Qwen3.8-27B-GGUF", file);
        let b = hf_llm_entry("lmstudio-community/Qwen3.8-27B-GGUF", file);
        assert_ne!(installed_path(&a, root), installed_path(&b, root));
    }

    #[test]
    fn validate_entry_rejects_fields_that_disagree_with_repo_and_file() {
        let (repo, file) = ("someone/Model-GGUF", "model-Q4_K_M.gguf");
        let good = hf_llm_entry(repo, file);
        validate_entry(&good).unwrap();

        let mut other_host = good.clone();
        other_host.url = format!("https://evil.example/{repo}/resolve/main/{file}");
        assert!(validate_entry(&other_host).is_err());

        let mut other_file = good.clone();
        other_file.url = hf_download_url(repo, "main", "other.gguf");
        assert!(validate_entry(&other_file).is_err());

        let mut odd_revision = good.clone();
        odd_revision.url = hf_download_url(repo, "refs%2Fpr%2F1", file);
        assert!(validate_entry(&odd_revision).is_err());

        let mut pinned = good.clone();
        pinned.url = hf_download_url(repo, &"0f".repeat(20), file);
        validate_entry(&pinned).unwrap();

        let mut wrong_id = good.clone();
        wrong_id.id = "qwen3.5-4b".into();
        assert!(validate_entry(&wrong_id).is_err());

        let mut bad_sha = good.clone();
        bad_sha.sha256 = "xyz".into();
        assert!(validate_entry(&bad_sha).is_err());

        let mut wrong_publisher = good;
        if let ModelOrigin::HuggingFace { publisher, .. } = &mut wrong_publisher.origin {
            *publisher = "unsloth".into();
        }
        assert!(validate_entry(&wrong_publisher).is_err());
    }

    #[test]
    fn merged_catalog_is_the_built_in_list_when_nothing_was_added() {
        let dir = tempdir().unwrap();
        let merged = merged_catalog(dir.path()).unwrap();
        assert_eq!(merged.len(), load_catalog().unwrap().len());
    }

    #[test]
    fn a_remembered_entry_survives_reload_and_can_be_forgotten() {
        let dir = tempdir().unwrap();
        let entry = hf_llm_entry("unsloth/Qwen3.8-27B-GGUF", "Qwen3.8-27B-Q4_K_M.gguf");
        let built_in = load_catalog().unwrap().len();

        remember_added(dir.path(), &entry).unwrap();
        remember_added(dir.path(), &entry).unwrap();

        let merged = merged_catalog(dir.path()).unwrap();
        assert_eq!(merged.len(), built_in + 1);
        assert_eq!(merged.last().unwrap().id, entry.id);

        forget_added(dir.path(), &entry.id).unwrap();
        forget_added(dir.path(), &entry.id).unwrap();
        assert_eq!(merged_catalog(dir.path()).unwrap().len(), built_in);
    }

    #[test]
    fn remember_added_refuses_built_in_and_invalid_entries() {
        let dir = tempdir().unwrap();
        assert!(remember_added(dir.path(), &sample_entry()).is_err());
        let mut bad = hf_llm_entry("a/b", "m.gguf");
        bad.url = "https://evil.example/m.gguf".into();
        assert!(remember_added(dir.path(), &bad).is_err());
        assert!(!added_path(dir.path()).exists());
    }

    #[test]
    fn an_edited_added_file_cannot_grant_trust_or_inject_entries() {
        let dir = tempdir().unwrap();
        let mut untrusted = hf_llm_entry("someone/Model-GGUF", "model-Q4_K_M.gguf");
        if let ModelOrigin::HuggingFace { trusted, .. } = &mut untrusted.origin {
            *trusted = true;
        }
        let mut other_host = hf_llm_entry("a/b", "m.gguf");
        other_host.url = "https://evil.example/a/b/resolve/main/m.gguf".into();
        let mut shadow = sample_entry();
        shadow.url = "https://evil.example/ggml-small.bin".into();
        let path = added_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let file = vec![untrusted.clone(), other_host, shadow];
        fs::write(&path, serde_json::to_vec(&file).unwrap()).unwrap();

        let added = load_added(dir.path());
        assert_eq!(added.len(), 1);
        assert_eq!(added[0].id, untrusted.id);
        assert!(matches!(
            added[0].origin,
            ModelOrigin::HuggingFace { trusted: false, .. }
        ));
        let merged = merged_catalog(dir.path()).unwrap();
        let small: Vec<_> = merged.iter().filter(|e| e.id == "whisper-small").collect();
        assert_eq!(small.len(), 1);
        assert!(small[0].url.starts_with("https://huggingface.co/"));
    }

    #[test]
    fn a_corrupt_added_file_leaves_the_built_in_catalog_usable() {
        let dir = tempdir().unwrap();
        let path = added_path(dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{not json").unwrap();
        assert_eq!(
            merged_catalog(dir.path()).unwrap().len(),
            load_catalog().unwrap().len()
        );
    }

    #[test]
    fn hf_coordinates_reads_built_in_urls() {
        let entry = llm_entry("qwen3.5-4b");
        assert_eq!(
            hf_coordinates(&entry),
            Some((
                "unsloth/Qwen3.5-4B-GGUF".to_string(),
                "Qwen3.5-4B-Q4_K_M.gguf".to_string()
            ))
        );
    }

    #[test]
    fn catalog_parses_with_nine_entries() {
        let catalog = load_catalog().expect("catalog.json should parse");
        assert_eq!(catalog.len(), 9);
    }

    #[test]
    fn catalog_has_three_stt_four_llm_and_two_diarization_entries() {
        let catalog = load_catalog().unwrap();
        let stt = catalog.iter().filter(|e| e.kind == ModelKind::Stt).count();
        let llm = catalog.iter().filter(|e| e.kind == ModelKind::Llm).count();
        let diar = catalog
            .iter()
            .filter(|e| e.kind == ModelKind::Diarization)
            .count();
        assert_eq!(stt, 3);
        assert_eq!(llm, 4);
        assert_eq!(diar, 2);
    }

    #[test]
    fn catalog_urls_are_https_huggingface() {
        let catalog = load_catalog().unwrap();
        for entry in &catalog {
            assert!(
                entry.url.starts_with("https://huggingface.co/"),
                "entry {} has unexpected url {}",
                entry.id,
                entry.url
            );
        }
    }

    #[test]
    fn catalog_sha256_are_64_hex_chars() {
        let catalog = load_catalog().unwrap();
        for entry in &catalog {
            assert_eq!(
                entry.sha256.len(),
                64,
                "entry {} sha256 wrong length",
                entry.id
            );
            assert!(
                entry.sha256.chars().all(|c| c.is_ascii_hexdigit()),
                "entry {} sha256 has non-hex chars",
                entry.id
            );
        }
    }

    #[test]
    fn catalog_sizes_are_plausible_for_their_kind() {
        // STT/LLM weights are all in the hundreds-of-MB-to-GB range; the two
        // diarization models are deliberately tiny (6/28 MB) — a size that
        // small on an STT/LLM entry (or an implausibly large diarization
        // one) would mean a mispinned url/sizeBytes pair.
        let catalog = load_catalog().unwrap();
        for entry in &catalog {
            let (min, max) = match entry.kind {
                ModelKind::Diarization => (1024 * 1024, 100 * 1024 * 1024),
                _ => (100 * 1024 * 1024, u64::MAX),
            };
            assert!(
                entry.size_bytes > min && entry.size_bytes < max,
                "entry {} size implausible for its kind: {}",
                entry.id,
                entry.size_bytes
            );
        }
    }

    fn catalog() -> Vec<CatalogEntry> {
        load_catalog().unwrap()
    }

    #[test]
    fn recommend_low_ram_picks_small_and_qwen4b() {
        let hw = Hardware {
            total_ram_gb: 8,
            apple_silicon: true,
            cores: 8,
        };
        let rec = recommend(&catalog(), &hw);
        assert_eq!(rec.stt, "whisper-small");
        assert_eq!(rec.llm, "qwen3.5-4b");
    }

    #[test]
    fn recommend_16gb_picks_medium_and_gemma() {
        let hw = Hardware {
            total_ram_gb: 16,
            apple_silicon: true,
            cores: 8,
        };
        let rec = recommend(&catalog(), &hw);
        assert_eq!(rec.stt, "whisper-medium");
        assert_eq!(rec.llm, "gemma-4-e4b");
    }

    #[test]
    fn recommend_24gb_picks_medium_and_gemma() {
        let hw = Hardware {
            total_ram_gb: 24,
            apple_silicon: true,
            cores: 8,
        };
        let rec = recommend(&catalog(), &hw);
        assert_eq!(rec.stt, "whisper-medium");
        assert_eq!(rec.llm, "gemma-4-e4b");
    }

    #[test]
    fn recommend_32gb_picks_turbo_and_qwen9b() {
        let hw = Hardware {
            total_ram_gb: 32,
            apple_silicon: true,
            cores: 8,
        };
        let rec = recommend(&catalog(), &hw);
        assert_eq!(rec.stt, "whisper-large-v3-turbo");
        assert_eq!(rec.llm, "qwen3.5-9b");
    }

    #[test]
    fn recommend_48gb_intel_downgrades_turbo_to_medium() {
        let hw = Hardware {
            total_ram_gb: 48,
            apple_silicon: false,
            cores: 8,
        };
        let rec = recommend(&catalog(), &hw);
        assert_eq!(rec.stt, "whisper-medium");
        assert_eq!(rec.llm, "qwen3.5-9b");
    }

    #[test]
    fn recommend_boundary_just_under_16_is_low_tier() {
        let hw = Hardware {
            total_ram_gb: 15,
            apple_silicon: true,
            cores: 8,
        };
        let rec = recommend(&catalog(), &hw);
        assert_eq!(rec.stt, "whisper-small");
        assert_eq!(rec.llm, "qwen3.5-4b");
    }

    #[test]
    fn recommend_boundary_just_under_32_is_mid_tier() {
        let hw = Hardware {
            total_ram_gb: 31,
            apple_silicon: true,
            cores: 8,
        };
        let rec = recommend(&catalog(), &hw);
        assert_eq!(rec.stt, "whisper-medium");
        assert_eq!(rec.llm, "gemma-4-e4b");
    }

    #[test]
    fn recommend_falls_back_safely_when_tier_id_missing_from_catalog() {
        // A catalog missing the top-tier STT id (typo, removed entry, etc.)
        // must not "fit" by default — it should fall through to the
        // hardcoded fallback pick instead of blindly recommending an id
        // that isn't actually described anywhere.
        let hw = Hardware {
            total_ram_gb: 32,
            apple_silicon: true,
            cores: 8,
        };
        let partial: Vec<CatalogEntry> = catalog()
            .into_iter()
            .filter(|e| e.id != "whisper-large-v3-turbo")
            .collect();
        let rec = recommend(&partial, &hw);
        assert_eq!(rec.stt, "whisper-medium");
        assert_eq!(rec.llm, "qwen3.5-9b");
    }

    #[test]
    fn recommend_with_empty_catalog_falls_back_to_defaults() {
        let hw = Hardware {
            total_ram_gb: 32,
            apple_silicon: true,
            cores: 8,
        };
        let rec = recommend(&[], &hw);
        assert_eq!(rec.stt, "whisper-medium");
        assert_eq!(rec.llm, "qwen3.5-4b");
    }

    fn sample_entry() -> CatalogEntry {
        catalog()
            .into_iter()
            .find(|e| e.id == "whisper-small")
            .expect("catalog.json must contain whisper-small")
    }

    #[test]
    fn install_state_missing_file_is_not_installed() {
        let dir = tempdir().unwrap();
        let entry = sample_entry();
        assert_eq!(
            install_state(&entry, dir.path()),
            InstallState::NotInstalled
        );
    }

    #[test]
    fn install_state_wrong_size_is_not_installed() {
        let dir = tempdir().unwrap();
        let entry = sample_entry();
        let path = installed_path(&entry, dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, vec![0u8; 100]).unwrap();
        assert_eq!(
            install_state(&entry, dir.path()),
            InstallState::NotInstalled
        );
    }

    #[test]
    fn install_state_exact_size_is_installed() {
        let dir = tempdir().unwrap();
        let entry = sample_entry();
        let path = installed_path(&entry, dir.path());
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, vec![0u8; entry.size_bytes as usize]).unwrap();
        assert_eq!(install_state(&entry, dir.path()), InstallState::Installed);
    }

    #[test]
    fn detect_hardware_smoke() {
        let hw = detect_hardware();
        assert!(hw.total_ram_gb > 0);
        assert!(hw.cores > 0);
    }

    // --- resolve_llm_entry --------------------------------------------------

    fn llm_entry(id: &str) -> CatalogEntry {
        catalog()
            .into_iter()
            .find(|e| e.id == id && e.kind == ModelKind::Llm)
            .unwrap_or_else(|| panic!("catalog.json must contain LLM entry {id}"))
    }

    fn fake_install(entry: &CatalogEntry, models_root: &Path) {
        let path = installed_path(entry, models_root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, vec![0u8; entry.size_bytes as usize]).unwrap();
    }

    fn recommendation_of(llm: &str) -> Recommendation {
        Recommendation {
            stt: "whisper-small".to_string(),
            llm: llm.to_string(),
        }
    }

    #[test]
    fn resolve_llm_entry_prefers_the_persisted_installed_model() {
        let dir = tempdir().unwrap();
        let catalog = catalog();
        fake_install(&llm_entry("qwen3.5-4b"), dir.path());
        fake_install(&llm_entry("qwen3.5-9b"), dir.path());
        let resolved = resolve_llm_entry(
            &catalog,
            &recommendation_of("qwen3.5-9b"),
            Some("qwen3.5-4b"),
            dir.path(),
        );
        assert_eq!(resolved.map(|e| e.id), Some("qwen3.5-4b".to_string()));
    }

    #[test]
    fn resolve_llm_entry_falls_back_to_installed_recommended_when_nothing_persisted() {
        let dir = tempdir().unwrap();
        let catalog = catalog();
        fake_install(&llm_entry("qwen3.5-9b"), dir.path());
        let resolved =
            resolve_llm_entry(&catalog, &recommendation_of("qwen3.5-9b"), None, dir.path());
        assert_eq!(resolved.map(|e| e.id), Some("qwen3.5-9b".to_string()));
    }

    #[test]
    fn resolve_llm_entry_falls_back_when_persisted_model_is_not_installed() {
        let dir = tempdir().unwrap();
        let catalog = catalog();
        fake_install(&llm_entry("qwen3.5-9b"), dir.path());
        let resolved = resolve_llm_entry(
            &catalog,
            &recommendation_of("qwen3.5-9b"),
            Some("gemma-4-e4b"),
            dir.path(),
        );
        assert_eq!(resolved.map(|e| e.id), Some("qwen3.5-9b".to_string()));
    }

    #[test]
    fn resolve_llm_entry_none_when_nothing_installed() {
        let dir = tempdir().unwrap();
        let catalog = catalog();
        let resolved =
            resolve_llm_entry(&catalog, &recommendation_of("qwen3.5-9b"), None, dir.path());
        assert_eq!(resolved.map(|e| e.id), None);
    }

    #[test]
    fn resolve_llm_entry_never_resolves_an_stt_entry() {
        let dir = tempdir().unwrap();
        let catalog = catalog();
        fake_install(&sample_entry(), dir.path());
        let resolved = resolve_llm_entry(
            &catalog,
            &recommendation_of("whisper-small"),
            Some("whisper-small"),
            dir.path(),
        );
        assert_eq!(resolved.map(|e| e.id), None);
    }
}
