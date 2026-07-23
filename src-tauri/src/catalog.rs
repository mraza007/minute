//! Model catalog (STT + LLM entries) and hardware-aware model recommendations.

use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use sysinfo::System;

use crate::error::{MinuteError, Result};

const CATALOG_JSON: &str = include_str!("../catalog.json");

/// Whether a catalog entry is a speech-to-text model or a summarization LLM.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ModelKind {
    Stt,
    Llm,
}

/// One downloadable model, as described in `catalog.json`.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CatalogEntry {
    pub id: String,
    pub kind: ModelKind,
    #[serde(rename = "displayName")]
    pub display_name: String,
    pub desc: String,
    pub url: String,
    pub sha256: String,
    #[serde(rename = "sizeBytes")]
    pub size_bytes: u64,
    #[serde(rename = "minRamGb")]
    pub min_ram_gb: u64,
    #[serde(rename = "requiresAppleSilicon")]
    pub requires_apple_silicon: bool,
}

/// Detected machine capabilities used to pick a sensible default model pair.
#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
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
pub fn recommend(hw: &Hardware) -> Recommendation {
    let (stt_tier, llm_tier) = if hw.total_ram_gb < 16 {
        ("whisper-small", "qwen3.5-4b")
    } else if hw.total_ram_gb < 32 {
        ("whisper-medium", "gemma-4-e4b")
    } else {
        ("whisper-large-v3-turbo", "qwen3.5-9b")
    };

    let catalog = load_catalog().unwrap_or_default();
    let fits = |id: &str| -> bool {
        catalog
            .iter()
            .find(|e| e.id == id)
            .map(|e| {
                hw.total_ram_gb >= e.min_ram_gb && (!e.requires_apple_silicon || hw.apple_silicon)
            })
            .unwrap_or(true)
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
    };
    let file_name = entry
        .url
        .rsplit('/')
        .next()
        .unwrap_or(entry.id.as_str());
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn catalog_parses_with_six_entries() {
        let catalog = load_catalog().expect("catalog.json should parse");
        assert_eq!(catalog.len(), 6);
    }

    #[test]
    fn catalog_has_three_stt_and_three_llm_entries() {
        let catalog = load_catalog().unwrap();
        let stt = catalog.iter().filter(|e| e.kind == ModelKind::Stt).count();
        let llm = catalog.iter().filter(|e| e.kind == ModelKind::Llm).count();
        assert_eq!(stt, 3);
        assert_eq!(llm, 3);
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
    fn catalog_sizes_are_over_100mb() {
        let catalog = load_catalog().unwrap();
        for entry in &catalog {
            assert!(
                entry.size_bytes > 100 * 1024 * 1024,
                "entry {} size too small: {}",
                entry.id,
                entry.size_bytes
            );
        }
    }

    #[test]
    fn recommend_low_ram_picks_small_and_qwen4b() {
        let hw = Hardware {
            total_ram_gb: 8,
            apple_silicon: true,
            cores: 8,
        };
        let rec = recommend(&hw);
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
        let rec = recommend(&hw);
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
        let rec = recommend(&hw);
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
        let rec = recommend(&hw);
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
        let rec = recommend(&hw);
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
        let rec = recommend(&hw);
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
        let rec = recommend(&hw);
        assert_eq!(rec.stt, "whisper-medium");
        assert_eq!(rec.llm, "gemma-4-e4b");
    }

    fn sample_entry() -> CatalogEntry {
        CatalogEntry {
            id: "whisper-small".into(),
            kind: ModelKind::Stt,
            display_name: "Whisper small".into(),
            desc: "desc".into(),
            url: "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin"
                .into(),
            sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b".into(),
            size_bytes: 487_601_967,
            min_ram_gb: 0,
            requires_apple_silicon: false,
        }
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
}
