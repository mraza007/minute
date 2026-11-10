//! Browsing Hugging Face for models beyond the built-in catalog.
//!
//! Nothing here runs on its own: the only entry point is the
//! `browse_models` command, which the Models page calls. The parsing and
//! selection steps are pure functions over recorded API responses, and
//! `fetch_*` is the thin network layer on top of them.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use futures_util::StreamExt;
use serde::de::{DeserializeOwned, IgnoredAny};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::catalog::{self, CatalogEntry, ModelKind, ModelOrigin, ModelStatus};
use crate::download;
use crate::error::{MinuteError, Result};

const API: &str = "https://huggingface.co/api/models";
const EXPAND: &str =
    "&expand[]=gguf&expand[]=lastModified&expand[]=downloads&expand[]=sha&expand[]=gated";
const WHISPER_REPO: &str = "ggerganov/whisper.cpp";

/// One list request returns this many trending GGUF repos (about 2.8 MB
/// with `expand[]=gguf`, measured 2026-11). The trusted, runnable ones are a
/// small share of it, which is why the page is this large.
const TRENDING_LIMIT: usize = 200;
const SEARCH_LIMIT: usize = 30;
/// Each listed repo costs one more request for its file tree, so one browse
/// makes at most `1 + MAX_REPOS` requests. Hugging Face allows 500 per five
/// minutes without a token.
const MAX_REPOS: usize = 16;
const TREE_CONCURRENCY: usize = 4;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(20);
const CACHE_TTL: time::Duration = time::Duration::hours(24);

/// PROVISIONAL. GGUF `general.architecture` values the app is known or
/// expected to prompt correctly. `qwen35`, `gemma4`, and `lfm2` are the
/// families the built-in catalog runs. The rest are their closest relatives
/// in the vendored llama.cpp (`llama-arch.cpp`): the mixture-of-experts
/// variants share their dense sibling's chat format, and `qwen3` uses the
/// same ChatML turns as `qwen35`. Everything else is hidden and counted in
/// `unsupported_count` until someone runs it through the app.
pub const SUPPORTED_ARCHITECTURES: &[&str] = &[
    "qwen35",
    "qwen35moe",
    "qwen3",
    "qwen3moe",
    "gemma4",
    "lfm2",
    "lfm2moe",
];

/// Quantizations to offer, best first. Roughly 4 to 5 bits per weight: the
/// same trade-off as every built-in LLM entry.
const QUANT_PREFERENCE: &[&str] = &["Q4_K_M", "Q4_K_S", "Q5_K_M", "IQ4_XS"];

#[derive(Debug, Deserialize)]
struct Repo {
    id: String,
    /// `false` for an open repo, `"auto"` or `"manual"` for a gated one.
    #[serde(default)]
    gated: serde_json::Value,
    #[serde(rename = "lastModified")]
    last_modified: Option<String>,
    downloads: Option<u64>,
    sha: Option<String>,
    gguf: Option<Gguf>,
}

#[derive(Debug, Deserialize)]
struct Gguf {
    total: Option<u64>,
    architecture: Option<String>,
    /// Only its presence matters, and the text runs to tens of kilobytes.
    chat_template: Option<IgnoredAny>,
}

#[derive(Debug, Deserialize)]
struct TreeItem {
    #[serde(rename = "type")]
    kind: String,
    path: String,
    #[serde(default)]
    size: u64,
    lfs: Option<Lfs>,
}

#[derive(Debug, Deserialize)]
struct Lfs {
    /// The file's sha256.
    oid: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Scope {
    TrustedOnly,
    AnyPublisher,
}

struct Selection {
    repos: Vec<Repo>,
    unsupported_count: u32,
}

/// Splits a repo listing into the repos worth a file-tree request and a
/// count of chat models hidden only because of their architecture.
fn select_repos(repos: Vec<Repo>, scope: Scope) -> Selection {
    let mut selection = Selection {
        repos: Vec::new(),
        unsupported_count: 0,
    };
    for repo in repos {
        let publisher = repo.id.split('/').next().unwrap_or_default();
        if scope == Scope::TrustedOnly && !catalog::is_trusted_publisher(publisher) {
            continue;
        }
        let open = matches!(
            repo.gated,
            serde_json::Value::Null | serde_json::Value::Bool(false)
        );
        // No chat template means an embedding, speech, or image model that
        // happens to ship as GGUF: not a summarizer, so not counted either.
        let Some(architecture) = repo
            .gguf
            .as_ref()
            .filter(|g| open && g.chat_template.is_some())
            .and_then(|g| g.architecture.as_deref())
        else {
            continue;
        };
        if !SUPPORTED_ARCHITECTURES.contains(&architecture) {
            selection.unsupported_count += 1;
        } else if selection.repos.len() < MAX_REPOS {
            selection.repos.push(repo);
        }
    }
    selection
}

/// The quantization a GGUF file name ends with, if it is one we offer.
fn offered_quant(file: &str) -> Option<&'static str> {
    let stem = file.strip_suffix(".gguf")?.to_ascii_uppercase();
    QUANT_PREFERENCE.iter().copied().find(|quant| {
        stem.strip_suffix(quant)
            .is_some_and(|rest| rest.ends_with(['-', '.', '_']))
    })
}

/// Picks the one file to offer from a repo. Requiring a preferred
/// quantization as the name's suffix is also what excludes split files
/// (`-00001-of-00003`), `mmproj` projectors, imatrix data, and F16/BF16
/// exports, none of which end that way.
fn pick_file(tree: &[TreeItem]) -> Option<(&TreeItem, &'static str)> {
    tree.iter()
        .filter(|item| item.kind == "file" && item.lfs.is_some() && !item.path.contains('/'))
        .filter(|item| !item.path.to_ascii_lowercase().contains("mmproj"))
        .filter_map(|item| Some((item, offered_quant(&item.path)?)))
        .min_by_key(|(item, quant)| {
            let rank = QUANT_PREFERENCE.iter().position(|q| q == quant);
            (rank, item.path.len(), item.path.clone())
        })
}

fn pinned_revision(repo: &Repo) -> &str {
    repo.sha
        .as_deref()
        .filter(|sha| sha.len() == 40 && sha.chars().all(|c| c.is_ascii_hexdigit()))
        .unwrap_or("main")
}

fn display_name_for_repo(repo_name: &str) -> String {
    let lower = repo_name.to_ascii_lowercase();
    ["-gguf", "_gguf", ".gguf"]
        .iter()
        .find(|suffix| lower.ends_with(*suffix) && lower.len() > suffix.len())
        .map(|suffix| &repo_name[..repo_name.len() - suffix.len()])
        .unwrap_or(repo_name)
        .to_string()
}

/// Mac memory configurations, for rounding a requirement up to one a user
/// will recognize.
const MAC_RAM_GB: &[u64] = &[8, 16, 18, 24, 32, 36, 48, 64, 96, 128, 192, 256, 512];
const GIB: f64 = (1024u64 * 1024 * 1024) as f64;

/// Estimated minimum total RAM for an LLM. A heuristic, not a measurement:
///
/// - weights: the file size plus 10%, since the whole file is mapped into
///   unified memory and Metal keeps some copies;
/// - context and compute buffers: 1 GiB plus 0.1 GiB per billion parameters
///   (1.5 GiB when the count is unknown), capped at 4 GiB;
/// - the sum must fit in 60% of total RAM, leaving the rest for macOS, the
///   app, and the speech model.
///
/// It reproduces every built-in entry's hand-set `minRamGb`.
pub fn llm_min_ram_gb(size_bytes: u64, parameters: Option<u64>) -> u64 {
    let weights = size_bytes as f64 / GIB * 1.1;
    let buffers = match parameters {
        Some(count) => (1.0 + 0.1 * count as f64 / 1e9).min(4.0),
        None => 1.5,
    };
    let needed = ((weights + buffers) / 0.6).ceil() as u64;
    MAC_RAM_GB
        .iter()
        .copied()
        .find(|size| *size >= needed)
        .unwrap_or(needed)
}

/// Whisper tiers, set to agree with the built-in entries (small 0.5 GB: any
/// Mac, medium 1.5 GB: 16 GB).
fn whisper_min_ram_gb(size_bytes: u64) -> u64 {
    match size_bytes {
        0..=999_999_999 => 0,
        1_000_000_000..=1_499_999_999 => 8,
        _ => 16,
    }
}

fn llm_entry(repo: &Repo, tree: &[TreeItem]) -> Option<CatalogEntry> {
    let (item, quant) = pick_file(tree)?;
    let (publisher, repo_name) = repo.id.split_once('/')?;
    let gguf = repo.gguf.as_ref()?;
    let entry = CatalogEntry {
        id: catalog::hf_entry_id(&repo.id, &item.path),
        kind: ModelKind::Llm,
        display_name: display_name_for_repo(repo_name),
        traits: Vec::new(),
        url: catalog::hf_download_url(&repo.id, pinned_revision(repo), &item.path),
        sha256: item.lfs.as_ref()?.oid.clone(),
        size_bytes: item.size,
        min_ram_gb: llm_min_ram_gb(item.size, gguf.total),
        requires_apple_silicon: false,
        origin: ModelOrigin::HuggingFace {
            repo: repo.id.clone(),
            file: item.path.clone(),
            publisher: publisher.to_string(),
            trusted: catalog::is_trusted_publisher(publisher),
            architecture: gguf.architecture.clone(),
            parameters: gguf.total,
            quantization: Some(quant.to_string()),
            updated_at: repo.last_modified.clone(),
            downloads: repo.downloads,
        },
    };
    catalog::validate_entry(&entry).ok()?;
    Some(entry)
}

struct WhisperName {
    display_name: String,
    quantization: Option<String>,
    large: bool,
}

/// Reads a whisper.cpp model file name such as
/// `ggml-large-v3-turbo-q5_0.bin`. Returns `None` for anything that is not
/// plainly `<size>[-version][-turbo][.en][-q<N>_<N>]`, so helper files and
/// future variants the app has not seen stay hidden.
fn parse_whisper_name(file: &str) -> Option<WhisperName> {
    let stem = file.strip_prefix("ggml-")?.strip_suffix(".bin")?;
    let is_quant = |s: &str| {
        let b = s.as_bytes();
        b.len() == 4
            && b[0] == b'q'
            && b[1].is_ascii_digit()
            && b[2] == b'_'
            && b[3].is_ascii_digit()
    };
    let (stem, quantization) = match stem.rsplit_once('-') {
        Some((rest, quant)) if is_quant(quant) => (rest, Some(quant.to_string())),
        _ => (stem, None),
    };
    let (stem, english_only) = match stem.strip_suffix(".en") {
        Some(rest) => (rest, true),
        None => (stem, false),
    };
    let (stem, turbo) = match stem.strip_suffix("-turbo") {
        Some(rest) => (rest, true),
        None => (stem, false),
    };
    let (size, version) = match stem.split_once('-') {
        Some((size, version)) => (size, Some(version)),
        None => (stem, None),
    };
    if !["tiny", "base", "small", "medium", "large"].contains(&size) {
        return None;
    }
    if let Some(version) = version {
        let digits = version.strip_prefix('v')?;
        if digits.is_empty() || !digits.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
    }
    let mut display_name = format!("Whisper {stem}");
    if turbo {
        display_name.push_str(" turbo");
    }
    if english_only {
        display_name.push_str(", English only");
    }
    if let Some(quant) = &quantization {
        display_name.push_str(&format!(", compressed ({quant})"));
    }
    Some(WhisperName {
        display_name,
        quantization,
        large: size == "large",
    })
}

fn whisper_entries(tree: &[TreeItem]) -> Vec<CatalogEntry> {
    let publisher = WHISPER_REPO.split('/').next().unwrap_or_default();
    tree.iter()
        .filter(|item| item.kind == "file")
        .filter_map(|item| {
            let name = parse_whisper_name(&item.path)?;
            let entry = CatalogEntry {
                id: catalog::hf_entry_id(WHISPER_REPO, &item.path),
                kind: ModelKind::Stt,
                display_name: name.display_name,
                traits: Vec::new(),
                url: catalog::hf_download_url(WHISPER_REPO, "main", &item.path),
                sha256: item.lfs.as_ref()?.oid.clone(),
                size_bytes: item.size,
                min_ram_gb: whisper_min_ram_gb(item.size),
                // Same call as the built-in large-v3-turbo: too slow to keep
                // up with live speech on an Intel Mac.
                requires_apple_silicon: name.large,
                origin: ModelOrigin::HuggingFace {
                    repo: WHISPER_REPO.to_string(),
                    file: item.path.clone(),
                    publisher: publisher.to_string(),
                    trusted: catalog::is_trusted_publisher(publisher),
                    architecture: None,
                    parameters: None,
                    quantization: name.quantization,
                    updated_at: None,
                    downloads: None,
                },
            };
            catalog::validate_entry(&entry).ok()?;
            Some(entry)
        })
        .collect()
}

/// One successful fetch, as cached on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    fetched_at: String,
    entries: Vec<CatalogEntry>,
    unsupported_count: u32,
}

#[derive(Default, Serialize, Deserialize)]
struct CacheFile {
    stt: Option<Snapshot>,
    llm: Option<Snapshot>,
}

impl CacheFile {
    fn slot(&mut self, kind: ModelKind) -> Option<&mut Option<Snapshot>> {
        match kind {
            ModelKind::Stt => Some(&mut self.stt),
            ModelKind::Llm => Some(&mut self.llm),
            ModelKind::Diarization => None,
        }
    }
}

static CACHE_LOCK: Mutex<()> = Mutex::new(());

fn cache_path(models_root: &Path) -> PathBuf {
    models_root.join("models").join("hf-browse-cache.json")
}

fn load_snapshot(models_root: &Path, kind: ModelKind) -> Option<Snapshot> {
    let mut file: CacheFile = catalog::read_json_file(&cache_path(models_root))?;
    let mut snapshot = file.slot(kind)?.take()?;
    snapshot.entries = catalog::admit_hf_entries(snapshot.entries);
    Some(snapshot)
}

fn save_snapshot(models_root: &Path, kind: ModelKind, snapshot: &Snapshot) -> Result<()> {
    let _guard = CACHE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let path = cache_path(models_root);
    let mut file: CacheFile = catalog::read_json_file(&path).unwrap_or_default();
    if let Some(slot) = file.slot(kind) {
        *slot = Some(snapshot.clone());
    }
    catalog::write_json_file(&path, &file)
}

/// A snapshot from the future (clock change) or with an unreadable
/// timestamp is treated as stale.
fn is_fresh(snapshot: &Snapshot, now: OffsetDateTime) -> bool {
    OffsetDateTime::parse(&snapshot.fetched_at, &Rfc3339)
        .map(|fetched| {
            let age = now - fetched;
            age >= time::Duration::ZERO && age < CACHE_TTL
        })
        .unwrap_or(false)
}

/// Whether every word of `query` appears in the entry's name, repo, or file.
fn matches_query(entry: &CatalogEntry, query: &str) -> bool {
    let mut haystack = entry.display_name.to_lowercase();
    if let ModelOrigin::HuggingFace { repo, file, .. } = &entry.origin {
        haystack.push_str(&format!(" {repo} {file}").to_lowercase());
    }
    query
        .to_lowercase()
        .split_whitespace()
        .all(|word| haystack.contains(word))
}

/// What `browse_models` returns.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelBrowse {
    pub entries: Vec<ModelStatus>,
    /// RFC 3339 time of the fetch these entries came from.
    pub fetched_at: Option<String>,
    /// Matching chat models hidden because the bundled llama.cpp cannot
    /// run their architecture.
    pub unsupported_count: u32,
    pub error: Option<String>,
}

/// Shapes a snapshot for the Models page: drops everything `list_models`
/// already shows (by id, or by pointing at the same file as a built-in
/// entry) and applies `local_query` when Hugging Face did not do the
/// matching itself.
fn present(
    snapshot: Option<Snapshot>,
    error: Option<String>,
    known: &[CatalogEntry],
    local_query: Option<&str>,
    models_root: &Path,
) -> ModelBrowse {
    let Some(snapshot) = snapshot else {
        return ModelBrowse {
            entries: Vec::new(),
            fetched_at: None,
            unsupported_count: 0,
            error,
        };
    };
    let known_files: Vec<_> = known.iter().filter_map(catalog::hf_coordinates).collect();
    let entries = snapshot
        .entries
        .into_iter()
        .filter(|entry| !known.iter().any(|k| k.id == entry.id))
        .filter(|entry| {
            catalog::hf_coordinates(entry).is_some_and(|file| !known_files.contains(&file))
        })
        .filter(|entry| local_query.map_or(true, |q| matches_query(entry, q)))
        .map(|entry| ModelStatus {
            state: catalog::install_state(&entry, models_root),
            entry,
        })
        .collect();
    ModelBrowse {
        entries,
        fetched_at: Some(snapshot.fetched_at),
        unsupported_count: snapshot.unsupported_count,
        error,
    }
}

/// The entries from this session's browse results, by id, so
/// `download_model` can resolve an id the user picked from them.
#[derive(Clone, Default)]
pub struct BrowseIndex(Arc<Mutex<HashMap<String, CatalogEntry>>>);

impl BrowseIndex {
    pub(crate) fn record(&self, entries: &[ModelStatus]) {
        let mut map = self.0.lock().unwrap_or_else(|e| e.into_inner());
        for status in entries {
            map.insert(status.entry.id.clone(), status.entry.clone());
        }
    }

    pub fn get(&self, id: &str) -> Option<CatalogEntry> {
        self.0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(id)
            .cloned()
    }
}

fn percent_encode(text: &str) -> String {
    text.bytes()
        .map(|b| match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                (b as char).to_string()
            }
            _ => format!("%{b:02X}"),
        })
        .collect()
}

async fn get_json<T: DeserializeOwned>(client: &reqwest::Client, url: &str) -> Result<T> {
    let offline = |e: reqwest::Error| {
        log::warn!("Hugging Face request failed: {e}");
        MinuteError::Other("Could not reach Hugging Face. Check your connection.".to_string())
    };
    let response = client
        .get(url)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(offline)?;
    let status = response.status();
    if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
        return Err(MinuteError::Other(
            "Hugging Face is limiting requests. Try again in a few minutes.".to_string(),
        ));
    }
    if !status.is_success() {
        return Err(MinuteError::Other(format!(
            "Hugging Face returned an error (HTTP {}).",
            status.as_u16()
        )));
    }
    let body = response.bytes().await.map_err(offline)?;
    serde_json::from_slice(&body).map_err(|e| {
        log::warn!("unexpected Hugging Face response from {url}: {e}");
        MinuteError::Other("Hugging Face sent a response Minute could not read.".to_string())
    })
}

/// Trending GGUF repos from trusted publishers, or with `query` a search
/// across every publisher.
async fn fetch_llm(
    client: &reqwest::Client,
    query: Option<&str>,
) -> Result<(Vec<CatalogEntry>, u32)> {
    let (url, scope) = match query {
        Some(q) => (
            format!(
                "{API}?filter=gguf&sort=downloads&limit={SEARCH_LIMIT}&search={}{EXPAND}",
                percent_encode(q)
            ),
            Scope::AnyPublisher,
        ),
        None => (
            format!("{API}?filter=gguf&sort=trendingScore&limit={TRENDING_LIMIT}{EXPAND}"),
            Scope::TrustedOnly,
        ),
    };
    let repos: Vec<Repo> = get_json(client, &url).await?;
    let selection = select_repos(repos, scope);

    let trees: Vec<(Repo, Result<Vec<TreeItem>>)> = futures_util::stream::iter(selection.repos)
        .map(|repo| async move {
            let url = format!("{API}/{}/tree/{}", repo.id, pinned_revision(&repo));
            let tree = get_json(client, &url).await;
            (repo, tree)
        })
        .buffered(TREE_CONCURRENCY)
        .collect()
        .await;

    // One repo failing just drops that repo. Every repo failing is the
    // network going away mid-browse, which the caller must hear about.
    let mut entries = Vec::new();
    let mut failure = None;
    let mut any_tree = trees.is_empty();
    for (repo, tree) in trees {
        match tree {
            Ok(tree) => {
                any_tree = true;
                entries.extend(llm_entry(&repo, &tree));
            }
            Err(e) => failure = failure.or(Some(e)),
        }
    }
    match failure {
        Some(e) if !any_tree => Err(e),
        _ => Ok((entries, selection.unsupported_count)),
    }
}

async fn fetch_stt(client: &reqwest::Client) -> Result<(Vec<CatalogEntry>, u32)> {
    let tree: Vec<TreeItem> = get_json(client, &format!("{API}/{WHISPER_REPO}/tree/main")).await?;
    Ok((whisper_entries(&tree), 0))
}

/// Whether a browse must go to the network. A search always does. The
/// default list does when asked to refresh or when the cache is missing or
/// older than a day.
fn needs_fetch(
    cached: Option<&Snapshot>,
    searching: bool,
    refresh: bool,
    now: OffsetDateTime,
) -> bool {
    searching || refresh || !cached.is_some_and(|snapshot| is_fresh(snapshot, now))
}

/// The whole of `browse_models` apart from Tauri state lookup. Offline is a
/// result, not an error: the cached list (if any) comes back with `error`
/// set.
pub async fn browse(
    models_root: &Path,
    index: &BrowseIndex,
    kind: ModelKind,
    query: Option<&str>,
    refresh: bool,
    now: OffsetDateTime,
) -> Result<ModelBrowse> {
    if kind == ModelKind::Diarization {
        return Err(MinuteError::Other(
            "speaker models cannot be browsed".to_string(),
        ));
    }
    let query = query.map(str::trim).filter(|q| !q.is_empty());
    // Whisper models all live in one repo, so a query filters that list
    // locally. Only an LLM query is a Hugging Face search.
    let search = query.filter(|_| kind == ModelKind::Llm);
    let cached = load_snapshot(models_root, kind);

    let (snapshot, error, local_query) =
        if needs_fetch(cached.as_ref(), search.is_some(), refresh, now) {
            let client = download::http_client();
            let fetched = match kind {
                ModelKind::Llm => fetch_llm(&client, search).await,
                _ => fetch_stt(&client).await,
            };
            match fetched {
                Ok((entries, unsupported_count)) => {
                    let snapshot = Snapshot {
                        fetched_at: now.format(&Rfc3339).map_err(|e| {
                            MinuteError::Other(format!("failed to format time: {e}"))
                        })?,
                        entries,
                        unsupported_count,
                    };
                    if search.is_none() {
                        if let Err(e) = save_snapshot(models_root, kind, &snapshot) {
                            log::warn!("failed to save the Hugging Face browse cache: {e}");
                        }
                    }
                    let local_query = query.filter(|_| search.is_none());
                    (Some(snapshot), None, local_query)
                }
                Err(e) => (cached, Some(e.to_string()), query),
            }
        } else {
            (cached, None, query)
        };

    let known = catalog::merged_catalog(models_root)?;
    let result = present(snapshot, error, &known, local_query, models_root);
    index.record(&result.entries);
    Ok(result)
}

/// Lists Hugging Face models the user does not have yet. This command is
/// the only thing in the app that contacts the Hugging Face API, and it
/// runs only when the Models page calls it.
#[tauri::command]
pub async fn browse_models(
    app: AppHandle,
    index: State<'_, BrowseIndex>,
    kind: ModelKind,
    query: Option<String>,
    refresh: bool,
) -> std::result::Result<ModelBrowse, String> {
    let models_root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    browse(
        &models_root,
        index.inner(),
        kind,
        query.as_deref(),
        refresh,
        OffsetDateTime::now_utc(),
    )
    .await
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    const TRENDING: &str = include_str!("../tests/fixtures/hf/trending.json");
    const SEARCH: &str = include_str!("../tests/fixtures/hf/search.json");
    const TREE_QWEN35_4B: &str = include_str!("../tests/fixtures/hf/tree-unsloth-qwen35-4b.json");
    const TREE_QWEN38_27B: &str = include_str!("../tests/fixtures/hf/tree-unsloth-qwen38-27b.json");
    const TREE_BOLT: &str = include_str!("../tests/fixtures/hf/tree-nvidia-bolt.json");
    const TREE_MIMO: &str = include_str!("../tests/fixtures/hf/tree-bartowski-mimo.json");
    const TREE_WHISPER: &str = include_str!("../tests/fixtures/hf/tree-whisper.json");

    fn repos(json: &str) -> Vec<Repo> {
        serde_json::from_str(json).unwrap()
    }

    fn tree(json: &str) -> Vec<TreeItem> {
        serde_json::from_str(json).unwrap()
    }

    fn ids(selection: &Selection) -> Vec<&str> {
        selection.repos.iter().map(|r| r.id.as_str()).collect()
    }

    fn file(path: &str) -> TreeItem {
        TreeItem {
            kind: "file".to_string(),
            path: path.to_string(),
            size: 1_000,
            lfs: Some(Lfs {
                oid: "b".repeat(64),
            }),
        }
    }

    fn repo(id: &str) -> Repo {
        repos(TRENDING).into_iter().find(|r| r.id == id).unwrap()
    }

    // --- repo selection -----------------------------------------------------

    #[test]
    fn trending_keeps_trusted_runnable_repos_and_counts_unsupported_ones() {
        let selection = select_repos(repos(TRENDING), Scope::TrustedOnly);
        assert_eq!(
            ids(&selection),
            [
                "unsloth/Qwen3.8-27B-GGUF",
                "nvidia/NVIDIA-Nemotron-3.5-Bolt-E4B-4GB",
                "unsloth/Qwen3.6-35B-A3B-GGUF",
                "lmstudio-community/Qwen3.8-27B-GGUF",
                "bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF",
            ]
        );
        // qwen4exp and lfm3. The speech model has no chat template, so it
        // is not a hidden chat model.
        assert_eq!(selection.unsupported_count, 2);
    }

    #[test]
    fn search_also_keeps_unknown_publishers() {
        let selection = select_repos(repos(TRENDING), Scope::AnyPublisher);
        assert!(ids(&selection).iter().any(|id| id.starts_with("DavidAU/")));

        let found = select_repos(repos(SEARCH), Scope::AnyPublisher);
        assert!(ids(&found).contains(&"unsloth/Qwen3.5-4B-GGUF"));
        assert!(ids(&found).contains(&"turintech/Qwen3.5-4B-Artemis-GGUF"));
    }

    #[test]
    fn gated_repos_are_skipped() {
        let mut gated = repo("unsloth/Qwen3.8-27B-GGUF");
        gated.gated = serde_json::json!("auto");
        let selection = select_repos(vec![gated], Scope::TrustedOnly);
        assert!(selection.repos.is_empty());
        assert_eq!(selection.unsupported_count, 0);
    }

    #[test]
    fn selection_is_capped_so_one_browse_stays_within_its_request_budget() {
        let many: Vec<Repo> = (0..MAX_REPOS + 5)
            .map(|_| repo("unsloth/Qwen3.8-27B-GGUF"))
            .collect();
        assert_eq!(
            select_repos(many, Scope::TrustedOnly).repos.len(),
            MAX_REPOS
        );
    }

    // --- file choice --------------------------------------------------------

    #[test]
    fn picks_q4_k_m_from_real_repos() {
        let picked = |json: &str| {
            let tree = tree(json);
            pick_file(&tree).map(|(item, quant)| (item.path.clone(), quant))
        };
        assert_eq!(
            picked(TREE_QWEN35_4B),
            Some(("Qwen3.5-4B-Q4_K_M.gguf".to_string(), "Q4_K_M"))
        );
        assert_eq!(
            picked(TREE_QWEN38_27B),
            Some(("Qwen3.8-27B-UD-Q4_K_M.gguf".to_string(), "Q4_K_M"))
        );
        assert_eq!(
            picked(TREE_BOLT),
            Some(("Nemotron-3.5-Bolt-E4B-Q4_K_M.gguf".to_string(), "Q4_K_M"))
        );
        assert_eq!(
            picked(TREE_MIMO),
            Some((
                "MiMo-V2.6-Distill-Qwen-9B-Q4_K_M.gguf".to_string(),
                "Q4_K_M"
            ))
        );
    }

    #[test]
    fn falls_back_through_the_quantization_preference_order() {
        let pick = |names: &[&str]| {
            let tree: Vec<TreeItem> = names.iter().map(|n| file(n)).collect();
            pick_file(&tree).map(|(item, _)| item.path.clone())
        };
        assert_eq!(
            pick(&[
                "m-IQ4_XS.gguf",
                "m-Q5_K_M.gguf",
                "m-Q4_K_S.gguf",
                "m-Q8_0.gguf"
            ])
            .as_deref(),
            Some("m-Q4_K_S.gguf")
        );
        assert_eq!(
            pick(&["m-IQ4_XS.gguf", "m-Q5_K_M.gguf"]).as_deref(),
            Some("m-Q5_K_M.gguf")
        );
        assert_eq!(pick(&["m.q4_k_m.gguf"]).as_deref(), Some("m.q4_k_m.gguf"));
        assert_eq!(pick(&["m-Q8_0.gguf", "m-Q6_K.gguf", "m-Q3_K_M.gguf"]), None);
    }

    #[test]
    fn never_picks_split_projector_or_full_precision_files() {
        let pick = |names: &[&str]| {
            let tree: Vec<TreeItem> = names.iter().map(|n| file(n)).collect();
            pick_file(&tree).map(|(item, _)| item.path.clone())
        };
        assert_eq!(
            pick(&[
                "m-Q4_K_M-00001-of-00003.gguf",
                "m-Q4_K_M-00002-of-00003.gguf",
                "mmproj-m-Q4_K_M.gguf",
                "m-mmproj-Q4_K_M.gguf",
                "m-BF16.gguf",
                "m-F16.gguf",
                "m-imatrix.gguf",
                "sub/m-Q4_K_M.gguf",
                "m-Q4_K_M.bin",
                "notQ4_K_M.gguf",
            ]),
            None
        );

        let mut pointer_less = file("m-Q4_K_M.gguf");
        pointer_less.lfs = None;
        let mut directory = file("d-Q4_K_M.gguf");
        directory.kind = "directory".to_string();
        assert!(pick_file(&[pointer_less, directory]).is_none());
    }

    // --- entries ------------------------------------------------------------

    #[test]
    fn llm_entry_carries_what_hugging_face_reported() {
        let repo = repo("unsloth/Qwen3.8-27B-GGUF");
        let entry = llm_entry(&repo, &tree(TREE_QWEN38_27B)).unwrap();

        assert_eq!(
            entry.id,
            "hf:unsloth/Qwen3.8-27B-GGUF/Qwen3.8-27B-UD-Q4_K_M.gguf"
        );
        assert_eq!(entry.display_name, "Qwen3.8-27B");
        assert_eq!(entry.kind, ModelKind::Llm);
        assert!(entry.traits.is_empty());
        assert_eq!(entry.size_bytes, 16_464_440_224);
        assert_eq!(entry.min_ram_gb, 36);
        assert_eq!(
            entry.url,
            "https://huggingface.co/unsloth/Qwen3.8-27B-GGUF/resolve/\
             4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q4_K_M.gguf"
        );
        catalog::validate_entry(&entry).unwrap();
        let ModelOrigin::HuggingFace {
            publisher,
            trusted,
            architecture,
            parameters,
            quantization,
            updated_at,
            downloads,
            ..
        } = &entry.origin
        else {
            panic!("expected a Hugging Face origin");
        };
        assert_eq!(publisher, "unsloth");
        assert!(*trusted);
        assert_eq!(architecture.as_deref(), Some("qwen35"));
        assert_eq!(*parameters, Some(27_320_697_856));
        assert_eq!(quantization.as_deref(), Some("Q4_K_M"));
        assert!(updated_at.is_some());
        assert!(downloads.is_some());
    }

    #[test]
    fn the_recorded_sha256_matches_the_built_in_pin_for_the_same_file() {
        let tree = tree(TREE_QWEN35_4B);
        let (item, _) = pick_file(&tree).unwrap();
        let built_in = catalog::load_catalog()
            .unwrap()
            .into_iter()
            .find(|e| e.id == "qwen3.5-4b")
            .unwrap();
        assert_eq!(item.lfs.as_ref().unwrap().oid, built_in.sha256);
        assert_eq!(item.size, built_in.size_bytes);
    }

    #[test]
    fn an_unknown_publisher_is_marked_untrusted() {
        let repo = repos(SEARCH)
            .into_iter()
            .find(|r| r.id == "turintech/Qwen3.5-4B-Artemis-GGUF")
            .unwrap();
        let entry = llm_entry(&repo, &[file("Qwen3.5-4B-Artemis-Q4_K_M.gguf")]).unwrap();
        assert!(matches!(
            entry.origin,
            ModelOrigin::HuggingFace { trusted: false, .. }
        ));
    }

    #[test]
    fn a_repo_with_an_unsafe_name_yields_no_entry() {
        let mut odd = repo("unsloth/Qwen3.8-27B-GGUF");
        odd.id = "unsloth/..".to_string();
        assert!(llm_entry(&odd, &[file("m-Q4_K_M.gguf")]).is_none());
    }

    #[test]
    fn display_names_drop_the_gguf_suffix() {
        assert_eq!(display_name_for_repo("Qwen3.5-4B-GGUF"), "Qwen3.5-4B");
        assert_eq!(display_name_for_repo("model_gguf"), "model");
        assert_eq!(display_name_for_repo("Bolt-E4B-4GB"), "Bolt-E4B-4GB");
        assert_eq!(display_name_for_repo("-GGUF"), "-GGUF");
    }

    // --- memory estimate ----------------------------------------------------

    #[test]
    fn the_ram_estimate_reproduces_every_built_in_llm() {
        let parameters = |id: &str| match id {
            "qwen3.5-4b" => Some(4_205_751_296),
            "qwen3.5-9b" => Some(9_000_000_000),
            _ => None,
        };
        for entry in catalog::load_catalog().unwrap() {
            if entry.kind == ModelKind::Llm {
                assert_eq!(
                    llm_min_ram_gb(entry.size_bytes, parameters(&entry.id)),
                    entry.min_ram_gb,
                    "{}",
                    entry.id
                );
            }
        }
    }

    #[test]
    fn the_ram_estimate_rounds_up_to_a_mac_memory_size() {
        let gb = 1_000_000_000u64;
        assert_eq!(llm_min_ram_gb(gb, None), 8);
        assert_eq!(llm_min_ram_gb(9 * gb, Some(14_000_000_000)), 24);
        assert_eq!(llm_min_ram_gb(16 * gb, Some(27_000_000_000)), 36);
        assert_eq!(llm_min_ram_gb(40 * gb, Some(70_000_000_000)), 96);
        assert!(llm_min_ram_gb(400 * gb, None) > 512);
    }

    // --- whisper ------------------------------------------------------------

    #[test]
    fn whisper_file_names_become_readable_names() {
        let name = |file: &str| parse_whisper_name(file).map(|n| n.display_name);
        assert_eq!(
            name("ggml-large-v3-turbo-q5_0.bin").as_deref(),
            Some("Whisper large-v3 turbo, compressed (q5_0)")
        );
        assert_eq!(
            name("ggml-large-v3.bin").as_deref(),
            Some("Whisper large-v3")
        );
        assert_eq!(
            name("ggml-small.en.bin").as_deref(),
            Some("Whisper small, English only")
        );
        assert_eq!(
            name("ggml-base.en-q5_1.bin").as_deref(),
            Some("Whisper base, English only, compressed (q5_1)")
        );
        for other in [
            "ggml-base-encoder.mlmodelc.zip",
            "ggml-small.en-tdrz.bin",
            "ggml-silero-v5.1.2.bin",
            "ggml-large-vx.bin",
            "for-tests-ggml-tiny.bin",
            "README.md",
        ] {
            assert_eq!(name(other), None, "{other}");
        }
    }

    #[test]
    fn the_whisper_repo_lists_every_model_file_and_nothing_else() {
        let entries = whisper_entries(&tree(TREE_WHISPER));
        assert_eq!(entries.len(), 33);
        for entry in &entries {
            catalog::validate_entry(entry).unwrap();
            assert_eq!(entry.kind, ModelKind::Stt);
        }
        let turbo = entries
            .iter()
            .find(|e| e.id == "hf:ggerganov/whisper.cpp/ggml-large-v3-turbo-q5_0.bin")
            .unwrap();
        assert_eq!(turbo.size_bytes, 574_041_195);
        assert_eq!(turbo.min_ram_gb, 0);
        assert!(turbo.requires_apple_silicon);
        assert!(matches!(
            &turbo.origin,
            ModelOrigin::HuggingFace { trusted: true, quantization: Some(q), .. } if q == "q5_0"
        ));
    }

    // --- cache --------------------------------------------------------------

    fn snapshot(fetched_at: &str, entries: Vec<CatalogEntry>) -> Snapshot {
        Snapshot {
            fetched_at: fetched_at.to_string(),
            entries,
            unsupported_count: 3,
        }
    }

    fn at(text: &str) -> OffsetDateTime {
        OffsetDateTime::parse(text, &Rfc3339).unwrap()
    }

    #[test]
    fn a_snapshot_is_fresh_for_twenty_four_hours() {
        let snap = snapshot("2026-11-10T08:00:00Z", Vec::new());
        assert!(is_fresh(&snap, at("2026-11-10T08:00:00Z")));
        assert!(is_fresh(&snap, at("2026-11-11T07:59:59Z")));
        assert!(!is_fresh(&snap, at("2026-11-11T08:00:00Z")));
        assert!(!is_fresh(&snap, at("2026-11-09T08:00:00Z")));
        assert!(!is_fresh(
            &snapshot("yesterday", Vec::new()),
            at("2026-11-10T08:00:00Z")
        ));
    }

    #[test]
    fn the_network_is_used_only_when_the_cache_cannot_answer() {
        let now = at("2026-11-10T12:00:00Z");
        let fresh = snapshot("2026-11-10T08:00:00Z", Vec::new());
        let stale = snapshot("2026-11-08T08:00:00Z", Vec::new());
        assert!(!needs_fetch(Some(&fresh), false, false, now));
        assert!(needs_fetch(Some(&fresh), false, true, now));
        assert!(needs_fetch(Some(&fresh), true, false, now));
        assert!(needs_fetch(Some(&stale), false, false, now));
        assert!(needs_fetch(None, false, false, now));
    }

    #[test]
    fn snapshots_round_trip_per_kind_and_drop_tampered_entries() {
        let dir = tempdir().unwrap();
        let llm = llm_entry(&repo("unsloth/Qwen3.8-27B-GGUF"), &tree(TREE_QWEN38_27B)).unwrap();
        let stt = whisper_entries(&tree(TREE_WHISPER));
        save_snapshot(
            dir.path(),
            ModelKind::Llm,
            &snapshot("2026-11-10T08:00:00Z", vec![llm.clone()]),
        )
        .unwrap();
        save_snapshot(
            dir.path(),
            ModelKind::Stt,
            &snapshot("2026-11-10T09:00:00Z", stt),
        )
        .unwrap();

        let loaded = load_snapshot(dir.path(), ModelKind::Llm).unwrap();
        assert_eq!(loaded.fetched_at, "2026-11-10T08:00:00Z");
        assert_eq!(loaded.unsupported_count, 3);
        assert_eq!(loaded.entries.len(), 1);
        assert_eq!(
            load_snapshot(dir.path(), ModelKind::Stt)
                .unwrap()
                .entries
                .len(),
            33
        );

        let mut tampered = llm;
        tampered.url = "https://evil.example/unsloth/Qwen3.8-27B-GGUF/resolve/main/x.gguf".into();
        save_snapshot(
            dir.path(),
            ModelKind::Llm,
            &snapshot("2026-11-10T08:00:00Z", vec![tampered]),
        )
        .unwrap();
        assert!(load_snapshot(dir.path(), ModelKind::Llm)
            .unwrap()
            .entries
            .is_empty());
    }

    #[test]
    fn a_missing_or_corrupt_cache_is_no_cache() {
        let dir = tempdir().unwrap();
        assert!(load_snapshot(dir.path(), ModelKind::Llm).is_none());
        std::fs::create_dir_all(dir.path().join("models")).unwrap();
        std::fs::write(cache_path(dir.path()), b"[oops").unwrap();
        assert!(load_snapshot(dir.path(), ModelKind::Llm).is_none());
    }

    // --- presenting ---------------------------------------------------------

    fn browse_ids(browse: &ModelBrowse) -> Vec<&str> {
        browse.entries.iter().map(|s| s.entry.id.as_str()).collect()
    }

    #[test]
    fn browse_results_exclude_everything_list_models_already_shows() {
        let dir = tempdir().unwrap();
        let known = catalog::load_catalog().unwrap();

        let stt = snapshot("2026-11-10T08:00:00Z", whisper_entries(&tree(TREE_WHISPER)));
        let shown = present(Some(stt), None, &known, None, dir.path());
        assert_eq!(shown.entries.len(), 26);
        assert!(!browse_ids(&shown).contains(&"hf:ggerganov/whisper.cpp/ggml-medium-q5_0.bin"));
        assert!(!browse_ids(&shown).contains(&"hf:ggerganov/whisper.cpp/ggml-small.bin"));
        assert_eq!(shown.fetched_at.as_deref(), Some("2026-11-10T08:00:00Z"));
        assert_eq!(shown.unsupported_count, 3);

        let same_as_built_in = llm_entry(
            &repos(SEARCH)
                .into_iter()
                .find(|r| r.id == "unsloth/Qwen3.5-4B-GGUF")
                .unwrap(),
            &tree(TREE_QWEN35_4B),
        )
        .unwrap();
        let added = llm_entry(&repo("unsloth/Qwen3.8-27B-GGUF"), &tree(TREE_QWEN38_27B)).unwrap();
        let new = llm_entry(
            &repo("bartowski/MiMo-V2.6-Distill-Qwen-9B-GGUF"),
            &tree(TREE_MIMO),
        )
        .unwrap();
        let mut known = known;
        known.push(added.clone());
        let llm = snapshot(
            "2026-11-10T08:00:00Z",
            vec![same_as_built_in, added, new.clone()],
        );
        let shown = present(Some(llm), None, &known, None, dir.path());
        assert_eq!(browse_ids(&shown), [new.id.as_str()]);
        assert_eq!(shown.entries[0].state, catalog::InstallState::NotInstalled);
    }

    #[test]
    fn a_failed_fetch_returns_the_error_with_cached_results() {
        let dir = tempdir().unwrap();
        let stt = snapshot("2026-11-08T08:00:00Z", whisper_entries(&tree(TREE_WHISPER)));
        let offline = Some("Could not reach Hugging Face. Check your connection.".to_string());

        let shown = present(
            Some(stt),
            offline.clone(),
            &[],
            Some("turbo q5"),
            dir.path(),
        );
        assert_eq!(
            browse_ids(&shown),
            ["hf:ggerganov/whisper.cpp/ggml-large-v3-turbo-q5_0.bin"]
        );
        assert_eq!(shown.error, offline);

        let nothing = present(None, offline.clone(), &[], None, dir.path());
        assert!(nothing.entries.is_empty());
        assert_eq!(nothing.fetched_at, None);
        assert_eq!(nothing.error, offline);
    }

    #[test]
    fn model_browse_serializes_in_camel_case() {
        let dir = tempdir().unwrap();
        let stt = snapshot("2026-11-10T08:00:00Z", whisper_entries(&tree(TREE_WHISPER)));
        let json = serde_json::to_value(present(Some(stt), None, &[], None, dir.path())).unwrap();
        assert_eq!(json["fetchedAt"], "2026-11-10T08:00:00Z");
        assert_eq!(json["unsupportedCount"], 3);
        assert!(json["error"].is_null());
        assert_eq!(json["entries"][0]["state"], "notInstalled");
        assert_eq!(json["entries"][0]["origin"]["kind"], "huggingFace");
        assert_eq!(json["entries"][0]["kind"], "stt");
    }

    #[test]
    fn browsing_speaker_models_is_refused() {
        let dir = tempdir().unwrap();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let result = runtime.block_on(browse(
            dir.path(),
            &BrowseIndex::default(),
            ModelKind::Diarization,
            None,
            false,
            OffsetDateTime::now_utc(),
        ));
        assert!(result.is_err());
    }

    #[test]
    fn a_fresh_cache_answers_without_the_network_and_feeds_the_download_index() {
        let dir = tempdir().unwrap();
        let now = at("2026-11-10T12:00:00Z");
        let stt = snapshot("2026-11-10T08:00:00Z", whisper_entries(&tree(TREE_WHISPER)));
        save_snapshot(dir.path(), ModelKind::Stt, &stt).unwrap();
        let index = BrowseIndex::default();

        let runtime = tokio::runtime::Runtime::new().unwrap();
        let shown = runtime
            .block_on(browse(
                dir.path(),
                &index,
                ModelKind::Stt,
                Some(" tiny "),
                false,
                now,
            ))
            .unwrap();

        assert_eq!(shown.entries.len(), 6);
        assert_eq!(shown.error, None);
        assert!(index
            .get("hf:ggerganov/whisper.cpp/ggml-tiny.bin")
            .is_some());
        assert!(index
            .get("hf:ggerganov/whisper.cpp/ggml-base.bin")
            .is_none());
    }

    #[test]
    fn search_text_is_percent_encoded() {
        assert_eq!(
            percent_encode("qwen3.5 4b&x=é"),
            "qwen3.5%204b%26x%3D%C3%A9"
        );
    }

    // --- real network -------------------------------------------------------

    /// Talks to huggingface.co. Uses a temp dir, never the app's data. Run:
    ///
    /// ```sh
    /// cargo test --manifest-path src-tauri/Cargo.toml --lib -- --ignored --nocapture real_browse
    /// ```
    #[test]
    #[ignore]
    fn real_browse_returns_models_from_hugging_face() {
        let dir = tempdir().unwrap();
        let index = BrowseIndex::default();
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let now = OffsetDateTime::now_utc();
        let run = |kind, query: Option<&str>| {
            runtime
                .block_on(browse(dir.path(), &index, kind, query, true, now))
                .unwrap()
        };
        let describe = |label: &str, shown: &ModelBrowse| {
            eprintln!(
                "{label}: {} entries, {} unsupported, error {:?}",
                shown.entries.len(),
                shown.unsupported_count,
                shown.error
            );
            for status in &shown.entries {
                let e = &status.entry;
                eprintln!("  {} | {} B | {} GB RAM", e.id, e.size_bytes, e.min_ram_gb);
            }
            if let Some(first) = shown.entries.first() {
                eprintln!("{}", serde_json::to_string_pretty(first).unwrap());
            }
        };

        let trending = run(ModelKind::Llm, None);
        describe("trending", &trending);
        assert_eq!(trending.error, None);
        assert!(trending.entries.iter().all(|s| matches!(
            s.entry.origin,
            ModelOrigin::HuggingFace { trusted: true, .. }
        )));

        let search = run(ModelKind::Llm, Some("qwen3.5 4b"));
        describe("search", &search);
        assert_eq!(search.error, None);
        assert!(!search.entries.is_empty());

        let stt = run(ModelKind::Stt, None);
        describe("stt", &stt);
        assert_eq!(stt.error, None);
        assert!(stt.entries.len() >= 20);

        let cached = runtime
            .block_on(browse(dir.path(), &index, ModelKind::Llm, None, false, now))
            .unwrap();
        assert_eq!(cached.entries.len(), trending.entries.len());
    }
}
