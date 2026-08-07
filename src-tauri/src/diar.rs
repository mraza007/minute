//! Post-transcription speaker diarization (issue #6's speaker half).
//!
//! Runs after a recording's transcript is complete, entirely locally:
//! sherpa-onnx's offline pipeline (pyannote segmentation-3.0 + 3D-Speaker
//! CAM++ multilingual embeddings, both small ONNX models from the catalog)
//! turns the note's `audio.wav` into time-stamped speaker clusters, which
//! are then voted onto the existing Whisper segments — every transcript
//! turn gets a "Speaker 1..N" label the rename/merge UI already knows how
//! to edit.
//!
//! Clustering quality: sherpa's threshold clustering over-counts on real
//! meeting audio (same voice split across acoustic conditions — spike
//! result 6–7 raw clusters on a known 2-person call). Two tuned post-passes
//! fix that, both validated against ground truth (see the diarization plan
//! doc's tuning table): an agglomerative *centroid merge* (re-embed each
//! cluster, merge most-similar pairs while cosine ≥
//! [`CENTROID_MERGE_SIMILARITY`]) and a *micro-cluster sweep* (clusters
//! with under [`MICRO_CLUSTER_SECS`] of total speech join their most
//! similar survivor unconditionally — phantom speakers are almost always
//! sub-2-second shards). With the multilingual embedder the similarity gap
//! is wide: same-voice splits measure ≥ 0.60, genuinely different speakers
//! ≤ 0.50, across English and Chinese test clips.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

use serde::Serialize;
use sherpa_onnx::{
    FastClusteringConfig, OfflineSpeakerDiarization, OfflineSpeakerDiarizationConfig,
    OfflineSpeakerSegmentationModelConfig, OfflineSpeakerSegmentationPyannoteModelConfig,
    SpeakerEmbeddingExtractor, SpeakerEmbeddingExtractorConfig,
};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::catalog;
use crate::error::{MinuteError, Result};
use crate::store::{lock_store, SharedStore, StoredSegment};

/// Catalog ids of the two models this pipeline needs (downloaded as a pair
/// by the Settings "Detect speakers" toggle).
pub const SEGMENTATION_MODEL_ID: &str = "diar-segmentation";
pub const EMBEDDING_MODEL_ID: &str = "diar-embedding";

/// Everything below 16 kHz mono is out of scope: `audio.rs` writes every
/// note's `audio.wav` at exactly this rate, and both ONNX models are 16 kHz
/// models.
const SAMPLE_RATE: u32 = 16_000;

/// sherpa's base threshold-clustering knob — deliberately on the
/// fine-grained side (more raw clusters), since the merge passes below are
/// much better at joining same-voice splits than threshold clustering is
/// at not splitting them in the first place.
const BASE_CLUSTER_THRESHOLD: f32 = 0.5;

/// Merge two clusters while their (duration-weighted) centroid embeddings
/// measure at least this cosine similarity — centered in the measured gap
/// between same-voice splits (≥ 0.60) and genuinely different speakers
/// (≤ 0.50).
const CENTROID_MERGE_SIMILARITY: f32 = 0.55;

/// At most this much speech (longest segments first) feeds each cluster's
/// centroid embedding — enough for a stable voiceprint without re-reading
/// minutes of audio per cluster.
const MAX_EMBED_SECS: f32 = 15.0;

/// Clusters with less total speech than this never survive as their own
/// speaker — they join their most similar neighbor even below the merge
/// threshold. Real speakers say more than this; sub-2-second clusters are
/// crosstalk, laughter, and notification sounds.
const MICRO_CLUSTER_SECS: f32 = 2.0;

/// One diarized span of speech: `speaker` is already renumbered by first
/// appearance (0-based; display adds 1).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct DiarSpan {
    pub start: f32,
    pub end: f32,
    pub speaker: usize,
}

// ---------------------------------------------------------------------------
// diar-status events
// ---------------------------------------------------------------------------

/// `diar-status` lifecycle — same shape as `llm::SummaryStatusState`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum DiarStatusState {
    Running,
    Done,
    Error,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DiarStatusPayload {
    pub note_id: String,
    pub state: DiarStatusState,
    pub error: Option<String>,
    /// How many distinct speakers the pass settled on — `Some` only on
    /// `done`, surfaced so the note view can offer "wrong count? re-run
    /// with N" without re-fetching the note first.
    pub speakers: Option<u32>,
}

/// Events a diarization worker emits — injectable closure for tests, wired
/// to real Tauri events via [`tauri_emit`]. Same shape as `stt::SttEvent`.
#[derive(Debug, Clone, PartialEq)]
pub enum DiarEvent {
    DiarStatus(DiarStatusPayload),
}

/// Real emit closure: serializes to the `diar-status` wire event, warning
/// (not panicking) on failure — same convention as `llm::tauri_emit`.
pub fn tauri_emit(app: AppHandle) -> impl Fn(DiarEvent) + Send + 'static {
    move |event| match event {
        DiarEvent::DiarStatus(payload) => {
            let note_id = payload.note_id.clone();
            if let Err(e) = app.emit("diar-status", payload) {
                log::warn!("failed to emit diar-status for {note_id}: {e}");
            }
        }
    }
}

// ---------------------------------------------------------------------------
// busy flag
// ---------------------------------------------------------------------------

/// One diarization at a time, app-wide — same single-atomic shape as
/// `llm::LlmBusy` (and for the same reason: the pass is CPU-heavy, and two
/// concurrent onnxruntime sessions on 8 threads each would just thrash).
pub type DiarBusy = Arc<AtomicBool>;

pub fn open_busy_flag() -> DiarBusy {
    Arc::new(AtomicBool::new(false))
}

// ---------------------------------------------------------------------------
// model resolution
// ---------------------------------------------------------------------------

/// Both diarization model paths, iff both are downloaded — the pipeline
/// needs the pair, so one installed without the other counts as "not
/// ready" (a torn state the Settings toggle's paired download can leave
/// behind if one download was cancelled).
pub fn resolve_models(models_root: &Path) -> Option<(PathBuf, PathBuf)> {
    let catalog = catalog::load_catalog().ok()?;
    let installed = |id: &str| {
        catalog
            .iter()
            .find(|e| e.id == id && e.kind == catalog::ModelKind::Diarization)
            .filter(|e| catalog::install_state(e, models_root) == catalog::InstallState::Installed)
            .map(|e| catalog::installed_path(e, models_root))
    };
    Some((
        installed(SEGMENTATION_MODEL_ID)?,
        installed(EMBEDDING_MODEL_ID)?,
    ))
}

// ---------------------------------------------------------------------------
// pure post-processing (unit-tested without models)
// ---------------------------------------------------------------------------

pub(crate) fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let dot: f32 = a.iter().zip(b).map(|(x, y)| x * y).sum();
    let na: f32 = a.iter().map(|x| x * x).sum::<f32>().sqrt();
    let nb: f32 = b.iter().map(|x| x * x).sum::<f32>().sqrt();
    dot / (na * nb).max(1e-9)
}

/// The two merge passes, as a pure function over per-cluster durations and
/// centroid embeddings: returns the raw-cluster-id → surviving-cluster-id
/// relabel map. Merging folds the absorbed cluster's embedding into the
/// survivor's centroid (duration-weighted mean), so later comparisons see
/// the combined voiceprint.
/// Returns the raw-cluster-id → surviving-cluster-id relabel map, plus the
/// surviving clusters' merged centroids (issue #22: these are what a voice
/// profile is made of — discarding them here would force a re-embedding
/// pass the moment the user names a speaker).
fn merge_clusters(
    mut durs: BTreeMap<i32, f32>,
    mut embs: BTreeMap<i32, Vec<f32>>,
) -> (BTreeMap<i32, i32>, BTreeMap<i32, Vec<f32>>) {
    let mut ids: Vec<i32> = durs.keys().copied().collect();
    let mut relabel: BTreeMap<i32, i32> = ids.iter().map(|&i| (i, i)).collect();

    let absorb = |into: i32,
                  from: i32,
                  ids: &mut Vec<i32>,
                  durs: &mut BTreeMap<i32, f32>,
                  embs: &mut BTreeMap<i32, Vec<f32>>,
                  relabel: &mut BTreeMap<i32, i32>| {
        let (da, db) = (durs[&into], durs[&from]);
        let merged: Vec<f32> = embs[&into]
            .iter()
            .zip(&embs[&from])
            .map(|(x, y)| (x * da + y * db) / (da + db))
            .collect();
        embs.insert(into, merged);
        durs.insert(into, da + db);
        embs.remove(&from);
        durs.remove(&from);
        ids.retain(|&i| i != from);
        for v in relabel.values_mut() {
            if *v == from {
                *v = into;
            }
        }
    };

    // Agglomerative centroid merge: most similar pair first, while above
    // the threshold.
    loop {
        let mut best: Option<(i32, i32, f32)> = None;
        for i in 0..ids.len() {
            for j in (i + 1)..ids.len() {
                let sim = cosine(&embs[&ids[i]], &embs[&ids[j]]);
                if best.map(|(_, _, s)| sim > s).unwrap_or(true) {
                    best = Some((ids[i], ids[j], sim));
                }
            }
        }
        match best {
            Some((a, b, sim)) if sim >= CENTROID_MERGE_SIMILARITY => {
                absorb(a, b, &mut ids, &mut durs, &mut embs, &mut relabel);
            }
            _ => break,
        }
    }

    // Micro-cluster sweep: smallest first, unconditional.
    loop {
        if ids.len() <= 1 {
            break;
        }
        let Some(&small) = ids
            .iter()
            .filter(|&&i| durs[&i] < MICRO_CLUSTER_SECS)
            .min_by(|a, b| durs[a].total_cmp(&durs[b]))
        else {
            break;
        };
        let &target = ids
            .iter()
            .filter(|&&i| i != small)
            .max_by(|a, b| {
                cosine(&embs[a], &embs[&small]).total_cmp(&cosine(&embs[b], &embs[&small]))
            })
            .expect("ids.len() > 1 guarantees a merge target");
        absorb(target, small, &mut ids, &mut durs, &mut embs, &mut relabel);
    }

    (relabel, embs)
}

/// Renumbers raw (non-contiguous) cluster ids to 0-based speaker indices in
/// order of first appearance — clustering hands back ids like `11` and in
/// no particular order, but "Speaker 1" should always be whoever talked
/// first.
/// Also returns the cluster-id → speaker-index map it assigned, so callers
/// can carry per-cluster data (the voice centroids — issue #22) over to the
/// final speaker numbering.
fn renumber_by_first_appearance(spans: &[(f32, f32, i32)]) -> (Vec<DiarSpan>, BTreeMap<i32, usize>) {
    let mut order: BTreeMap<i32, usize> = BTreeMap::new();
    let mut sorted = spans.to_vec();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0));
    let renumbered = sorted
        .iter()
        .map(|&(start, end, cluster)| {
            let next = order.len();
            let speaker = *order.entry(cluster).or_insert(next);
            DiarSpan {
                start,
                end,
                speaker,
            }
        })
        .collect();
    (renumbered, order)
}

/// Votes diarized spans onto the transcript: each segment takes the speaker
/// with the largest temporal overlap, falling back to the nearest span (by
/// midpoint distance) when a segment overlaps nothing — Whisper and
/// pyannote disagree slightly at turn boundaries, and "nearest speaker" is
/// a far better guess for a stranded segment than leaving the placeholder.
/// Returns one `"Speaker N"` label per segment (1-based), or an empty vec
/// when there are no spans to vote with.
pub fn vote_labels(segments: &[StoredSegment], spans: &[DiarSpan]) -> Vec<String> {
    if spans.is_empty() {
        return Vec::new();
    }
    segments
        .iter()
        .map(|segment| {
            let (s0, s1) = (segment.start as f32, segment.end as f32);
            let mut overlap: BTreeMap<usize, f32> = BTreeMap::new();
            for span in spans {
                let o = span.end.min(s1) - span.start.max(s0);
                if o > 0.0 {
                    *overlap.entry(span.speaker).or_insert(0.0) += o;
                }
            }
            let speaker = overlap
                .iter()
                // On an exact overlap tie, max_by keeps the *last* maximal
                // entry — BTreeMap iterates ascending, so ties go to the
                // higher index; total_cmp makes it deterministic either way.
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map(|(&speaker, _)| speaker)
                .unwrap_or_else(|| {
                    let mid = (s0 + s1) / 2.0;
                    spans
                        .iter()
                        .min_by(|a, b| {
                            let da = (mid - (a.start + a.end) / 2.0).abs();
                            let db = (mid - (b.start + b.end) / 2.0).abs();
                            da.total_cmp(&db)
                        })
                        .expect("spans checked non-empty")
                        .speaker
                });
            format!("Speaker {}", speaker + 1)
        })
        .collect()
}

// ---------------------------------------------------------------------------
// the pipeline itself
// ---------------------------------------------------------------------------

fn init_error(what: &str) -> MinuteError {
    MinuteError::Other(format!(
        "failed to initialize {what} — the speaker detection models may be corrupt; \
         re-download them from Settings"
    ))
}

/// How many onnxruntime threads each model gets — the spike measured 25x
/// realtime at 8 threads (vs 6.9x single-threaded); more shows no gain.
fn num_threads() -> i32 {
    std::thread::available_parallelism()
        .map(|n| n.get().min(8))
        .unwrap_or(4) as i32
}

/// Runs the full diarization pipeline over 16 kHz mono samples. `fixed
/// speakers = Some(n)` skips threshold clustering (and both merge passes)
/// in favor of exactly-n clustering — the "I know how many people were in
/// this meeting" re-run path, which the spike measured as essentially
/// perfect when the count is right.
/// What one diarization pass settles on: the labeled spans, plus (issue
/// #22) each final speaker's voice-embedding centroid. `centroids` is
/// empty on the fixed-speaker re-run path — that path never extracts
/// embeddings, and a profile made without them would be a guess.
pub struct DiarOutcome {
    pub spans: Vec<DiarSpan>,
    /// Final speaker index (same 0-based space as [`DiarSpan::speaker`])
    /// → merged voice embedding for that speaker.
    pub centroids: BTreeMap<usize, Vec<f32>>,
}

pub fn diarize_samples(
    segmentation_model: &Path,
    embedding_model: &Path,
    samples: &[f32],
    fixed_speakers: Option<u32>,
) -> Result<DiarOutcome> {
    let threads = num_threads();
    let config = OfflineSpeakerDiarizationConfig {
        segmentation: OfflineSpeakerSegmentationModelConfig {
            pyannote: OfflineSpeakerSegmentationPyannoteModelConfig {
                model: Some(segmentation_model.to_string_lossy().into_owned()),
            },
            num_threads: threads,
            ..Default::default()
        },
        embedding: SpeakerEmbeddingExtractorConfig {
            model: Some(embedding_model.to_string_lossy().into_owned()),
            num_threads: threads,
            ..Default::default()
        },
        clustering: FastClusteringConfig {
            num_clusters: fixed_speakers.map(|n| n as i32).unwrap_or(-1),
            threshold: BASE_CLUSTER_THRESHOLD,
            ..Default::default()
        },
        ..Default::default()
    };

    let sd = OfflineSpeakerDiarization::create(&config)
        .ok_or_else(|| init_error("speaker detection"))?;
    if sd.sample_rate() != SAMPLE_RATE as i32 {
        return Err(MinuteError::Other(format!(
            "speaker detection models expect {} Hz audio, not {} Hz",
            sd.sample_rate(),
            SAMPLE_RATE
        )));
    }

    let result = sd
        .process(samples)
        .ok_or_else(|| MinuteError::Other("speaker detection failed on this audio".to_string()))?;
    let mut raw: Vec<(f32, f32, i32)> = result
        .sort_by_start_time()
        .iter()
        .map(|s| (s.start, s.end, s.speaker))
        .collect();

    if fixed_speakers.is_none() && !raw.is_empty() {
        let extractor = SpeakerEmbeddingExtractor::create(&SpeakerEmbeddingExtractorConfig {
            model: Some(embedding_model.to_string_lossy().into_owned()),
            num_threads: threads,
            ..Default::default()
        })
        .ok_or_else(|| init_error("the voice embedding model"))?;

        let mut by_cluster: BTreeMap<i32, Vec<(f32, f32)>> = BTreeMap::new();
        for &(s, e, c) in &raw {
            by_cluster.entry(c).or_default().push((s, e));
        }
        let durs: BTreeMap<i32, f32> = by_cluster
            .iter()
            .map(|(&c, spans)| (c, spans.iter().map(|(s, e)| e - s).sum()))
            .collect();
        let mut embs: BTreeMap<i32, Vec<f32>> = BTreeMap::new();
        for (&cluster, spans) in &by_cluster {
            let mut ordered = spans.clone();
            ordered.sort_by(|a, b| (b.1 - b.0).total_cmp(&(a.1 - a.0)));
            let stream = extractor
                .create_stream()
                .ok_or_else(|| init_error("the voice embedding model"))?;
            let mut fed = 0.0f32;
            for (s, e) in ordered {
                if fed >= MAX_EMBED_SECS {
                    break;
                }
                let i0 = (s * SAMPLE_RATE as f32) as usize;
                let i1 = ((e * SAMPLE_RATE as f32) as usize).min(samples.len());
                if i1 <= i0 {
                    continue;
                }
                stream.accept_waveform(SAMPLE_RATE as i32, &samples[i0..i1]);
                fed += e - s;
            }
            stream.input_finished();
            let emb = extractor
                .compute(&stream)
                .ok_or_else(|| init_error("the voice embedding model"))?;
            embs.insert(cluster, emb);
        }

        let (relabel, merged_embs) = merge_clusters(durs, embs);
        for span in raw.iter_mut() {
            span.2 = relabel[&span.2];
        }
        let (spans, speaker_of_cluster) = renumber_by_first_appearance(&raw);
        let centroids = merged_embs
            .into_iter()
            .filter_map(|(cluster, emb)| {
                speaker_of_cluster
                    .get(&cluster)
                    .map(|&speaker| (speaker, emb))
            })
            .collect();
        return Ok(DiarOutcome { spans, centroids });
    }

    let (spans, _) = renumber_by_first_appearance(&raw);
    Ok(DiarOutcome {
        spans,
        centroids: BTreeMap::new(),
    })
}

/// Reads a note's `audio.wav` (16 kHz mono 16-bit PCM — the only format
/// `audio.rs` ever writes) into f32 samples.
fn read_note_samples(wav_path: &Path) -> Result<Vec<f32>> {
    let reader = hound::WavReader::open(wav_path)
        .map_err(|e| MinuteError::Other(format!("could not open this note's audio: {e}")))?;
    let spec = reader.spec();
    if spec.channels != 1 || spec.sample_rate != SAMPLE_RATE || spec.bits_per_sample != 16 {
        return Err(MinuteError::Other(format!(
            "unexpected audio format ({} Hz, {} channel(s), {}-bit) — speaker detection \
             needs Minute's own 16 kHz recordings",
            spec.sample_rate, spec.channels, spec.bits_per_sample
        )));
    }
    Ok(reader
        .into_samples::<i16>()
        .filter_map(|s| s.ok())
        .map(|s| s as f32 / 32768.0)
        .collect())
}

// ---------------------------------------------------------------------------
// worker + command
// ---------------------------------------------------------------------------

/// Everything one diarization run needs — same injectable-ctx shape as
/// `llm::SummarizeWorkerCtx`.
pub struct DiarWorkerCtx {
    pub note_id: String,
    pub store: SharedStore,
    pub busy: DiarBusy,
    pub segmentation_model: PathBuf,
    pub embedding_model: PathBuf,
    /// `Some(n)` = the user told us the speaker count (re-run path);
    /// `None` = automatic.
    pub fixed_speakers: Option<u32>,
    /// Settings' `speakerProfiles` toggle, read at spawn time (issue
    /// #22): when `true`, the pass matches each settled voice against
    /// saved profiles and writes name suggestions onto the note.
    pub suggest_profiles: bool,
    pub emit: Box<dyn Fn(DiarEvent) + Send + 'static>,
    /// Runs after the pass settles, success *or* error — the auto path
    /// hangs "now trigger the summary" here so a diarization failure still
    /// produces a summary (with placeholder labels) rather than a note
    /// stuck without one.
    pub on_done: Option<Box<dyn FnOnce() + Send + 'static>>,
}

/// Clears [`DiarBusy`] on drop — same RAII shape as `llm`'s `BusyGuard`.
struct BusyGuard {
    busy: DiarBusy,
}

impl Drop for BusyGuard {
    fn drop(&mut self) {
        self.busy.store(false, Ordering::SeqCst);
    }
}

/// Claims the busy flag and spawns the worker thread; `Err` (flag already
/// claimed, nothing spawned) if a pass is running.
pub fn try_spawn_diarize(ctx: DiarWorkerCtx) -> std::result::Result<(), &'static str> {
    if ctx
        .busy
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return Err("speaker detection already running");
    }
    std::thread::spawn(move || run_diarize_worker(ctx));
    Ok(())
}

fn run_diarize_worker(mut ctx: DiarWorkerCtx) {
    let _busy_guard = BusyGuard {
        busy: ctx.busy.clone(),
    };

    (ctx.emit)(DiarEvent::DiarStatus(DiarStatusPayload {
        note_id: ctx.note_id.clone(),
        state: DiarStatusState::Running,
        error: None,
        speakers: None,
    }));

    let payload = match run_diarize(&ctx) {
        Ok(speakers) => DiarStatusPayload {
            note_id: ctx.note_id.clone(),
            state: DiarStatusState::Done,
            error: None,
            speakers: Some(speakers),
        },
        Err(e) => DiarStatusPayload {
            note_id: ctx.note_id.clone(),
            state: DiarStatusState::Error,
            error: Some(e.to_string()),
            speakers: None,
        },
    };
    (ctx.emit)(DiarEvent::DiarStatus(payload));

    if let Some(on_done) = ctx.on_done.take() {
        on_done();
    }
}

/// The pass itself: audio + transcript in, relabeled transcript on disk
/// out. Returns the settled speaker count.
fn run_diarize(ctx: &DiarWorkerCtx) -> Result<u32> {
    let (wav_path, segments, audio_deleted) = {
        let store = lock_store(&ctx.store);
        let (meta, transcript) = store.get_note(&ctx.note_id)?;
        (
            store.note_dir(&ctx.note_id).join("audio.wav"),
            transcript.segments,
            meta.audio_deleted,
        )
    };
    if segments.is_empty() {
        return Err(MinuteError::Other(
            "this note has no transcript to label yet".to_string(),
        ));
    }
    if audio_deleted || !wav_path.exists() {
        return Err(MinuteError::Other(
            "this note's audio is no longer on disk, so speakers can't be detected".to_string(),
        ));
    }

    let samples = read_note_samples(&wav_path)?;
    let outcome = diarize_samples(
        &ctx.segmentation_model,
        &ctx.embedding_model,
        &samples,
        ctx.fixed_speakers,
    )?;
    let labels = vote_labels(&segments, &outcome.spans);
    if labels.is_empty() {
        return Err(MinuteError::Other(
            "no speech was detected in this note's audio".to_string(),
        ));
    }

    let speakers = outcome
        .spans
        .iter()
        .map(|s| s.speaker)
        .collect::<std::collections::HashSet<_>>()
        .len() as u32;
    // Issue #22: keyed by the same "Speaker N" labels the transcript now
    // carries, so a later rename can find the voice it names. Written
    // before the labels so a note never has labels whose voices are
    // missing; the empty fixed-speaker map skips the write and *keeps*
    // any embeddings from the original automatic pass — a re-run with a
    // hand-picked count changes the labeling, not the voices.
    if !outcome.centroids.is_empty() {
        let embeddings: BTreeMap<String, Vec<f32>> = outcome
            .centroids
            .into_iter()
            .map(|(speaker, emb)| (format!("Speaker {}", speaker + 1), emb))
            .collect();
        lock_store(&ctx.store).write_speaker_embeddings(&ctx.note_id, &embeddings)?;

        // Issue #22: match each settled voice against the saved profiles
        // and write the suggestions onto the note — the frontend renders
        // them as "Looks like Sarah?" chips next to the labels. Failures
        // here are logged, never propagated: the labels above are already
        // good, and a missed suggestion costs a convenience, not data.
        if ctx.suggest_profiles {
            if let Err(e) = suggest_speaker_names(&ctx.store, &ctx.note_id, &embeddings) {
                log::warn!(
                    "voice-profile matching failed for note {}: {e}",
                    ctx.note_id
                );
            }
        }
    }
    lock_store(&ctx.store).update_segment_speakers(&ctx.note_id, &labels)?;
    Ok(speakers)
}

/// Matches a pass's settled voices against the saved profiles and replaces
/// the note's suggestion map (issue #22).
///
/// Each label takes its best profile match above
/// `profiles::SUGGEST_THRESHOLD`; when two labels claim the *same* name
/// (one real person split across clusters, or two similar voices), only
/// the more similar label keeps it — one person cannot be two speakers in
/// one meeting, and suggesting it would make the feature feel broken. The
/// map is written even when empty: this pass owns the note's suggestions,
/// and an empty result must clear a previous pass's leftovers.
fn suggest_speaker_names(
    store: &SharedStore,
    note_id: &str,
    embeddings: &BTreeMap<String, Vec<f32>>,
) -> crate::error::Result<()> {
    let guard = lock_store(store);
    let saved = crate::profiles::load(&guard.voice_profiles_path());
    let mut best_label_for_name: BTreeMap<String, (String, f32)> = BTreeMap::new();
    if !saved.is_empty() {
        for (label, embedding) in embeddings {
            if let Some((profile, similarity)) = crate::profiles::best_match(&saved, embedding) {
                let entry = best_label_for_name
                    .entry(profile.name.clone())
                    .or_insert_with(|| (label.clone(), similarity));
                if similarity > entry.1 {
                    *entry = (label.clone(), similarity);
                }
            }
        }
    }
    let suggestions: std::collections::HashMap<String, crate::store::SpeakerSuggestion> =
        best_label_for_name
            .into_iter()
            .map(|(name, (label, similarity))| {
                (label, crate::store::SpeakerSuggestion { name, similarity })
            })
            .collect();
    guard.set_speaker_suggestions(note_id, &suggestions)?;
    Ok(())
}

/// Manual/re-run command: detect (or re-detect) speakers for one note, with
/// an optional user-supplied speaker count. Progress and results arrive via
/// `diar-status` events, same contract as `summarize_note`.
#[tauri::command]
pub fn diarize_note(
    app: AppHandle,
    store: State<SharedStore>,
    settings: State<crate::settings::SharedSettings>,
    busy: State<DiarBusy>,
    note_id: String,
    num_speakers: Option<u32>,
) -> std::result::Result<(), String> {
    if let Some(n) = num_speakers {
        if !(1..=16).contains(&n) {
            return Err("speaker count must be between 1 and 16".to_string());
        }
    }
    let models_root = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("failed to resolve app data dir: {e}"))?;
    let Some((segmentation_model, embedding_model)) = resolve_models(&models_root) else {
        return Err(
            "Download the speaker detection models first — Settings → Models → Detect speakers."
                .to_string(),
        );
    };

    let suggest_profiles = crate::settings::lock_settings(&settings).speaker_profiles;
    try_spawn_diarize(DiarWorkerCtx {
        note_id,
        store: store.inner().clone(),
        busy: busy.inner().clone(),
        segmentation_model,
        embedding_model,
        fixed_speakers: num_speakers,
        suggest_profiles,
        emit: Box::new(tauri_emit(app.clone())),
        on_done: None,
    })
    .map_err(|_| "Speaker detection is already running — try again in a moment.".to_string())
}

/// Dismisses one voice-profile name suggestion (issue #22) — the user
/// looked at "Looks like Sarah?" and said no. Returns the updated meta so
/// the frontend can swap it into its notes list without a refetch.
#[tauri::command]
pub fn dismiss_speaker_suggestion(
    store: State<SharedStore>,
    note_id: String,
    label: String,
) -> std::result::Result<crate::store::NoteMeta, String> {
    lock_store(&store)
        .clear_speaker_suggestion(&note_id, &label)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seg(speaker: &str, start: f64, end: f64) -> StoredSegment {
        StoredSegment {
            speaker: speaker.to_string(),
            start,
            end,
            text: "hello".to_string(),
        }
    }

    // --- merge_clusters -----------------------------------------------------

    fn unit(v: &[f32]) -> Vec<f32> {
        let n = v.iter().map(|x| x * x).sum::<f32>().sqrt();
        v.iter().map(|x| x / n).collect()
    }

    #[test]
    fn merge_clusters_joins_same_voice_splits_and_keeps_distinct_voices() {
        // Clusters 0 and 6 are the same voice (cosine ≈ 0.995), cluster 1 is
        // orthogonal to both — exactly the slack-call shape.
        let durs = BTreeMap::from([(0, 50.0), (1, 52.0), (6, 6.0)]);
        let embs = BTreeMap::from([
            (0, unit(&[1.0, 0.1, 0.0])),
            (1, unit(&[0.0, 0.0, 1.0])),
            (6, unit(&[1.0, 0.0, 0.0])),
        ]);
        let (relabel, _) = merge_clusters(durs, embs);
        assert_eq!(relabel[&6], relabel[&0]);
        assert_ne!(relabel[&1], relabel[&0]);
    }

    #[test]
    fn merge_clusters_sweeps_micro_clusters_into_their_nearest_neighbor() {
        // Cluster 3 has 0.5 s of speech and is dissimilar to everything
        // (below the merge threshold) — the micro sweep must still absorb
        // it, into the more similar of the two survivors.
        let durs = BTreeMap::from([(0, 50.0), (1, 52.0), (3, 0.5)]);
        let embs = BTreeMap::from([
            (0, unit(&[1.0, 0.0, 0.0])),
            (1, unit(&[0.0, 1.0, 0.0])),
            (3, unit(&[1.0, 0.0, 3.0])),
        ]);
        let (relabel, _) = merge_clusters(durs, embs);
        assert_eq!(relabel[&3], relabel[&0]);
        assert_eq!(relabel[&1], 1);
    }

    #[test]
    fn merge_clusters_never_merges_two_real_speakers() {
        // Two long clusters at cosine ≈ 0.40 (the measured similarity of
        // the slack call's two real speakers) must survive separately.
        let durs = BTreeMap::from([(0, 50.0), (1, 52.0)]);
        let embs = BTreeMap::from([(0, unit(&[1.0, 0.0])), (1, unit(&[0.4, 0.9165]))]);
        let (relabel, _) = merge_clusters(durs, embs);
        assert_ne!(relabel[&0], relabel[&1]);
    }

    #[test]
    fn merge_clusters_collapses_everything_to_one_when_all_micro() {
        let durs = BTreeMap::from([(0, 0.4), (1, 0.5)]);
        let embs = BTreeMap::from([(0, unit(&[1.0, 0.0])), (1, unit(&[0.0, 1.0]))]);
        let (relabel, _) = merge_clusters(durs, embs);
        assert_eq!(relabel[&0], relabel[&1]);
    }

    /// Issue #22: the centroid map must hold exactly the surviving
    /// clusters, with absorbed voices folded in (duration-weighted) —
    /// that merged vector is what becomes a voice profile.
    #[test]
    fn merge_clusters_returns_merged_centroids_for_survivors_only() {
        let durs = BTreeMap::from([(0, 50.0), (1, 52.0), (6, 6.0)]);
        let embs = BTreeMap::from([
            (0, unit(&[1.0, 0.1, 0.0])),
            (1, unit(&[0.0, 0.0, 1.0])),
            (6, unit(&[1.0, 0.0, 0.0])),
        ]);
        let (relabel, centroids) = merge_clusters(durs, embs.clone());

        let survivors: std::collections::HashSet<i32> = relabel.values().copied().collect();
        assert_eq!(
            centroids.keys().copied().collect::<std::collections::HashSet<i32>>(),
            survivors
        );
        // Cluster 6 was absorbed into 0 — the survivor's centroid moved,
        // so it can't still equal either input exactly, but it must stay
        // far more similar to the absorbed voice than to the distinct one.
        let merged = &centroids[&relabel[&6]];
        assert!(cosine(merged, &embs[&6]) > 0.99);
        assert!(cosine(merged, &embs[&1]) < 0.1);
    }

    // --- suggest_speaker_names (issue #22) ------------------------------------

    fn store_with_note() -> (crate::store::SharedStore, String, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let store = crate::store::open_shared(dir.path().to_path_buf());
        let note_id = lock_store(&store)
            .create_note_now("Standup", "whisper-small")
            .unwrap()
            .id;
        (store, note_id, dir)
    }

    fn save_profiles(store: &crate::store::SharedStore, named: &[(&str, &[f32])]) {
        let path = lock_store(store).voice_profiles_path();
        let mut list = Vec::new();
        for (name, embedding) in named {
            crate::profiles::upsert(
                &mut list,
                name,
                embedding,
                time::macros::datetime!(2026-08-07 12:00:00 UTC),
            );
        }
        crate::profiles::save(&path, &list).unwrap();
    }

    #[test]
    fn suggest_speaker_names_writes_matches_and_skips_strangers() {
        let (store, note_id, _dir) = store_with_note();
        save_profiles(&store, &[("Sarah", &unit(&[1.0, 0.1, 0.0]))]);

        let embeddings = BTreeMap::from([
            ("Speaker 1".to_string(), unit(&[1.0, 0.0, 0.0])),
            ("Speaker 2".to_string(), unit(&[0.0, 0.0, 1.0])),
        ]);
        suggest_speaker_names(&store, &note_id, &embeddings).unwrap();

        let (meta, _) = lock_store(&store).get_note(&note_id).unwrap();
        assert_eq!(meta.speaker_suggestions.len(), 1);
        let suggestion = &meta.speaker_suggestions["Speaker 1"];
        assert_eq!(suggestion.name, "Sarah");
        assert!(suggestion.similarity > 0.9);
    }

    #[test]
    fn suggest_speaker_names_gives_a_name_to_only_its_most_similar_voice() {
        let (store, note_id, _dir) = store_with_note();
        save_profiles(&store, &[("Sarah", &unit(&[1.0, 0.0, 0.0]))]);

        // Both labels clear the threshold for Sarah; only the closer one
        // may keep the suggestion — one person is not two speakers.
        let embeddings = BTreeMap::from([
            ("Speaker 1".to_string(), unit(&[1.0, 0.3, 0.0])),
            ("Speaker 2".to_string(), unit(&[1.0, 0.05, 0.0])),
        ]);
        suggest_speaker_names(&store, &note_id, &embeddings).unwrap();

        let (meta, _) = lock_store(&store).get_note(&note_id).unwrap();
        assert_eq!(meta.speaker_suggestions.len(), 1);
        assert_eq!(meta.speaker_suggestions["Speaker 2"].name, "Sarah");
    }

    #[test]
    fn suggest_speaker_names_with_no_matches_clears_previous_suggestions() {
        let (store, note_id, _dir) = store_with_note();
        save_profiles(&store, &[("Sarah", &unit(&[1.0, 0.0, 0.0]))]);
        let close = BTreeMap::from([("Speaker 1".to_string(), unit(&[1.0, 0.1, 0.0]))]);
        suggest_speaker_names(&store, &note_id, &close).unwrap();

        // A re-run whose voices match nothing must clear the stale map —
        // the labels it suggested for may not even exist any more.
        let strangers = BTreeMap::from([("Speaker 1".to_string(), unit(&[0.0, 0.0, 1.0]))]);
        suggest_speaker_names(&store, &note_id, &strangers).unwrap();

        let (meta, _) = lock_store(&store).get_note(&note_id).unwrap();
        assert!(meta.speaker_suggestions.is_empty());
    }

    // --- renumber_by_first_appearance ---------------------------------------

    #[test]
    fn renumber_orders_speakers_by_first_appearance_and_sorts_spans() {
        let spans = vec![(10.0, 12.0, 3), (0.0, 5.0, 11), (6.0, 9.0, 3)];
        let (renumbered, _) = renumber_by_first_appearance(&spans);
        assert_eq!(
            renumbered,
            vec![
                DiarSpan {
                    start: 0.0,
                    end: 5.0,
                    speaker: 0
                },
                DiarSpan {
                    start: 6.0,
                    end: 9.0,
                    speaker: 1
                },
                DiarSpan {
                    start: 10.0,
                    end: 12.0,
                    speaker: 1
                },
            ]
        );
    }

    // --- vote_labels --------------------------------------------------------

    #[test]
    fn vote_labels_picks_the_speaker_with_most_overlap() {
        let segments = vec![seg("Speaker 1", 0.0, 4.0), seg("Speaker 1", 4.0, 8.0)];
        let spans = vec![
            DiarSpan {
                start: 0.0,
                end: 3.5,
                speaker: 0,
            },
            DiarSpan {
                start: 3.5,
                end: 8.0,
                speaker: 1,
            },
        ];
        assert_eq!(
            vote_labels(&segments, &spans),
            vec!["Speaker 1", "Speaker 2"]
        );
    }

    #[test]
    fn vote_labels_falls_back_to_nearest_span_for_stranded_segments() {
        // Segment sits in a silence gap between two spans — nearer to the
        // second speaker's span.
        let segments = vec![seg("Speaker 1", 9.0, 10.0)];
        let spans = vec![
            DiarSpan {
                start: 0.0,
                end: 4.0,
                speaker: 0,
            },
            DiarSpan {
                start: 11.0,
                end: 15.0,
                speaker: 1,
            },
        ];
        assert_eq!(vote_labels(&segments, &spans), vec!["Speaker 2"]);
    }

    #[test]
    fn vote_labels_with_no_spans_returns_empty() {
        let segments = vec![seg("Speaker 1", 0.0, 4.0)];
        assert!(vote_labels(&segments, &[]).is_empty());
    }

    /// Real-model end-to-end check, mirroring `llm.rs`'s `#[ignore]` real
    /// tests: runs the full pipeline (hound read → sherpa → merges →
    /// renumber) against a real recording with known ground truth. Set
    /// `MINUTE_DIAR_SEG` / `MINUTE_DIAR_EMB` (the catalog's two ONNX
    /// models) and `MINUTE_DIAR_WAV` (a 16 kHz mono 16-bit WAV of a
    /// 2-person call) and run with `--ignored`.
    #[test]
    #[ignore = "needs real diarization models + a reference wav via MINUTE_DIAR_* env vars"]
    fn real_diarization_finds_two_speakers_on_the_reference_call() {
        let seg = std::env::var("MINUTE_DIAR_SEG").expect("MINUTE_DIAR_SEG");
        let emb = std::env::var("MINUTE_DIAR_EMB").expect("MINUTE_DIAR_EMB");
        let wav = std::env::var("MINUTE_DIAR_WAV").expect("MINUTE_DIAR_WAV");

        let samples = read_note_samples(Path::new(&wav)).expect("wav should read");
        let outcome = diarize_samples(Path::new(&seg), Path::new(&emb), &samples, None)
            .expect("diarization should run");
        let spans = &outcome.spans;

        assert!(!spans.is_empty());
        let speakers: std::collections::HashSet<usize> = spans.iter().map(|s| s.speaker).collect();
        assert_eq!(speakers.len(), 2, "ground truth: exactly 2 speakers");
        // First appearance renumbering: the first span is always Speaker 1.
        assert_eq!(spans[0].speaker, 0);
        // Issue #22: the automatic path must hand back one voice centroid
        // per settled speaker — these are what voice profiles are made of.
        assert_eq!(outcome.centroids.len(), 2);
    }

    #[test]
    fn vote_labels_sums_overlap_across_split_spans() {
        // Speaker 0 overlaps the segment twice (2.0 s total), speaker 1
        // once (1.5 s) — the summed overlap must win, not the single
        // longest span.
        let segments = vec![seg("Speaker 1", 0.0, 6.0)];
        let spans = vec![
            DiarSpan {
                start: 0.0,
                end: 1.0,
                speaker: 0,
            },
            DiarSpan {
                start: 1.2,
                end: 2.7,
                speaker: 1,
            },
            DiarSpan {
                start: 5.0,
                end: 6.0,
                speaker: 0,
            },
        ];
        assert_eq!(vote_labels(&segments, &spans), vec!["Speaker 1"]);
    }
}
