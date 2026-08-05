//! Model catalog (STT + LLM entries) and hardware-aware model recommendations.

use std::path::{Path, PathBuf};

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
    pub desc: String,
    pub url: String,
    pub sha256: String,
    pub size_bytes: u64,
    pub min_ram_gb: u64,
    pub requires_apple_silicon: bool,
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
    let file_name = entry.url.rsplit('/').next().unwrap_or(entry.id.as_str());
    models_root.join("models").join(dir).join(file_name)
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
