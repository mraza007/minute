//! Issue #47: save finished summaries into an Obsidian vault.
//!
//! Obsidian is a Markdown-files-in-a-folder app, so "integration" here means
//! exactly one thing: after `llm::run_summarize` persists a summary, write
//! the note — YAML frontmatter plus the same sections `note.md` has — as a
//! `.md` file under the vault folder the user chose in Settings → Obsidian.
//! Nothing else: no Obsidian Local REST API, no `obsidian://` URIs, no
//! daily-note backlinks (the issue lists those as future ideas). Everything
//! this module does is a local file write, so the README's privacy promise
//! holds unchanged.
//!
//! Layout: the rendering and naming functions are pure (they take a
//! [`UtcOffset`] rather than asking the system for one, so tests are
//! deterministic on any machine); [`export_note_to_vault`] is the one thin
//! I/O function that strings them together. The caller
//! (`llm::export_to_obsidian`) decides what a failure means — never a failed
//! summarization; see that function's docs.
//!
//! Two rules the file I/O lives by:
//! - **Never overwrite.** A free name is claimed with an exclusive create
//!   (`create_new`), and a taken one gets ` (2)`, ` (3)`, … — so two
//!   summaries finishing together can't clobber each other either.
//! - **Never spam duplicates.** Every note Minute writes carries its note
//!   id as `minute_id` in the frontmatter; regenerating a summary whose
//!   export is already in the folder is reported as skipped rather than
//!   producing ` (2)`. The existing file is left exactly as it is — if the
//!   user annotated it in Obsidian, Minute has no business rewriting it.

use std::fs::{self, OpenOptions};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use serde::Serialize;
use time::format_description::well_known::Rfc3339;
use time::{OffsetDateTime, UtcOffset};

use crate::error::{MinuteError, Result};
use crate::llm::SummaryDoc;
use crate::settings::Settings;
use crate::store::{self, NoteMeta, Transcript};

/// The subfolder new installs save into — see `Settings::obsidian_folder`.
pub const DEFAULT_FOLDER: &str = "Meetings";
/// The default filename template — see [`render_filename`] for the tokens.
pub const DEFAULT_FILENAME_TEMPLATE: &str = "{date} - {title}";
/// Frontmatter key carrying the Minute note id — what
/// [`find_existing_export`] looks for.
const MINUTE_ID_KEY: &str = "minute_id";
/// Filename stems are cut to this many *characters* …
const MAX_STEM_CHARS: usize = 120;
/// … and this many UTF-8 bytes, whichever comes first — see
/// [`sanitize_filename_component`]. 200 bytes leaves room for a ` (NNN).md`
/// suffix under the 255-byte name limit APFS (and every other common
/// filesystem) imposes, even for a title that is all 3- or 4-byte
/// characters.
const MAX_STEM_BYTES: usize = 200;
/// How many ` (N)` suffixes [`create_exclusively`] tries before giving up.
const MAX_COLLISION_ATTEMPTS: u32 = 1000;
/// Only this much of an existing file is read when looking for its
/// `minute_id` — frontmatter sits at the top, and a two-hour transcript
/// shouldn't make the pre-export scan slow.
const FRONTMATTER_SCAN_BYTES: u64 = 16 * 1024;

/// What [`export_note_to_vault`] did.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportOutcome {
    /// A new file was written at this path.
    Written(PathBuf),
    /// A note from the same recording (matching `minute_id`) already sits
    /// in the target folder; nothing was written and the existing file is
    /// untouched.
    AlreadyExported(PathBuf),
}

/// The `obsidian_vault_status` command's answer — Settings → Obsidian's soft
/// check after the user picks a folder. `#[serde(rename_all = "camelCase")]`
/// for the wire.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultStatus {
    pub exists: bool,
    pub is_directory: bool,
    /// Whether the folder holds a `.obsidian` directory — what Obsidian
    /// creates when it opens a folder as a vault. A hint only: a folder
    /// without one works fine once Obsidian opens it, so the UI never
    /// blocks on this.
    pub looks_like_vault: bool,
}

/// Read-only check behind [`VaultStatus`]. An empty path reports "doesn't
/// exist" rather than erroring — there's nothing to say about it yet.
pub fn vault_status(path: &str) -> VaultStatus {
    let path = Path::new(path.trim());
    match fs::metadata(path) {
        Ok(metadata) => {
            let is_directory = metadata.is_dir();
            VaultStatus {
                exists: true,
                is_directory,
                looks_like_vault: is_directory && path.join(".obsidian").is_dir(),
            }
        }
        Err(_) => VaultStatus {
            exists: false,
            is_directory: false,
            looks_like_vault: false,
        },
    }
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/// Quotes `value` as a YAML double-quoted scalar. Always quoted — a bare
/// title containing `:`, `#`, `[`, a leading `-`/`*`/`?`, or a newline would
/// otherwise change the frontmatter's meaning (or break it entirely), and
/// quoting unconditionally is simpler to reason about than deciding when
/// it's needed. Escapes follow YAML's double-quoted rules: `\"`, `\\`, and
/// `\n`/`\r`/`\t`; other control characters and the Unicode line/paragraph
/// separators (which YAML treats as line breaks) go out as `\uXXXX`.
pub fn yaml_quote(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{2028}' | '\u{2029}' => out.push_str(&format!("\\u{:04X}", c as u32)),
            c if c.is_control() => out.push_str(&format!("\\u{:04X}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// The distinct speaker labels of a transcript, in order of first
/// appearance — whatever the segments say right now, so a renamed
/// "Speaker 2" shows up as "Sarah", the same way `note.md` renders it.
pub fn participants(transcript: &Transcript) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for segment in &transcript.segments {
        let name = segment.speaker.trim();
        if name.is_empty() || seen.iter().any(|known| known == name) {
            continue;
        }
        seen.push(name.to_string());
    }
    seen
}

/// Parses a note's `created_at` (RFC 3339, written by `store::create_note`).
fn parse_created_at(created_at: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(created_at, &Rfc3339).ok()
}

/// The system's UTC offset at the moment `created_at` names (so a note from
/// last winter gets its DST-correct local date, not today's offset), or UTC
/// when the platform can't say. The one place this module asks the system
/// anything about time — every rendering function takes the result as a
/// parameter instead, which is what keeps their tests deterministic.
pub fn local_offset_for(created_at: &str) -> UtcOffset {
    match parse_created_at(created_at) {
        Some(instant) => UtcOffset::local_offset_at(instant).unwrap_or(UtcOffset::UTC),
        None => UtcOffset::current_local_offset().unwrap_or(UtcOffset::UTC),
    }
}

/// The frontmatter `date:` value — `created_at` re-expressed in `offset`
/// (so it reads as local wall-clock time, with the offset spelled out) in
/// RFC 3339, which Obsidian's Date & time property type and Dataview both
/// parse. Left unquoted because RFC 3339 output contains nothing YAML could
/// misread; an unparseable `created_at` (never written by this app, but a
/// hand-edited `meta.json` is possible) falls back to the raw string,
/// quoted, rather than failing the export over a timestamp.
fn frontmatter_date(created_at: &str, offset: UtcOffset) -> String {
    match parse_created_at(created_at) {
        Some(instant) => instant
            .to_offset(offset)
            .format(&Rfc3339)
            .unwrap_or_else(|_| yaml_quote(created_at)),
        None => yaml_quote(created_at),
    }
}

/// The YAML frontmatter block, `---` to `---` inclusive, with a trailing
/// newline. Keys: `title`; `date` (see [`frontmatter_date`]); `duration`
/// (whole minutes, rounded the same way `note.md`'s header rounds it);
/// `participants` (see [`participants`]; `[]` when the transcript is
/// empty); `tags` (`meeting` and `minute`, so a Dataview query can find
/// every exported note); and `minute_id` (the note id — how
/// [`find_existing_export`] recognizes Minute's own files later). Every
/// string goes through [`yaml_quote`].
pub fn render_frontmatter(meta: &NoteMeta, transcript: &Transcript, offset: UtcOffset) -> String {
    let minutes = (meta.duration_sec / 60.0).round() as i64;
    let mut out = String::from("---\n");
    out.push_str(&format!("title: {}\n", yaml_quote(&meta.title)));
    out.push_str(&format!(
        "date: {}\n",
        frontmatter_date(&meta.created_at, offset)
    ));
    out.push_str(&format!("duration: {minutes}\n"));
    let participants = participants(transcript);
    if participants.is_empty() {
        out.push_str("participants: []\n");
    } else {
        out.push_str("participants:\n");
        for name in &participants {
            out.push_str(&format!("  - {}\n", yaml_quote(name)));
        }
    }
    out.push_str("tags:\n  - meeting\n  - minute\n");
    out.push_str(&format!("{MINUTE_ID_KEY}: {}\n", yaml_quote(&meta.id)));
    out.push_str("---\n");
    out
}

/// The whole vault note: [`render_frontmatter`], a blank line, then the
/// exact sections `note.md` has (`store::render_note_sections` — the
/// `# Title` header, summary, topics, decisions, action items as
/// `- [ ]`/`- [x]`, markers), then, when `include_transcript`, the same
/// `## Transcript` section. Ends with a newline, as a file should. Sharing
/// the section renderers with `store.rs` is what keeps this from drifting
/// away from `note.md`.
pub fn render_obsidian_md(
    meta: &NoteMeta,
    summary: Option<&SummaryDoc>,
    transcript: &Transcript,
    include_transcript: bool,
    offset: UtcOffset,
) -> String {
    let mut out = render_frontmatter(meta, transcript, offset);
    out.push('\n');
    out.push_str(&store::render_note_sections(meta, summary));
    if include_transcript {
        out.push_str("\n\n");
        out.push_str(&store::render_transcript_section(transcript));
    }
    out.push('\n');
    out
}

// ---------------------------------------------------------------------------
// Naming
// ---------------------------------------------------------------------------

/// Expands `template`'s `{token}`s against `lookup`, leaving an unknown or
/// unterminated token in place verbatim. A single left-to-right pass, so a
/// title that itself contains `{id}` is never re-expanded.
fn expand_template(template: &str, lookup: impl Fn(&str) -> Option<String>) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(open) = rest.find('{') {
        out.push_str(&rest[..open]);
        let after_brace = &rest[open + 1..];
        match after_brace.find('}') {
            Some(close) => {
                let name = &after_brace[..close];
                match lookup(name) {
                    Some(value) => out.push_str(&value),
                    None => {
                        out.push('{');
                        out.push_str(name);
                        out.push('}');
                    }
                }
                rest = &after_brace[close + 1..];
            }
            None => {
                out.push_str(rest);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    out
}

/// `YYYY-MM-DD` from a Minute note id (`YYYYMMDD-HHMMSS`, UTC) — only
/// reached when `created_at` doesn't parse, which the app itself never
/// writes. Empty if the id doesn't look like one either.
fn id_date_fallback(id: &str) -> String {
    let digits: String = id.chars().take(8).collect();
    if digits.len() == 8 && digits.chars().all(|c| c.is_ascii_digit()) {
        format!("{}-{}-{}", &digits[..4], &digits[4..6], &digits[6..8])
    } else {
        String::new()
    }
}

/// Renders the filename *stem* (no `.md`) for a note from the user's
/// template. Tokens: `{date}` — the recording's date in `offset`
/// (`YYYY-MM-DD`); `{time}` — its start time as `HH-MM` (a hyphen, since
/// `:` isn't allowed in a filename); `{title}`; `{id}` — the Minute note
/// id. Anything else between braces is left literally in the name — a
/// visible typo beats a silent export failure, and the user sees it in
/// Finder right away. An empty template means the default one.
///
/// The expanded result then goes through [`sanitize_filename_component`]
/// as a whole (so a `/` in a title, or in the template itself, can't create
/// a subfolder); should that leave nothing (a title of only `???`, say,
/// with a `{title}`-only template), the note id stands in, which is always
/// a valid, unique name.
pub fn render_filename(template: &str, meta: &NoteMeta, offset: UtcOffset) -> String {
    let template = if template.trim().is_empty() {
        DEFAULT_FILENAME_TEMPLATE
    } else {
        template
    };
    let created = parse_created_at(&meta.created_at).map(|instant| instant.to_offset(offset));
    let date = created
        .map(|dt| {
            format!(
                "{:04}-{:02}-{:02}",
                dt.year(),
                u8::from(dt.month()),
                dt.day()
            )
        })
        .unwrap_or_else(|| id_date_fallback(&meta.id));
    let time = created
        .map(|dt| format!("{:02}-{:02}", dt.hour(), dt.minute()))
        .unwrap_or_default();
    let expanded = expand_template(template, |token| match token {
        "date" => Some(date.clone()),
        "time" => Some(time.clone()),
        "title" => Some(meta.title.clone()),
        "id" => Some(meta.id.clone()),
        _ => None,
    });
    let stem = sanitize_filename_component(&expanded);
    if !stem.is_empty() {
        return stem;
    }
    let from_id = sanitize_filename_component(&meta.id);
    if from_id.is_empty() {
        "Untitled meeting".to_string()
    } else {
        from_id
    }
}

/// Makes `raw` safe as a single filename on macOS (and under Obsidian's own
/// rules, which are stricter): the characters Obsidian refuses in a note
/// name (`* " \ / < > : | ?`) and the four that break `[[wikilinks]]` to it
/// (`# ^ [ ]`) become spaces, as do control characters; whitespace runs
/// collapse to one space; leading dots (a hidden file) and trailing dots or
/// spaces (which Finder and Windows both choke on) are trimmed; and the
/// result is cut to [`MAX_STEM_CHARS`] characters / [`MAX_STEM_BYTES`]
/// bytes — on a character boundary, so a multibyte title is never split
/// mid-character — and re-trimmed. Returns an empty string when nothing
/// survives; callers pick the fallback. Unicode letters are kept as they
/// are: "Réunion — Équipe" is a fine filename.
pub fn sanitize_filename_component(raw: &str) -> String {
    let replaced: String = raw
        .chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' | '#' | '^' | '[' | ']' => ' ',
            c if c.is_control() => ' ',
            c => c,
        })
        .collect();
    let collapsed = replaced.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = trim_dots_and_spaces(&collapsed);
    let mut capped = String::new();
    let mut chars_taken = 0;
    for c in trimmed.chars() {
        if chars_taken == MAX_STEM_CHARS || capped.len() + c.len_utf8() > MAX_STEM_BYTES {
            break;
        }
        capped.push(c);
        chars_taken += 1;
    }
    trim_dots_and_spaces(&capped).to_string()
}

fn trim_dots_and_spaces(s: &str) -> &str {
    s.trim_start_matches(|c: char| c == '.' || c == ' ')
        .trim_end_matches(|c: char| c == '.' || c == ' ')
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/// Splits the configured subfolder (`Settings::obsidian_folder`) into plain
/// path components, or refuses it: an absolute path, or any `..`
/// component, could put exports outside the vault the user pointed at.
/// Both `/` and `\` separate components; empty and `.` components (from a
/// leading, trailing or doubled slash) are dropped. The empty folder is
/// valid and means the vault root. Called at save time by
/// `settings::apply_and_save` and again at export time by
/// [`resolve_target_dir`], so a value that bypassed Settings is still
/// caught.
pub fn vault_subfolder_components(folder: &str) -> Result<Vec<String>> {
    let folder = folder.trim();
    if folder.starts_with('/') || folder.starts_with('\\') {
        return Err(MinuteError::Other(format!(
            "The Obsidian folder must be relative to the vault, not an absolute path: {folder}"
        )));
    }
    let mut components = Vec::new();
    for part in folder.split(|c| c == '/' || c == '\\') {
        let part = part.trim();
        match part {
            "" | "." => continue,
            ".." => {
                return Err(MinuteError::Other(format!(
                    "The Obsidian folder must stay inside the vault — \"..\" isn't allowed: {folder}"
                )))
            }
            _ => components.push(part.to_string()),
        }
    }
    Ok(components)
}

/// Where a note goes: the vault folder (which must already exist — Minute
/// never creates a vault, only subfolders inside one the user chose) joined
/// with the sanity-checked subfolder. Each failure names the path and the
/// fix, since this is the message the user sees in the error banner.
/// Doesn't create anything — see [`export_note_to_vault`].
pub fn resolve_target_dir(vault_path: &str, folder: &str) -> Result<PathBuf> {
    let vault_path = vault_path.trim();
    if vault_path.is_empty() {
        return Err(MinuteError::Other(
            "No Obsidian vault folder is set. Choose one in Settings → Obsidian.".to_string(),
        ));
    }
    let vault = Path::new(vault_path);
    if !vault.is_absolute() {
        return Err(MinuteError::Other(format!(
            "The Obsidian vault path must be an absolute path: {vault_path}. Choose it again in Settings → Obsidian."
        )));
    }
    match fs::metadata(vault) {
        Ok(metadata) if metadata.is_dir() => {}
        Ok(_) => {
            return Err(MinuteError::Other(format!(
                "The Obsidian vault path is a file, not a folder: {vault_path}. Choose a folder in Settings → Obsidian."
            )))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Err(MinuteError::Other(format!(
                "Obsidian vault folder not found: {vault_path}. Choose it again in Settings → Obsidian."
            )))
        }
        Err(e) => {
            return Err(MinuteError::Other(format!(
                "Can't read the Obsidian vault folder {vault_path}: {e}"
            )))
        }
    }
    let mut target = vault.to_path_buf();
    for component in vault_subfolder_components(folder)? {
        target.push(component);
    }
    Ok(target)
}

// ---------------------------------------------------------------------------
// Existing exports (idempotence)
// ---------------------------------------------------------------------------

/// The frontmatter block of `text` — the lines between an opening `---` on
/// the very first line and the next line that is exactly `---` — or `None`
/// when the text doesn't start with one.
fn frontmatter_block(text: &str) -> Option<&str> {
    let body = text
        .strip_prefix("---\n")
        .or_else(|| text.strip_prefix("---\r\n"))?;
    let mut consumed = 0;
    for line in body.split_inclusive('\n') {
        if line.trim_end_matches(|c: char| c == '\r' || c == '\n') == "---" {
            return Some(&body[..consumed]);
        }
        consumed += line.len();
    }
    None
}

/// The `minute_id` a frontmatter block claims, if any. Lenient about
/// quoting — Minute writes the value double-quoted, but Obsidian's
/// Properties editor rewrites frontmatter when the user edits any property
/// and may drop quotes a plain value doesn't need. Only a top-level key
/// counts (no indentation), so a nested `minute_id` under some other map
/// isn't mistaken for ours.
fn frontmatter_minute_id(block: &str) -> Option<String> {
    block.lines().find_map(|line| {
        let value = line
            .strip_prefix(MINUTE_ID_KEY)?
            .strip_prefix(':')?
            .trim();
        let unquoted = value
            .strip_prefix('"')
            .and_then(|v| v.strip_suffix('"'))
            .or_else(|| value.strip_prefix('\'').and_then(|v| v.strip_suffix('\'')))
            .unwrap_or(value);
        Some(unquoted.to_string())
    })
}

/// Whether the file at `path` is one Minute wrote for note `minute_id`: a
/// Markdown file whose frontmatter carries that `minute_id`. Reads at most
/// [`FRONTMATTER_SCAN_BYTES`]; anything unreadable is simply "not ours".
fn file_claims_minute_id(path: &Path, minute_id: &str) -> bool {
    let Ok(file) = fs::File::open(path) else {
        return false;
    };
    let mut head = Vec::new();
    if file
        .take(FRONTMATTER_SCAN_BYTES)
        .read_to_end(&mut head)
        .is_err()
    {
        return false;
    }
    let text = String::from_utf8_lossy(&head);
    frontmatter_block(&text)
        .and_then(frontmatter_minute_id)
        .is_some_and(|found| found == minute_id)
}

/// Looks through `dir` for Minute's own earlier export of note `minute_id`
/// (see [`file_claims_minute_id`]). Only the target folder itself is
/// scanned, not the whole vault — a note the user moved elsewhere in their
/// vault is theirs now, and a fresh export landing in the configured folder
/// is the right outcome. Several matches (a copy the user made) resolve to
/// the alphabetically first so the answer is stable between runs.
pub fn find_existing_export(dir: &Path, minute_id: &str) -> Option<PathBuf> {
    let entries = fs::read_dir(dir).ok()?;
    let mut matches: Vec<PathBuf> = entries
        .filter_map(|entry| entry.ok())
        .map(|entry| entry.path())
        .filter(|path| path.extension().and_then(|ext| ext.to_str()) == Some("md"))
        .filter(|path| path.is_file())
        .filter(|path| file_claims_minute_id(path, minute_id))
        .collect();
    matches.sort();
    matches.into_iter().next()
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/// `<dir>/<stem>.md` for the first attempt, `<dir>/<stem> (N).md` after
/// that — the collision naming Finder itself uses for duplicates.
pub fn candidate_path(dir: &Path, stem: &str, attempt: u32) -> PathBuf {
    if attempt <= 1 {
        dir.join(format!("{stem}.md"))
    } else {
        dir.join(format!("{stem} ({attempt}).md"))
    }
}

/// Writes `contents` to the first free [`candidate_path`] in `dir`. The
/// name is claimed with `create_new` — an atomic, exclusive create — rather
/// than an `exists()` check followed by a write, so two exports racing for
/// the same name (two summaries finishing together, or Obsidian Sync
/// dropping a file in at the wrong moment) can never overwrite each other:
/// the loser just moves on to the next suffix. Permission problems get a
/// message that says what to do, since that's the one the user will see.
fn create_exclusively(dir: &Path, stem: &str, contents: &str) -> Result<PathBuf> {
    for attempt in 1..=MAX_COLLISION_ATTEMPTS {
        let path = candidate_path(dir, stem, attempt);
        match OpenOptions::new().write(true).create_new(true).open(&path) {
            Ok(mut file) => {
                file.write_all(contents.as_bytes())?;
                return Ok(path);
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied => {
                return Err(MinuteError::Other(format!(
                    "Minute isn't allowed to write to the Obsidian folder {}. Check the folder's permissions, or choose another vault in Settings → Obsidian.",
                    dir.display()
                )))
            }
            Err(e) => {
                return Err(MinuteError::Other(format!(
                    "Couldn't write {}: {e}",
                    path.display()
                )))
            }
        }
    }
    Err(MinuteError::Other(format!(
        "Couldn't find a free filename for \"{stem}\" in {} after {MAX_COLLISION_ATTEMPTS} tries.",
        dir.display()
    )))
}

/// The one I/O entry point: writes `meta`/`summary`/`transcript` as a vault
/// note per `settings`, or says why not. In order: check the vault and
/// subfolder ([`resolve_target_dir`]); create the subfolder if needed
/// (never the vault itself); look for an earlier export of this note
/// ([`find_existing_export`] — `AlreadyExported`, nothing written); then
/// render and write to a free name ([`create_exclusively`]). `offset` is
/// the local UTC offset for the note's date and time — see
/// [`local_offset_for`]; passed in rather than looked up so tests pin it.
///
/// `summary` is optional only because the renderer's is — the caller in
/// `llm.rs` always has one. Errors are human sentences (see each helper),
/// ready for the frontend's banner; the caller decides what a failure
/// means, and for the post-summary hook it never means a failed summary.
pub fn export_note_to_vault(
    settings: &Settings,
    meta: &NoteMeta,
    summary: Option<&SummaryDoc>,
    transcript: &Transcript,
    offset: UtcOffset,
) -> Result<ExportOutcome> {
    let vault_path = settings.obsidian_vault_path.as_deref().unwrap_or("");
    let target_dir = resolve_target_dir(vault_path, &settings.obsidian_folder)?;
    fs::create_dir_all(&target_dir).map_err(|e| {
        MinuteError::Other(format!(
            "Couldn't create the Obsidian folder {}: {e}",
            target_dir.display()
        ))
    })?;
    if let Some(existing) = find_existing_export(&target_dir, &meta.id) {
        return Ok(ExportOutcome::AlreadyExported(existing));
    }
    let stem = render_filename(&settings.obsidian_filename_template, meta, offset);
    let contents = render_obsidian_md(
        meta,
        summary,
        transcript,
        settings.obsidian_include_transcript,
        offset,
    );
    let path = create_exclusively(&target_dir, &stem, &contents)?;
    Ok(ExportOutcome::Written(path))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::llm::ActionItem;
    use crate::store::{NoteStatus, StoredSegment};
    use std::collections::HashMap;
    use tempfile::tempdir;
    use time::macros::offset;

    fn meta(overrides: impl FnOnce(&mut NoteMeta)) -> NoteMeta {
        let mut meta = NoteMeta {
            id: "20260521-140000".to_string(),
            title: "Client call — Acme".to_string(),
            created_at: "2026-05-21T14:00:00Z".to_string(),
            duration_sec: 48.0 * 60.0,
            model: "whisper-small".to_string(),
            status: NoteStatus::Ready,
            speakers: 2,
            capture_warning: None,
            audio_deleted: false,
            audio_compressed: false,
            sources: vec!["mic".to_string()],
            pinned: false,
            markers: Vec::new(),
            speaker_aliases: HashMap::new(),
            speaker_suggestions: HashMap::new(),
            speaker_auto_applied: HashMap::new(),
        };
        overrides(&mut meta);
        meta
    }

    fn transcript() -> Transcript {
        Transcript {
            segments: vec![
                StoredSegment {
                    speaker: "Sarah".into(),
                    start: 1.0,
                    end: 4.0,
                    text: "Thanks for making time.".into(),
                },
                StoredSegment {
                    speaker: "Speaker 2".into(),
                    start: 5.0,
                    end: 9.0,
                    text: "Of course.".into(),
                },
                StoredSegment {
                    speaker: "Sarah".into(),
                    start: 10.0,
                    end: 12.0,
                    text: "Let's start.".into(),
                },
            ],
        }
    }

    fn summary() -> SummaryDoc {
        SummaryDoc {
            summary: "Reviewed the roadmap.".to_string(),
            topics: Vec::new(),
            decisions: vec!["Ship the beta by Friday".to_string()],
            action_items: vec![
                ActionItem {
                    text: "Write release notes".to_string(),
                    done: true,
                },
                ActionItem {
                    text: "Schedule the retro".to_string(),
                    done: false,
                },
            ],
            truncated: false,
        }
    }

    fn settings_for(vault: &Path) -> Settings {
        Settings {
            obsidian_enabled: true,
            obsidian_vault_path: Some(vault.to_string_lossy().into_owned()),
            ..Settings::default()
        }
    }

    // --- frontmatter --------------------------------------------------------

    #[test]
    fn yaml_quote_escapes_everything_that_could_change_the_frontmatters_meaning() {
        assert_eq!(yaml_quote("plain"), "\"plain\"");
        assert_eq!(
            yaml_quote("Q3: planning #1 [draft]"),
            "\"Q3: planning #1 [draft]\""
        );
        assert_eq!(
            yaml_quote("say \"hi\" \\ bye"),
            "\"say \\\"hi\\\" \\\\ bye\""
        );
        assert_eq!(
            yaml_quote("line\nbreak\ttab\r"),
            "\"line\\nbreak\\ttab\\r\""
        );
        assert_eq!(yaml_quote("bell\u{7}"), "\"bell\\u0007\"");
        assert_eq!(yaml_quote("a\u{2028}b"), "\"a\\u2028b\"");
        assert_eq!(
            yaml_quote("- leading dash * star"),
            "\"- leading dash * star\""
        );
    }

    #[test]
    fn render_frontmatter_lists_distinct_participants_in_order_and_quotes_every_string() {
        let note = meta(|m| m.title = "Q3: \"planning\" #1".to_string());

        let frontmatter = render_frontmatter(&note, &transcript(), UtcOffset::UTC);

        let expected = [
            "---",
            "title: \"Q3: \\\"planning\\\" #1\"",
            "date: 2026-05-21T14:00:00Z",
            "duration: 48",
            "participants:",
            "  - \"Sarah\"",
            "  - \"Speaker 2\"",
            "tags:",
            "  - meeting",
            "  - minute",
            "minute_id: \"20260521-140000\"",
            "---",
            "",
        ]
        .join("\n");
        assert_eq!(frontmatter, expected);
    }

    #[test]
    fn render_frontmatter_expresses_the_date_in_the_given_local_offset() {
        let frontmatter = render_frontmatter(&meta(|_| {}), &Transcript::default(), offset!(-7));

        assert!(
            frontmatter.contains("\ndate: 2026-05-21T07:00:00-07:00\n"),
            "{frontmatter}"
        );
        assert!(frontmatter.contains("\nparticipants: []\n"));
    }

    #[test]
    fn render_frontmatter_quotes_an_unparseable_created_at_instead_of_failing() {
        let note = meta(|m| m.created_at = "yesterday-ish".to_string());

        let frontmatter = render_frontmatter(&note, &Transcript::default(), UtcOffset::UTC);

        assert!(frontmatter.contains("\ndate: \"yesterday-ish\"\n"), "{frontmatter}");
    }

    #[test]
    fn participants_are_distinct_trimmed_and_in_first_appearance_order() {
        let transcript = Transcript {
            segments: vec![
                StoredSegment {
                    speaker: " Speaker 2 ".into(),
                    start: 0.0,
                    end: 1.0,
                    text: "a".into(),
                },
                StoredSegment {
                    speaker: "Sarah".into(),
                    start: 1.0,
                    end: 2.0,
                    text: "b".into(),
                },
                StoredSegment {
                    speaker: "Speaker 2".into(),
                    start: 2.0,
                    end: 3.0,
                    text: "c".into(),
                },
                StoredSegment {
                    speaker: "".into(),
                    start: 3.0,
                    end: 4.0,
                    text: "d".into(),
                },
            ],
        };
        assert_eq!(participants(&transcript), vec!["Speaker 2", "Sarah"]);
    }

    // --- the whole note -----------------------------------------------------

    #[test]
    fn render_obsidian_md_puts_note_mds_sections_under_the_frontmatter() {
        let md = render_obsidian_md(
            &meta(|_| {}),
            Some(&summary()),
            &transcript(),
            true,
            UtcOffset::UTC,
        );

        assert!(md.starts_with("---\ntitle: "), "{md}");
        // Body is byte-for-byte what note.md would be, plus a final newline —
        // the closing `---` is the only one preceded by a newline.
        let marker = "\n---\n\n";
        let body_start = md.find(marker).expect("closing frontmatter delimiter") + marker.len();
        let expected_body = store::render_note_md(&meta(|_| {}), Some(&summary()), &transcript());
        assert_eq!(&md[body_start..], format!("{expected_body}\n"));
        assert!(md.contains(
            "\n## Action items\n\n- [x] Write release notes\n- [ ] Schedule the retro\n"
        ));
        assert!(md.contains("\n## Transcript\n\n**Sarah** (00:01)\nThanks for making time.\n"));
    }

    #[test]
    fn render_obsidian_md_can_leave_the_transcript_out() {
        let md = render_obsidian_md(
            &meta(|_| {}),
            Some(&summary()),
            &transcript(),
            false,
            UtcOffset::UTC,
        );

        assert!(!md.contains("## Transcript"), "{md}");
        // Participants still come from the transcript even when its text
        // is left out.
        assert!(md.contains("  - \"Sarah\"\n"));
        assert!(md.ends_with("- [ ] Schedule the retro\n"), "{md}");
    }

    // --- filenames ----------------------------------------------------------

    #[test]
    fn render_filename_expands_every_token_in_the_given_offset() {
        let note = meta(|_| {});
        assert_eq!(
            render_filename("{date} - {title}", &note, UtcOffset::UTC),
            "2026-05-21 - Client call — Acme"
        );
        assert_eq!(
            render_filename("{date} {time} {id}", &note, offset!(-7)),
            "2026-05-21 07-00 20260521-140000"
        );
        // 23:30 UTC on the 21st is already the 22nd two hours east.
        let late = meta(|m| m.created_at = "2026-05-21T23:30:00Z".to_string());
        assert_eq!(
            render_filename("{date} {time}", &late, offset!(+2)),
            "2026-05-22 01-30"
        );
    }

    #[test]
    fn render_filename_leaves_unknown_tokens_literal_and_never_reexpands_a_title() {
        let note = meta(|m| m.title = "Budget {id} talk".to_string());
        assert_eq!(
            render_filename("{title} {nope}", &note, UtcOffset::UTC),
            "Budget {id} talk {nope}"
        );
        assert_eq!(
            render_filename("{unterminated", &note, UtcOffset::UTC),
            "{unterminated"
        );
    }

    #[test]
    fn render_filename_falls_back_to_the_default_template_and_then_the_id() {
        let note = meta(|_| {});
        assert_eq!(
            render_filename("   ", &note, UtcOffset::UTC),
            "2026-05-21 - Client call — Acme"
        );
        let hostile = meta(|m| m.title = "???".to_string());
        assert_eq!(
            render_filename("{title}", &hostile, UtcOffset::UTC),
            "20260521-140000"
        );
    }

    #[test]
    fn render_filename_sanitizes_the_whole_name_so_a_title_cannot_make_a_subfolder() {
        let note = meta(|m| m.title = "../../etc/passwd".to_string());
        assert_eq!(render_filename("{title}", &note, UtcOffset::UTC), "etc passwd");
        assert_eq!(
            render_filename("Meetings/{date}", &note, UtcOffset::UTC),
            "Meetings 2026-05-21"
        );
    }

    #[test]
    fn sanitize_filename_component_handles_obsidians_forbidden_characters() {
        assert_eq!(
            sanitize_filename_component("Q3: plan/review * \"final\" <v2> | ok?"),
            "Q3 plan review final v2 ok"
        );
        assert_eq!(
            sanitize_filename_component("#tag ^ref [link] a\\b"),
            "tag ref link a b"
        );
        assert_eq!(sanitize_filename_component("  spaced   out  "), "spaced out");
        assert_eq!(sanitize_filename_component("...hidden"), "hidden");
        assert_eq!(sanitize_filename_component("trailing. . "), "trailing");
        assert_eq!(
            sanitize_filename_component("ctrl\u{0}char\u{1b}"),
            "ctrl char"
        );
        assert_eq!(
            sanitize_filename_component("Réunion — Équipe 日本語"),
            "Réunion — Équipe 日本語"
        );
        assert_eq!(sanitize_filename_component("???"), "");
    }

    #[test]
    fn sanitize_filename_component_caps_length_on_a_character_boundary() {
        let long_ascii = "a".repeat(300);
        assert_eq!(
            sanitize_filename_component(&long_ascii).chars().count(),
            MAX_STEM_CHARS
        );

        let long_cjk = "日".repeat(300);
        let capped = sanitize_filename_component(&long_cjk);
        assert!(capped.len() <= MAX_STEM_BYTES, "{} bytes", capped.len());
        assert!(!capped.is_empty());
        assert!(capped.chars().all(|c| c == '日'));

        // A cut that lands right after a space still trims it.
        let spaced = format!("{} x", "b".repeat(MAX_STEM_CHARS - 1));
        assert_eq!(
            sanitize_filename_component(&spaced),
            "b".repeat(MAX_STEM_CHARS - 1)
        );
    }

    // --- paths --------------------------------------------------------------

    #[test]
    fn vault_subfolder_components_accepts_nested_relative_folders_and_rejects_escapes() {
        assert_eq!(
            vault_subfolder_components("Meetings").unwrap(),
            vec!["Meetings"]
        );
        assert_eq!(
            vault_subfolder_components(" Work/Meetings/ ").unwrap(),
            vec!["Work", "Meetings"]
        );
        assert_eq!(
            vault_subfolder_components("Work\\2026").unwrap(),
            vec!["Work", "2026"]
        );
        assert_eq!(
            vault_subfolder_components("./Meetings//").unwrap(),
            vec!["Meetings"]
        );
        assert!(vault_subfolder_components("").unwrap().is_empty());
        assert!(vault_subfolder_components("../Elsewhere").is_err());
        assert!(vault_subfolder_components("Meetings/../..").is_err());
        assert!(vault_subfolder_components("/Users/sam/Elsewhere").is_err());
        assert!(
            vault_subfolder_components("..foo").is_ok(),
            "a name that merely starts with dots is fine"
        );
    }

    #[test]
    fn resolve_target_dir_names_the_path_and_the_fix_in_every_error() {
        let dir = tempdir().unwrap();

        let missing = dir.path().join("Gone");
        let err = resolve_target_dir(&missing.to_string_lossy(), "Meetings")
            .unwrap_err()
            .to_string();
        assert!(err.contains("not found"), "{err}");
        assert!(err.contains(&*missing.to_string_lossy()), "{err}");
        assert!(err.contains("Settings → Obsidian"), "{err}");

        let err = resolve_target_dir("", "Meetings").unwrap_err().to_string();
        assert!(err.contains("No Obsidian vault folder is set"), "{err}");

        let err = resolve_target_dir("relative/vault", "Meetings")
            .unwrap_err()
            .to_string();
        assert!(err.contains("absolute"), "{err}");

        let file = dir.path().join("not-a-dir");
        fs::write(&file, b"x").unwrap();
        let err = resolve_target_dir(&file.to_string_lossy(), "Meetings")
            .unwrap_err()
            .to_string();
        assert!(err.contains("a file, not a folder"), "{err}");

        let err = resolve_target_dir(&dir.path().to_string_lossy(), "../Elsewhere")
            .unwrap_err()
            .to_string();
        assert!(err.contains("inside the vault"), "{err}");
    }

    #[test]
    fn resolve_target_dir_joins_the_subfolder_without_creating_it() {
        let dir = tempdir().unwrap();

        let target = resolve_target_dir(&dir.path().to_string_lossy(), "Work/Meetings").unwrap();

        assert_eq!(target, dir.path().join("Work").join("Meetings"));
        assert!(!target.exists());
        let root = resolve_target_dir(&dir.path().to_string_lossy(), "").unwrap();
        assert_eq!(root, dir.path());
    }

    // --- existing exports ---------------------------------------------------

    #[test]
    fn find_existing_export_matches_a_minute_id_obsidian_may_have_unquoted() {
        let dir = tempdir().unwrap();
        // Obsidian's Properties editor rewrites frontmatter and may drop
        // the quotes Minute wrote.
        fs::write(
            dir.path().join("Edited.md"),
            "---\ntitle: Edited\nminute_id: 20260521-140000\n---\n\nbody\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("Other.md"),
            "---\nminute_id: \"20260521-999999\"\n---\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("NoFrontmatter.md"),
            "minute_id: \"20260521-140000\"\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("Nested.md"),
            "---\nminute:\n  minute_id: \"20260521-140000\"\n---\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("Not markdown.txt"),
            "---\nminute_id: \"20260521-140000\"\n---\n",
        )
        .unwrap();

        assert_eq!(
            find_existing_export(dir.path(), "20260521-140000"),
            Some(dir.path().join("Edited.md"))
        );
        assert_eq!(find_existing_export(dir.path(), "20260521-000000"), None);
    }

    #[test]
    fn find_existing_export_only_trusts_frontmatter_at_the_top_of_the_file() {
        let dir = tempdir().unwrap();
        let mut huge = String::from("# A huge note the user wrote\n\n");
        huge.push_str(&"lorem ipsum ".repeat(20_000));
        huge.push_str("\n---\nminute_id: \"20260521-140000\"\n---\n");
        fs::write(dir.path().join("Huge.md"), huge).unwrap();

        // The id appears, but not in a frontmatter block at the top — not
        // ours.
        assert_eq!(find_existing_export(dir.path(), "20260521-140000"), None);
    }

    #[test]
    fn candidate_path_counts_from_the_plain_name() {
        let dir = Path::new("/vault/Meetings");
        assert_eq!(candidate_path(dir, "Note", 1), dir.join("Note.md"));
        assert_eq!(candidate_path(dir, "Note", 2), dir.join("Note (2).md"));
        assert_eq!(candidate_path(dir, "Note", 10), dir.join("Note (10).md"));
    }

    // --- export_note_to_vault -----------------------------------------------

    #[test]
    fn export_note_to_vault_writes_the_note_into_the_subfolder_it_creates() {
        let dir = tempdir().unwrap();
        let settings = settings_for(dir.path());

        let outcome = export_note_to_vault(
            &settings,
            &meta(|_| {}),
            Some(&summary()),
            &transcript(),
            UtcOffset::UTC,
        )
        .unwrap();

        let expected = dir
            .path()
            .join("Meetings")
            .join("2026-05-21 - Client call — Acme.md");
        assert_eq!(outcome, ExportOutcome::Written(expected.clone()));
        let written = fs::read_to_string(&expected).unwrap();
        assert_eq!(
            written,
            render_obsidian_md(
                &meta(|_| {}),
                Some(&summary()),
                &transcript(),
                true,
                UtcOffset::UTC
            )
        );
        assert!(written.contains("minute_id: \"20260521-140000\""));
    }

    #[test]
    fn export_note_to_vault_honors_the_folder_template_and_transcript_settings() {
        let dir = tempdir().unwrap();
        let settings = Settings {
            obsidian_folder: "Work/Meetings".to_string(),
            obsidian_filename_template: "{id}".to_string(),
            obsidian_include_transcript: false,
            ..settings_for(dir.path())
        };

        let outcome = export_note_to_vault(
            &settings,
            &meta(|_| {}),
            Some(&summary()),
            &transcript(),
            UtcOffset::UTC,
        )
        .unwrap();

        let expected = dir
            .path()
            .join("Work")
            .join("Meetings")
            .join("20260521-140000.md");
        assert_eq!(outcome, ExportOutcome::Written(expected.clone()));
        assert!(!fs::read_to_string(&expected).unwrap().contains("## Transcript"));
    }

    #[test]
    fn export_note_to_vault_never_creates_the_vault_itself() {
        let dir = tempdir().unwrap();
        let vault = dir.path().join("NoSuchVault");
        let settings = settings_for(&vault);

        let err = export_note_to_vault(
            &settings,
            &meta(|_| {}),
            None,
            &Transcript::default(),
            UtcOffset::UTC,
        )
        .unwrap_err();

        assert!(err.to_string().contains("not found"), "{err}");
        assert!(!vault.exists());
    }

    #[test]
    fn export_note_to_vault_reports_a_missing_vault_path_plainly() {
        let settings = Settings {
            obsidian_enabled: true,
            ..Settings::default()
        };

        let err = export_note_to_vault(
            &settings,
            &meta(|_| {}),
            None,
            &Transcript::default(),
            UtcOffset::UTC,
        )
        .unwrap_err();

        assert!(
            err.to_string().contains("No Obsidian vault folder is set"),
            "{err}"
        );
    }

    #[test]
    fn export_note_to_vault_suffixes_instead_of_overwriting_a_taken_name() {
        let dir = tempdir().unwrap();
        let settings = settings_for(dir.path());
        let folder = dir.path().join("Meetings");
        fs::create_dir_all(&folder).unwrap();
        // The user's own note with the very same name — no `minute_id`, so
        // it isn't ours and must not be touched.
        let theirs = folder.join("2026-05-21 - Client call — Acme.md");
        fs::write(&theirs, "# My own notes\n").unwrap();
        // A second collision too, so the suffix has to count past (2).
        fs::write(
            folder.join("2026-05-21 - Client call — Acme (2).md"),
            "also mine\n",
        )
        .unwrap();

        let outcome = export_note_to_vault(
            &settings,
            &meta(|_| {}),
            Some(&summary()),
            &transcript(),
            UtcOffset::UTC,
        )
        .unwrap();

        assert_eq!(
            outcome,
            ExportOutcome::Written(folder.join("2026-05-21 - Client call — Acme (3).md"))
        );
        assert_eq!(fs::read_to_string(&theirs).unwrap(), "# My own notes\n");
    }

    #[test]
    fn export_note_to_vault_skips_when_its_own_earlier_export_is_already_there() {
        let dir = tempdir().unwrap();
        let settings = settings_for(dir.path());
        let first = export_note_to_vault(
            &settings,
            &meta(|_| {}),
            Some(&summary()),
            &transcript(),
            UtcOffset::UTC,
        )
        .unwrap();
        let ExportOutcome::Written(path) = first else {
            panic!("the first export should write a file, got {first:?}");
        };

        // The note was renamed since (so a fresh export would pick a new
        // filename) — the earlier file still wins, untouched.
        let renamed = meta(|m| m.title = "Acme kickoff".to_string());
        let second = export_note_to_vault(
            &settings,
            &renamed,
            Some(&summary()),
            &transcript(),
            UtcOffset::UTC,
        )
        .unwrap();

        assert_eq!(second, ExportOutcome::AlreadyExported(path.clone()));
        assert_eq!(fs::read_dir(dir.path().join("Meetings")).unwrap().count(), 1);
        assert!(fs::read_to_string(&path)
            .unwrap()
            .contains("\n# Client call — Acme\n"));
    }

    #[cfg(unix)]
    #[test]
    fn export_note_to_vault_explains_an_unwritable_folder() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempdir().unwrap();
        let folder = dir.path().join("Meetings");
        fs::create_dir_all(&folder).unwrap();
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o555)).unwrap();
        let settings = settings_for(dir.path());

        let result = export_note_to_vault(
            &settings,
            &meta(|_| {}),
            None,
            &Transcript::default(),
            UtcOffset::UTC,
        );

        // Restore first so the tempdir can clean itself up whatever happens.
        fs::set_permissions(&folder, fs::Permissions::from_mode(0o755)).unwrap();
        let err = result.unwrap_err().to_string();
        assert!(err.contains("isn't allowed to write"), "{err}");
        assert!(err.contains("Settings → Obsidian"), "{err}");
    }

    // --- vault status -------------------------------------------------------

    #[test]
    fn vault_status_reports_what_it_sees_without_judging() {
        let dir = tempdir().unwrap();
        let vault = dir.path().join("Vault");
        fs::create_dir_all(vault.join(".obsidian")).unwrap();
        let plain = dir.path().join("Plain");
        fs::create_dir_all(&plain).unwrap();
        let file = dir.path().join("file.md");
        fs::write(&file, "x").unwrap();

        assert_eq!(
            vault_status(&vault.to_string_lossy()),
            VaultStatus {
                exists: true,
                is_directory: true,
                looks_like_vault: true
            }
        );
        assert_eq!(
            vault_status(&plain.to_string_lossy()),
            VaultStatus {
                exists: true,
                is_directory: true,
                looks_like_vault: false
            }
        );
        assert_eq!(
            vault_status(&file.to_string_lossy()),
            VaultStatus {
                exists: true,
                is_directory: false,
                looks_like_vault: false
            }
        );
        assert_eq!(
            vault_status(&dir.path().join("nope").to_string_lossy()),
            VaultStatus {
                exists: false,
                is_directory: false,
                looks_like_vault: false
            }
        );
        assert_eq!(
            vault_status(""),
            VaultStatus {
                exists: false,
                is_directory: false,
                looks_like_vault: false
            }
        );
    }
}
