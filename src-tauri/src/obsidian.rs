//! Obsidian export (issue #47): writes a note as Markdown into a vault.
//!
//! Policy for the file Minute owns in the vault:
//!
//! - The first save picks a path from the file name template and never
//!   overwrites a file Minute did not write. A name clash gets a ` 2`, ` 3`
//!   suffix.
//! - The saved path lives in the note's `meta.json`. Every later save writes
//!   to that same path, so renaming the note does not create a second file.
//! - If the user edits the file in Obsidian, an automatic save (after a
//!   summary or regenerate) leaves it alone and records an error. The
//!   explicit "Save to Obsidian again" command replaces it.
//! - If the recorded file is gone, or sits outside the current vault, the
//!   next save creates a new file from the template.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use time::OffsetDateTime;

use crate::error::Result;
use crate::llm::SummaryDoc;
use crate::settings::{lock_settings, ObsidianSettings, SharedSettings};
use crate::store::{lock_store, render_note_md_with, NoteMeta, SharedStore, Transcript};

pub const DEFAULT_FOLDER: &str = "Meetings";
pub const DEFAULT_FILE_NAME_TEMPLATE: &str = "{date} - {title}";

const MAX_FILE_STEM_CHARS: usize = 100;
const MAX_FILE_STEM_BYTES: usize = 240;
const MAX_COLLISION_SUFFIX: u32 = 999;

/// Per-note export status, stored in `meta.json` and sent to the frontend.
///
/// A failed save keeps `path` and `saved_at` from the last good save and sets
/// `error`; a good save clears `error`. `content_hash` is the SHA-256 of the
/// file as Minute last wrote it, used to detect edits made in Obsidian.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObsidianExport {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub saved_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub content_hash: Option<String>,
}

/// Who asked for the save. An automatic save protects edits made in
/// Obsidian. A manual one replaces them.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Trigger {
    Auto,
    Manual,
}

// ---------------------------------------------------------------------------
// Pure pieces: names, folders, frontmatter, body
// ---------------------------------------------------------------------------

/// Makes `raw` safe as a file name stem on macOS, Windows and in Obsidian
/// links: path separators and `: * ? " < > | # ^ [ ]` become `-`, control
/// characters go, whitespace collapses, leading dots and edge spaces go, and
/// the result is capped. An empty result becomes `Untitled`.
pub fn sanitize_file_name(raw: &str) -> String {
    let replaced: String = raw
        .chars()
        .filter(|c| c.is_whitespace() || !c.is_control())
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' | '[' | ']' => '-',
            c => c,
        })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let capped: String = collapsed.chars().take(MAX_FILE_STEM_CHARS).collect();
    let trimmed = capped.trim_matches(|c: char| c == '.' || c.is_whitespace());
    if trimmed.is_empty() {
        "Untitled".to_string()
    } else {
        trimmed.to_string()
    }
}

/// `YYYY-MM-DD` of the note's creation, in UTC like the rest of `meta.json`.
fn date_stamp(created_at: &str) -> Option<String> {
    let dt = OffsetDateTime::parse(
        created_at,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()?;
    Some(format!(
        "{:04}-{:02}-{:02}",
        dt.year(),
        u8::from(dt.month()),
        dt.day()
    ))
}

/// Renders the file name template (`{date}`, `{title}`) and sanitizes the
/// result. The title is sanitized first so it cannot smuggle a separator in.
pub fn render_file_stem(template: &str, meta: &NoteMeta) -> String {
    let date = date_stamp(&meta.created_at).unwrap_or_else(|| "undated".to_string());
    let rendered = template
        .replace("{date}", &date)
        .replace("{title}", &sanitize_file_name(&meta.title));
    sanitize_file_name(&rendered)
}

/// Splits `folder` into sanitized path segments. Empty segments and `.` are
/// dropped. `..` is an error, so the folder cannot leave the vault.
pub fn folder_segments(folder: &str) -> std::result::Result<Vec<String>, String> {
    let mut out = Vec::new();
    for part in folder.split(['/', '\\']) {
        let part = part.trim();
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." {
            return Err("The folder cannot contain \"..\".".to_string());
        }
        out.push(sanitize_file_name(part));
    }
    Ok(out)
}

fn yaml_string(s: &str) -> String {
    let escaped = s
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t");
    format!("\"{escaped}\"")
}

/// YAML frontmatter for Obsidian properties: `date`, `title`, `duration` (in
/// minutes) and `speakers` (distinct named transcript speakers, in order of
/// first appearance; unknown turns name nobody, so they add no entry).
pub fn render_frontmatter(meta: &NoteMeta, transcript: &Transcript) -> String {
    let mut speakers: Vec<&str> = Vec::new();
    for name in transcript
        .segments
        .iter()
        .filter_map(|seg| seg.speaker.name())
    {
        if !speakers.contains(&name) {
            speakers.push(name);
        }
    }
    let date = match date_stamp(&meta.created_at) {
        Some(d) => d,
        None => yaml_string(&meta.created_at),
    };
    let minutes = (meta.duration_sec / 60.0).round().max(0.0) as i64;
    let mut out = format!(
        "---\ndate: {date}\ntitle: {}\nduration: {minutes}\n",
        yaml_string(&meta.title)
    );
    if speakers.is_empty() {
        out.push_str("speakers: []\n");
    } else {
        out.push_str("speakers:\n");
        for s in speakers {
            out.push_str(&format!("  - {}\n", yaml_string(s)));
        }
    }
    out.push_str("---\n\n");
    out
}

/// The full file content: optional frontmatter, then the shared `note.md`
/// rendering with the transcript section only when asked for.
pub fn render_obsidian_md(
    cfg: &ObsidianSettings,
    meta: &NoteMeta,
    summary: Option<&SummaryDoc>,
    transcript: &Transcript,
) -> String {
    let body = render_note_md_with(meta, summary, transcript, cfg.include_transcript);
    let mut out = if cfg.add_properties {
        render_frontmatter(meta, transcript)
    } else {
        String::new()
    };
    out.push_str(&body);
    out.push('\n');
    out
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/// Checks that `path` names an existing folder and returns it resolved.
pub fn check_vault(path: &str) -> std::result::Result<PathBuf, String> {
    let path = path.trim();
    if path.is_empty() {
        return Err("Choose your Obsidian vault folder in Settings.".to_string());
    }
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!(
            "The vault folder {path} does not exist. Check the path in Settings."
        ));
    }
    if !p.is_dir() {
        return Err(format!("{path} is not a folder. Choose your vault folder."));
    }
    p.canonicalize()
        .map_err(|e| format!("Cannot open the vault folder {path}: {e}"))
}

/// Validates Obsidian settings for `set_settings`. The vault path is checked
/// when the integration is on or the patch just changed the path, so turning
/// the integration off still works after the vault has gone away.
pub fn validate_settings(
    cfg: &ObsidianSettings,
    vault_path_changed: bool,
) -> std::result::Result<(), String> {
    if cfg.file_name_template.trim().is_empty() {
        return Err("The file name template cannot be empty.".to_string());
    }
    folder_segments(&cfg.folder)?;
    if cfg.enabled || (vault_path_changed && !cfg.vault_path.trim().is_empty()) {
        check_vault(&cfg.vault_path)?;
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

fn hash_hex(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

/// Writes `content` to `path` through a hidden temp file in the same folder,
/// then renames it into place. The dot prefix keeps Obsidian from indexing
/// the temp file. Each call gets its own temp name, so two saves of one note
/// never write or rename each other's file. The name does not include the
/// target's, so it cannot push a long file name past the file system limit.
fn write_atomic(path: &Path, content: &str) -> std::io::Result<()> {
    static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
    let tmp = path.with_file_name(format!(
        ".minute-{}-{}.tmp",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    ));
    if let Err(e) = fs::write(&tmp, content) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    if let Err(e) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    Ok(())
}

fn describe_io(action: &str, path: &Path, e: &std::io::Error) -> String {
    if e.kind() == std::io::ErrorKind::PermissionDenied {
        format!(
            "Minute is not allowed to {action} {}. Check the folder's permissions.",
            path.display()
        )
    } else {
        format!("Could not {action} {}: {e}", path.display())
    }
}

/// First free path for a new file: `<stem>.md`, then `<stem> 2.md`, ...
fn free_path(dir: &Path, stem: &str) -> std::result::Result<PathBuf, String> {
    let first = dir.join(format!("{stem}.md"));
    if !first.exists() {
        return Ok(first);
    }
    for n in 2..=MAX_COLLISION_SUFFIX {
        let candidate = dir.join(format!("{stem} {n}.md"));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err(format!(
        "Too many files named \"{stem}\" in {}.",
        dir.display()
    ))
}

/// Writes one note into the vault and returns the new status, or the error
/// text. Does not touch the store.
pub fn save_to_vault(
    cfg: &ObsidianSettings,
    meta: &NoteMeta,
    summary: Option<&SummaryDoc>,
    transcript: &Transcript,
    trigger: Trigger,
    now: &str,
) -> std::result::Result<ObsidianExport, String> {
    let vault = check_vault(&cfg.vault_path)?;
    let mut dir = vault.clone();
    for seg in folder_segments(&cfg.folder)? {
        dir.push(seg);
    }
    let content = render_obsidian_md(cfg, meta, summary, transcript);
    let previous = meta.obsidian.as_ref();

    let recorded = previous
        .and_then(|p| p.path.as_deref())
        .map(PathBuf::from)
        .filter(|p| p.starts_with(&vault) && p.is_file());

    let target = match recorded {
        Some(path) => {
            if trigger == Trigger::Auto {
                if let Some(expected) = previous.and_then(|p| p.content_hash.as_deref()) {
                    let on_disk = fs::read(&path).map_err(|e| describe_io("read", &path, &e))?;
                    if hash_hex(&on_disk) != expected {
                        return Err(format!(
                            "{} was edited in Obsidian, so Minute left it alone. Use \"Save to Obsidian again\" to replace it.",
                            path.display()
                        ));
                    }
                }
            }
            path
        }
        None => {
            fs::create_dir_all(&dir).map_err(|e| describe_io("create", &dir, &e))?;
            free_path(&dir, &render_file_stem(&cfg.file_name_template, meta))?
        }
    };

    let unchanged = fs::read(&target).is_ok_and(|b| b == content.as_bytes());
    if !unchanged {
        write_atomic(&target, &content).map_err(|e| describe_io("write", &target, &e))?;
    }

    Ok(ObsidianExport {
        path: Some(target.to_string_lossy().into_owned()),
        saved_at: Some(now.to_string()),
        error: None,
        content_hash: Some(hash_hex(content.as_bytes())),
    })
}

fn now_rfc3339() -> String {
    OffsetDateTime::now_utc()
        .format(&time::format_description::well_known::Rfc3339)
        .unwrap_or_default()
}

/// Exports note `id` and records the outcome in its `meta.json`.
///
/// An export failure is data, not an `Err`: it lands in the returned
/// [`ObsidianExport::error`]. `Err` means the note itself could not be read
/// or its status could not be stored. File I/O runs outside the store lock.
pub fn export_note(
    store: &SharedStore,
    settings: &SharedSettings,
    id: &str,
    trigger: Trigger,
) -> Result<ObsidianExport> {
    let cfg = lock_settings(settings).obsidian.clone();
    let (meta, transcript, summary) = {
        let s = lock_store(store);
        let (meta, transcript) = s.get_note(id)?;
        let summary = s.read_summary(id)?;
        (meta, transcript, summary)
    };
    let previous = meta.obsidian.clone().unwrap_or_default();

    let status = if !cfg.enabled {
        Err("Obsidian export is off. Turn it on in Settings.".to_string())
    } else {
        save_to_vault(
            &cfg,
            &meta,
            summary.as_ref(),
            &transcript,
            trigger,
            &now_rfc3339(),
        )
    };
    let status = status.unwrap_or_else(|error| ObsidianExport {
        error: Some(error),
        ..previous
    });

    lock_store(store).set_obsidian_export(id, status.clone())?;
    Ok(status)
}

/// Called after a summary is on disk. Skips quietly when the integration is
/// off. Never fails: an error is logged and kept in the note's status.
pub fn export_after_summary(store: &SharedStore, settings: &SharedSettings, id: &str) {
    if !lock_settings(settings).obsidian.enabled {
        return;
    }
    match export_note(store, settings, id, Trigger::Auto) {
        Ok(status) => {
            if let Some(error) = status.error {
                log::warn!("note {id}: Obsidian export failed: {error}");
            }
        }
        Err(e) => log::warn!("note {id}: could not record Obsidian export status: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::SummaryDoc;
    use crate::settings::Settings;
    use crate::store::{Speaker, StoredSegment};
    use std::sync::{Arc, Mutex};
    use tempfile::tempdir;
    use time::macros::datetime;

    fn summary() -> SummaryDoc {
        SummaryDoc {
            summary: "We shipped it.".to_string(),
            decisions: vec!["Ship Friday".to_string()],
            ..Default::default()
        }
    }

    struct Fixture {
        _lib: tempfile::TempDir,
        vault: tempfile::TempDir,
        store: SharedStore,
        settings: SharedSettings,
        id: String,
    }

    fn fixture(enabled: bool) -> Fixture {
        let lib = tempdir().unwrap();
        let vault = tempdir().unwrap();
        let shared = crate::store::open_shared(lib.path().to_path_buf());
        let store = lock_store(&shared);
        let meta = store
            .create_note("Weekly: Sync/Plan", "m", datetime!(2026-07-23 10:15:30 UTC))
            .unwrap();
        let transcript = Transcript {
            segments: vec![
                StoredSegment {
                    speaker: "Ada".into(),
                    start: 0.0,
                    end: 2.0,
                    text: "Hello".into(),
                },
                StoredSegment {
                    speaker: "Grace".into(),
                    start: 2.0,
                    end: 4.0,
                    text: "Hi".into(),
                },
                StoredSegment {
                    speaker: "Ada".into(),
                    start: 4.0,
                    end: 6.0,
                    text: "Bye".into(),
                },
            ],
        };
        store.write_transcript(&meta.id, &transcript).unwrap();
        store.finalize_note(&meta.id, 2520.0, 2).unwrap();
        store
            .write_summary_and_finalize(&meta.id, &summary(), &transcript)
            .unwrap();
        drop(store);
        let mut settings = Settings::default();
        settings.obsidian.enabled = enabled;
        settings.obsidian.vault_path = vault.path().to_string_lossy().into_owned();
        Fixture {
            _lib: lib,
            vault,
            store: shared,
            settings: Arc::new(Mutex::new(settings)),
            id: meta.id,
        }
    }

    fn meta_of(f: &Fixture) -> NoteMeta {
        lock_store(&f.store).get_note(&f.id).unwrap().0
    }

    fn vault_files(f: &Fixture) -> Vec<PathBuf> {
        let dir = f.vault.path().join("Meetings");
        let mut v: Vec<_> = match fs::read_dir(&dir) {
            Ok(rd) => rd.map(|e| e.unwrap().path()).collect(),
            Err(_) => vec![],
        };
        v.sort();
        v
    }

    #[test]
    fn sanitize_replaces_unsafe_characters_and_trims() {
        assert_eq!(sanitize_file_name("a/b\\c:d*e?f\"g<h>i|j"), "a-b-c-d-e-f-g-h-i-j");
        assert_eq!(sanitize_file_name("Plan #1 [draft] ^x"), "Plan -1 -draft- -x");
        assert_eq!(sanitize_file_name("  ..hidden  name.. "), "hidden name");
        assert_eq!(sanitize_file_name("tab\tand\nnewline"), "tab and newline");
        assert_eq!(sanitize_file_name("///"), "---");
        assert_eq!(sanitize_file_name(""), "Untitled");
        assert_eq!(sanitize_file_name(" . "), "Untitled");
        assert_eq!(sanitize_file_name(&"x".repeat(300)).chars().count(), 100);
    }

    #[test]
    fn template_renders_date_and_title() {
        let f = fixture(true);
        let meta = meta_of(&f);
        assert_eq!(
            render_file_stem("{date} - {title}", &meta),
            "2026-07-23 - Weekly- Sync-Plan"
        );
        assert_eq!(render_file_stem("{title}", &meta), "Weekly- Sync-Plan");
        assert_eq!(render_file_stem("Meeting {date}", &meta), "Meeting 2026-07-23");
        assert_eq!(render_file_stem("{unknown} {date}", &meta), "{unknown} 2026-07-23");
    }

    #[test]
    fn folder_segments_reject_parent_traversal_and_skip_empties() {
        assert_eq!(folder_segments("Work/Meetings/").unwrap(), vec!["Work", "Meetings"]);
        assert_eq!(folder_segments("").unwrap(), Vec::<String>::new());
        assert!(folder_segments("../escape").is_err());
        assert!(folder_segments("a/../b").is_err());
    }

    #[test]
    fn frontmatter_has_date_title_duration_and_distinct_speakers() {
        let f = fixture(true);
        let meta = meta_of(&f);
        let transcript = lock_store(&f.store).get_note(&f.id).unwrap().1;
        let fm = render_frontmatter(&meta, &transcript);
        assert_eq!(
            fm,
            "---\ndate: 2026-07-23\ntitle: \"Weekly: Sync/Plan\"\nduration: 42\nspeakers:\n  - \"Ada\"\n  - \"Grace\"\n---\n\n"
        );
    }

    #[test]
    fn frontmatter_speakers_leave_out_unknown_turns() {
        let f = fixture(true);
        let meta = meta_of(&f);
        let transcript = Transcript {
            segments: vec![
                StoredSegment {
                    speaker: Speaker::Unknown,
                    start: 0.0,
                    end: 1.0,
                    text: "Hm.".into(),
                },
                StoredSegment {
                    speaker: "Grace".into(),
                    start: 1.0,
                    end: 2.0,
                    text: "Hi".into(),
                },
            ],
        };
        let fm = render_frontmatter(&meta, &transcript);
        assert!(fm.contains("speakers:\n  - \"Grace\"\n---\n"), "{fm}");
        assert!(!fm.contains(crate::store::UNKNOWN_SPEAKER_LABEL), "{fm}");
    }

    #[test]
    fn frontmatter_escapes_quotes_in_the_title() {
        let f = fixture(true);
        let mut meta = meta_of(&f);
        meta.title = "Say \"hi\" \\ now".to_string();
        let fm = render_frontmatter(&meta, &Transcript::default());
        assert!(fm.contains("title: \"Say \\\"hi\\\" \\\\ now\"\n"));
        assert!(fm.contains("speakers: []\n"));
    }

    #[test]
    fn body_honors_properties_and_transcript_toggles() {
        let f = fixture(true);
        let meta = meta_of(&f);
        let transcript = lock_store(&f.store).get_note(&f.id).unwrap().1;
        let mut cfg = ObsidianSettings::default();
        let plain = render_obsidian_md(&cfg, &meta, Some(&summary()), &transcript);
        assert!(plain.starts_with("---\n"));
        assert!(plain.contains("## Summary\n\nWe shipped it."));
        assert!(!plain.contains("## Transcript"));

        cfg.add_properties = false;
        cfg.include_transcript = true;
        let full = render_obsidian_md(&cfg, &meta, Some(&summary()), &transcript);
        assert!(full.starts_with("# Weekly: Sync/Plan"));
        assert!(full.contains("## Transcript\n\n**Ada** (00:00)\nHello"));
        assert!(full.ends_with('\n'));
    }

    #[test]
    fn export_writes_the_file_and_records_status() {
        let f = fixture(true);
        let status = export_note(&f.store, &f.settings, &f.id, Trigger::Auto).unwrap();
        assert_eq!(status.error, None);
        let path = PathBuf::from(status.path.clone().unwrap());
        assert_eq!(
            path.file_name().unwrap().to_string_lossy(),
            "2026-07-23 - Weekly- Sync-Plan.md"
        );
        assert!(path.starts_with(f.vault.path().canonicalize().unwrap().join("Meetings")));
        let text = fs::read_to_string(&path).unwrap();
        assert!(text.starts_with("---\ndate: 2026-07-23\n"));
        assert_eq!(meta_of(&f).obsidian, Some(status));
        assert_eq!(vault_files(&f).len(), 1, "no temp file left behind");
    }

    #[test]
    fn a_later_save_overwrites_the_same_file_even_after_a_rename() {
        let f = fixture(true);
        let first = export_note(&f.store, &f.settings, &f.id, Trigger::Auto).unwrap();
        lock_store(&f.store).rename_note(&f.id, "Totally New Title").unwrap();
        let second = export_note(&f.store, &f.settings, &f.id, Trigger::Auto).unwrap();
        assert_eq!(second.path, first.path);
        let files = vault_files(&f);
        assert_eq!(files.len(), 1);
        assert!(fs::read_to_string(&files[0]).unwrap().contains("title: \"Totally New Title\""));
    }

    #[test]
    fn a_name_clash_with_a_foreign_file_gets_a_suffix_and_is_not_overwritten() {
        let f = fixture(true);
        let dir = f.vault.path().join("Meetings");
        fs::create_dir_all(&dir).unwrap();
        let foreign = dir.join("2026-07-23 - Weekly- Sync-Plan.md");
        fs::write(&foreign, "mine").unwrap();
        let status = export_note(&f.store, &f.settings, &f.id, Trigger::Auto).unwrap();
        assert_eq!(fs::read_to_string(&foreign).unwrap(), "mine");
        assert!(status.path.unwrap().ends_with("Weekly- Sync-Plan 2.md"));
    }

    #[test]
    fn an_auto_save_keeps_obsidian_edits_and_a_manual_save_replaces_them() {
        let f = fixture(true);
        let first = export_note(&f.store, &f.settings, &f.id, Trigger::Auto).unwrap();
        let path = PathBuf::from(first.path.clone().unwrap());
        fs::write(&path, "my own notes").unwrap();

        let auto = export_note(&f.store, &f.settings, &f.id, Trigger::Auto).unwrap();
        assert!(auto.error.unwrap().contains("edited in Obsidian"));
        assert_eq!(auto.path, first.path, "last good path is kept on failure");
        assert_eq!(auto.saved_at, first.saved_at);
        assert_eq!(fs::read_to_string(&path).unwrap(), "my own notes");

        let manual = export_note(&f.store, &f.settings, &f.id, Trigger::Manual).unwrap();
        assert_eq!(manual.error, None);
        assert!(fs::read_to_string(&path).unwrap().contains("We shipped it."));
    }

    #[test]
    fn a_deleted_file_is_recreated_from_the_template() {
        let f = fixture(true);
        let first = export_note(&f.store, &f.settings, &f.id, Trigger::Auto).unwrap();
        fs::remove_file(first.path.as_ref().unwrap()).unwrap();
        let second = export_note(&f.store, &f.settings, &f.id, Trigger::Auto).unwrap();
        assert_eq!(second.error, None);
        assert_eq!(second.path, first.path);
        assert!(Path::new(second.path.as_ref().unwrap()).is_file());
    }

    #[test]
    fn a_missing_vault_is_an_error_status_not_an_err() {
        let f = fixture(true);
        lock_settings(&f.settings).obsidian.vault_path = "/definitely/not/here".to_string();
        let status = export_note(&f.store, &f.settings, &f.id, Trigger::Auto).unwrap();
        assert!(status.error.unwrap().contains("does not exist"));
        assert_eq!(status.path, None);
        assert!(meta_of(&f).obsidian.unwrap().error.is_some());
    }

    #[test]
    fn a_vault_path_that_is_a_file_is_rejected() {
        let dir = tempdir().unwrap();
        let file = dir.path().join("x.txt");
        fs::write(&file, "x").unwrap();
        assert!(check_vault(file.to_str().unwrap()).unwrap_err().contains("not a folder"));
        assert!(check_vault("").is_err());
    }

    #[test]
    fn an_export_failure_leaves_the_summary_and_ready_status_intact() {
        let f = fixture(true);
        lock_settings(&f.settings).obsidian.vault_path = "/definitely/not/here".to_string();
        export_after_summary(&f.store, &f.settings, &f.id);
        let s = lock_store(&f.store);
        assert_eq!(s.read_summary(&f.id).unwrap().unwrap().summary, "We shipped it.");
        let meta = s.get_note(&f.id).unwrap().0;
        assert_eq!(meta.status, crate::store::NoteStatus::Ready);
        assert!(meta.obsidian.unwrap().error.is_some());
    }

    #[test]
    fn export_after_summary_does_nothing_when_disabled() {
        let f = fixture(false);
        export_after_summary(&f.store, &f.settings, &f.id);
        assert_eq!(meta_of(&f).obsidian, None);
        assert!(vault_files(&f).is_empty());
    }

    #[test]
    fn a_manual_save_while_disabled_reports_why() {
        let f = fixture(false);
        let status = export_note(&f.store, &f.settings, &f.id, Trigger::Manual).unwrap();
        assert!(status.error.unwrap().contains("off"));
    }

    #[test]
    fn a_changed_vault_gets_a_new_file_instead_of_writing_outside_it() {
        let f = fixture(true);
        let first = export_note(&f.store, &f.settings, &f.id, Trigger::Auto).unwrap();
        let other = tempdir().unwrap();
        lock_settings(&f.settings).obsidian.vault_path = other.path().to_string_lossy().into_owned();
        let second = export_note(&f.store, &f.settings, &f.id, Trigger::Auto).unwrap();
        assert_ne!(second.path, first.path);
        assert!(Path::new(second.path.as_ref().unwrap()).starts_with(other.path().canonicalize().unwrap()));
        assert!(Path::new(first.path.as_ref().unwrap()).is_file());
    }

    #[test]
    fn concurrent_saves_of_one_file_all_succeed_and_leave_one_whole_file() {
        let dir = tempdir().unwrap();
        let path = dir.path().join("note.md");
        let writers: Vec<_> = (0..8)
            .map(|writer| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let content = format!("writer {writer}\n").repeat(2000);
                    (0..100)
                        .filter(|_| write_atomic(&path, &content).is_err())
                        .count()
                })
            })
            .collect();
        let failures: usize = writers.into_iter().map(|w| w.join().unwrap()).sum();
        assert_eq!(failures, 0, "a save lost its temp file to another save");

        let text = fs::read_to_string(&path).unwrap();
        let first = text.lines().next().unwrap();
        assert_eq!(text.lines().count(), 2000);
        assert!(text.lines().all(|line| line == first), "two saves were mixed");
        assert_eq!(fs::read_dir(dir.path()).unwrap().count(), 1, "no temp file left behind");
    }

    #[test]
    fn a_long_cjk_title_still_fits_the_file_name_limit() {
        let title = "会".repeat(100);
        assert!(sanitize_file_name(&title).len() <= MAX_FILE_STEM_BYTES);

        let f = fixture(true);
        lock_store(&f.store).rename_note(&f.id, &title).unwrap();
        let status = export_note(&f.store, &f.settings, &f.id, Trigger::Auto).unwrap();
        assert_eq!(status.error, None);
        assert!(Path::new(status.path.as_ref().unwrap()).is_file());

        // The worst case still fits: every clash suffix up to the last one.
        let name = format!("{} {MAX_COLLISION_SUFFIX}.md", sanitize_file_name(&title));
        fs::write(f.vault.path().join(name), "fits").unwrap();
    }

    #[test]
    fn a_recorded_path_that_resolves_outside_the_vault_is_not_written() {
        let f = fixture(true);
        let outside = tempdir().unwrap();
        let foreign = outside.path().canonicalize().unwrap().join("secret.md");
        fs::write(&foreign, "not Minute's").unwrap();
        let vault = f.vault.path().canonicalize().unwrap();
        let escaping = vault.join("..").join(foreign.strip_prefix(vault.parent().unwrap()).unwrap());
        assert!(escaping.starts_with(&vault) && escaping.is_file(), "fixture: lexically inside");
        lock_store(&f.store)
            .set_obsidian_export(
                &f.id,
                ObsidianExport {
                    path: Some(escaping.to_string_lossy().into_owned()),
                    ..Default::default()
                },
            )
            .unwrap();

        let status = export_note(&f.store, &f.settings, &f.id, Trigger::Manual).unwrap();

        assert_eq!(status.error, None);
        assert_eq!(fs::read_to_string(&foreign).unwrap(), "not Minute's");
        assert!(Path::new(status.path.as_ref().unwrap())
            .canonicalize()
            .unwrap()
            .starts_with(vault.join("Meetings")));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_export_folder_keeps_one_file_across_saves() {
        let f = fixture(true);
        let real = tempdir().unwrap();
        std::os::unix::fs::symlink(real.path(), f.vault.path().join("Meetings")).unwrap();

        let first = export_note(&f.store, &f.settings, &f.id, Trigger::Auto).unwrap();
        let second = export_note(&f.store, &f.settings, &f.id, Trigger::Manual).unwrap();

        assert_eq!(first.error, None);
        assert_eq!(second.path, first.path);
        assert_eq!(fs::read_dir(real.path()).unwrap().count(), 1);
    }

    #[test]
    fn validate_settings_checks_vault_template_and_folder() {
        let dir = tempdir().unwrap();
        let mut cfg = ObsidianSettings::default();
        assert!(validate_settings(&cfg, false).is_ok(), "off and empty is fine");
        cfg.enabled = true;
        assert!(validate_settings(&cfg, false).is_err(), "on needs a vault");
        cfg.vault_path = dir.path().to_string_lossy().into_owned();
        assert!(validate_settings(&cfg, true).is_ok());
        cfg.folder = "../up".into();
        assert!(validate_settings(&cfg, false).is_err());
        cfg.folder = "Meetings".into();
        cfg.file_name_template = "  ".into();
        assert!(validate_settings(&cfg, false).is_err());
        cfg.file_name_template = "{title}".into();
        cfg.enabled = false;
        cfg.vault_path = "/gone".into();
        assert!(validate_settings(&cfg, false).is_ok(), "off tolerates a vanished vault");
        assert!(validate_settings(&cfg, true).is_err(), "a freshly typed bad path is caught");
    }

    #[test]
    fn set_settings_rejects_a_missing_vault_and_keeps_the_old_settings() {
        use crate::settings::{apply_and_save, ObsidianPatch, SettingsPatch};
        let root = tempdir().unwrap();
        let shared: SharedSettings = Arc::new(Mutex::new(Settings::default()));
        let bad = SettingsPatch {
            obsidian: Some(ObsidianPatch {
                enabled: Some(true),
                vault_path: Some("/nope/nope".into()),
                ..Default::default()
            }),
            ..Default::default()
        };
        assert!(apply_and_save(root.path(), &shared, bad).is_err());
        assert!(!lock_settings(&shared).obsidian.enabled);

        let vault = tempdir().unwrap();
        let good = SettingsPatch {
            obsidian: Some(ObsidianPatch {
                enabled: Some(true),
                vault_path: Some(format!("  {}  ", vault.path().display())),
                ..Default::default()
            }),
            ..Default::default()
        };
        let saved = apply_and_save(root.path(), &shared, good).unwrap();
        assert!(saved.obsidian.enabled);
        assert_eq!(saved.obsidian.vault_path, vault.path().to_string_lossy());
        assert_eq!(saved.obsidian.folder, "Meetings");
    }

    #[test]
    fn old_settings_json_without_obsidian_loads_with_defaults() {
        let s: Settings = serde_json::from_str("{\"sttModel\":null,\"llmModel\":null,\"deleteAudioAfter30d\":true}").unwrap();
        assert_eq!(s.obsidian, ObsidianSettings::default());
        assert_eq!(s.obsidian.file_name_template, "{date} - {title}");
        assert!(s.obsidian.add_properties);
        assert!(!s.obsidian.include_transcript);
    }
}
