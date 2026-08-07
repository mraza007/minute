//! Voice profiles (issue #22): named speaker embeddings that persist
//! across recordings.
//!
//! A profile is born when the user renames a diarized "Speaker N" label
//! while Settings → `speakerProfiles` is on: the note's stored centroid
//! for that label (see `store::Store::read_speaker_embeddings`) is saved
//! under the new name. Later diarization passes compare fresh centroids
//! against these profiles ([`best_match`]) and suggest the name instead
//! of a bare number.
//!
//! Storage is one JSON file at the library root (`voice-profiles.json`),
//! next to the notes it describes — it moves with the library, and
//! deleting the library deletes the voices. Same atomic-write, tolerant-
//! read contract as `settings.rs`: a corrupt file degrades to "no
//! profiles" (logged) rather than wedging every recording that follows.

use std::fs;
use std::path::Path;

use serde::{Deserialize, Serialize};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

use crate::error::{MinuteError, Result};

pub const PROFILES_FILE: &str = "voice-profiles.json";
const PROFILES_TMP_FILE: &str = "voice-profiles.json.tmp";

/// Minimum cosine similarity between a fresh centroid and a saved profile
/// for the name to be suggested. Sits in the measured gap from `diar.rs`'s
/// tuning: same-voice splits score ≥ 0.60, genuinely different speakers
/// ≤ 0.50 — 0.55 splits the difference, and the suggestion UI (not an
/// auto-apply) absorbs the cost of a borderline false positive.
pub const SUGGEST_THRESHOLD: f32 = 0.55;

/// One named voice.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceProfile {
    pub name: String,
    /// Running duration-free average of every confirmed centroid — see
    /// [`upsert`] for the folding math.
    pub embedding: Vec<f32>,
    /// How many centroids have been folded into `embedding` — the weight
    /// the existing average carries when the next one folds in.
    pub samples: u32,
    pub created_at: String,
    pub updated_at: String,
}

/// Reads the profile list. Missing file → empty list (nobody has named a
/// speaker yet); corrupt file → empty list, logged — losing suggestions
/// must never break diarization or a rename.
pub fn load(path: &Path) -> Vec<VoiceProfile> {
    let raw = match fs::read_to_string(path) {
        Ok(raw) => raw,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            log::warn!("voice profiles unreadable at {path:?}: {e} — treating as empty");
            return Vec::new();
        }
    };
    match serde_json::from_str(&raw) {
        Ok(profiles) => profiles,
        Err(e) => {
            log::warn!("voice profiles corrupt at {path:?}: {e} — treating as empty");
            Vec::new()
        }
    }
}

/// Writes the whole profile list atomically (tmp + rename), same shape as
/// `settings::save_settings`.
pub fn save(path: &Path, profiles: &[VoiceProfile]) -> Result<()> {
    let json = serde_json::to_string_pretty(profiles)
        .map_err(|e| MinuteError::Other(format!("failed to serialize voice profiles: {e}")))?;
    let tmp = path.with_file_name(PROFILES_TMP_FILE);
    fs::write(&tmp, json)?;
    fs::rename(&tmp, path)?;
    Ok(())
}

fn now_rfc3339(now: OffsetDateTime) -> String {
    now.format(&Rfc3339)
        .unwrap_or_else(|_| now.unix_timestamp().to_string())
}

/// Saves (or refines) the profile named `name` with a fresh centroid.
///
/// An existing profile folds the new centroid into its running average,
/// weighted by how many confirmations it already holds:
/// `merged = (old * samples + fresh) / (samples + 1)` — one bad centroid
/// dilutes an established voice instead of replacing it. A new name
/// appends a fresh profile with `samples = 1`.
///
/// An embedding whose length disagrees with the stored one replaces it
/// outright (and resets `samples`) — that means the embedding model
/// changed, and averaging across model spaces is meaningless.
pub fn upsert(profiles: &mut Vec<VoiceProfile>, name: &str, embedding: &[f32], now: OffsetDateTime) {
    let stamp = now_rfc3339(now);
    if let Some(existing) = profiles.iter_mut().find(|p| p.name == name) {
        if existing.embedding.len() == embedding.len() {
            let n = existing.samples as f32;
            existing.embedding = existing
                .embedding
                .iter()
                .zip(embedding)
                .map(|(old, fresh)| (old * n + fresh) / (n + 1.0))
                .collect();
            existing.samples += 1;
        } else {
            existing.embedding = embedding.to_vec();
            existing.samples = 1;
        }
        existing.updated_at = stamp;
        return;
    }
    profiles.push(VoiceProfile {
        name: name.to_string(),
        embedding: embedding.to_vec(),
        samples: 1,
        created_at: stamp.clone(),
        updated_at: stamp,
    });
}

/// Deletes the profile named `name`. Returns whether one existed.
pub fn remove(profiles: &mut Vec<VoiceProfile>, name: &str) -> bool {
    let before = profiles.len();
    profiles.retain(|p| p.name != name);
    profiles.len() != before
}

/// The saved profile most similar to `embedding`, when that similarity
/// clears [`SUGGEST_THRESHOLD`]. Ties break toward the earlier profile.
pub fn best_match<'a>(
    profiles: &'a [VoiceProfile],
    embedding: &[f32],
) -> Option<(&'a VoiceProfile, f32)> {
    profiles
        .iter()
        .filter(|p| p.embedding.len() == embedding.len())
        .map(|p| (p, crate::diar::cosine(&p.embedding, embedding)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
        .filter(|&(_, sim)| sim >= SUGGEST_THRESHOLD)
}

#[cfg(test)]
mod tests {
    use super::*;
    use time::macros::datetime;

    fn unit(v: &[f32]) -> Vec<f32> {
        let norm = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter().map(|x| x / norm).collect()
    }

    const NOW: OffsetDateTime = datetime!(2026-08-07 12:00:00 UTC);

    #[test]
    fn upsert_creates_then_refines_with_a_weighted_average() {
        let mut profiles = Vec::new();
        upsert(&mut profiles, "Sarah", &[1.0, 0.0], NOW);
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].samples, 1);

        upsert(&mut profiles, "Sarah", &[0.0, 1.0], NOW);
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].samples, 2);
        // (1*1 + 0)/2 and (0*1 + 1)/2 — the established voice carries its
        // weight.
        assert_eq!(profiles[0].embedding, vec![0.5, 0.5]);
    }

    #[test]
    fn upsert_with_a_different_dimension_replaces_instead_of_averaging() {
        let mut profiles = Vec::new();
        upsert(&mut profiles, "Sarah", &[1.0, 0.0], NOW);
        upsert(&mut profiles, "Sarah", &[0.0, 0.0, 1.0], NOW);
        assert_eq!(profiles[0].embedding, vec![0.0, 0.0, 1.0]);
        assert_eq!(profiles[0].samples, 1);
    }

    #[test]
    fn remove_deletes_only_the_named_profile() {
        let mut profiles = Vec::new();
        upsert(&mut profiles, "Sarah", &[1.0, 0.0], NOW);
        upsert(&mut profiles, "Omar", &[0.0, 1.0], NOW);

        assert!(remove(&mut profiles, "Sarah"));
        assert_eq!(profiles.len(), 1);
        assert_eq!(profiles[0].name, "Omar");
        assert!(!remove(&mut profiles, "Sarah"));
    }

    #[test]
    fn best_match_picks_the_closest_profile_above_the_threshold() {
        let mut profiles = Vec::new();
        upsert(&mut profiles, "Sarah", &unit(&[1.0, 0.1, 0.0]), NOW);
        upsert(&mut profiles, "Omar", &unit(&[0.0, 0.0, 1.0]), NOW);

        let (matched, sim) = best_match(&profiles, &unit(&[1.0, 0.0, 0.0])).unwrap();
        assert_eq!(matched.name, "Sarah");
        assert!(sim > 0.9);
    }

    #[test]
    fn best_match_returns_none_below_the_threshold() {
        let mut profiles = Vec::new();
        upsert(&mut profiles, "Sarah", &unit(&[1.0, 0.0, 0.0]), NOW);
        // Cosine 0.40 — the measured different-speaker range.
        assert!(best_match(&profiles, &unit(&[0.4, 0.9165, 0.0])).is_none());
    }

    #[test]
    fn best_match_skips_profiles_from_a_different_embedding_space() {
        let mut profiles = Vec::new();
        upsert(&mut profiles, "Sarah", &[1.0, 0.0], NOW);
        assert!(best_match(&profiles, &[1.0, 0.0, 0.0]).is_none());
    }

    #[test]
    fn load_and_save_roundtrip_and_absence_reads_as_empty() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PROFILES_FILE);

        assert!(load(&path).is_empty());

        let mut profiles = Vec::new();
        upsert(&mut profiles, "Sarah", &[0.1, 0.2], NOW);
        save(&path, &profiles).unwrap();
        assert_eq!(load(&path), profiles);
    }

    #[test]
    fn corrupt_profiles_file_reads_as_empty_not_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PROFILES_FILE);
        fs::write(&path, "not json").unwrap();
        assert!(load(&path).is_empty());
    }
}
