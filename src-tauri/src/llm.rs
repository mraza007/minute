//! On-device summarization engine (llama-cpp-2, Metal-accelerated on Apple
//! Silicon).
//!
//! Stage 3 Task 1 only proves the integration end to end: the `llama-cpp-2`
//! dependency compiles with Metal support, a real Qwen3.5-4B GGUF (fetched
//! via the existing `catalog`/`download` machinery from Stage 2) loads
//! through it, and a trivial chat-templated generation produces real output
//! — see [`tests::real_llm_loads_and_generates`], run manually. The actual
//! lazily-loaded, settings-keyed engine (prompt building, JSON extraction,
//! reload-on-model-change, the `summarize_note` worker) is built out in
//! Tasks 3-4 per `docs/plans/2026-07-23-stage3-summaries.md`; `LlmEngine`
//! here is a placeholder shape only, wired into `lib.rs` so later tasks have
//! a module to grow instead of introducing one from scratch mid-stage.

/// Placeholder for the lazily-loaded llama-cpp-2 engine. Real state (the
/// currently-loaded model id, its `LlamaModel`/`LlamaContext`, and
/// reload-when-the-id-changes logic — see the plan's Task 4) lands later;
/// this exists now purely so `lib.rs` can wire `mod llm;` and later tasks
/// have a concrete type to extend rather than introduce fresh.
#[allow(dead_code)]
pub(crate) struct LlmEngine;

impl LlmEngine {
    /// Placeholder constructor — no model is loaded yet. Real construction
    /// (managed Tauri state, mutex-guarded like `SharedStore`/
    /// `SharedRecorderState`) arrives with Task 4.
    #[allow(dead_code)]
    pub(crate) fn new() -> Self {
        Self
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn llm_engine_placeholder_constructs() {
        let _engine = LlmEngine::new();
    }

    // --- e2e: real model, real generation (manual only) ----------------------
    //
    // Everything below is Task 1's model-support proof, not the module's
    // eventual pure/tested core (there isn't one yet — see the module docs).
    // It exercises llama-cpp-2's raw API directly: load a GGUF, apply the
    // model's own chat template, decode the prompt, then greedily sample a
    // few tokens. `LlmEngine` itself isn't involved because it doesn't do
    // anything yet.

    use std::num::NonZeroU32;
    use std::path::PathBuf;
    use std::time::Instant;

    use llama_cpp_2::context::params::LlamaContextParams;
    use llama_cpp_2::llama_backend::LlamaBackend;
    use llama_cpp_2::llama_batch::LlamaBatch;
    use llama_cpp_2::model::params::LlamaModelParams;
    use llama_cpp_2::model::{AddBos, LlamaChatMessage, LlamaModel};
    use llama_cpp_2::sampling::LlamaSampler;

    /// Requires the real `qwen3.5-4b` GGUF to already be installed (fetched
    /// by `download::real_download_of_qwen3_5_4b_verifies_checksum_and_marks_installed`)
    /// at the real app-data models directory. Run manually:
    ///
    /// ```sh
    /// cargo test --manifest-path src-tauri/Cargo.toml \
    ///     real_llm_loads_and_generates -- --ignored --nocapture
    /// ```
    ///
    /// This is Task 1's model-support risk check (see the plan's
    /// "Model-support risk" note): if `LlamaModel::load_from_file` rejects
    /// the Qwen3.5 GGUF architecture, that's the vendored llama.cpp inside
    /// the pinned `llama-cpp-2` version being too old — the assertion
    /// message below is written to surface that clearly rather than as a
    /// generic panic.
    #[test]
    #[ignore]
    fn real_llm_loads_and_generates() {
        let home = std::env::var("HOME").expect("HOME must be set");
        let model_path = PathBuf::from(&home).join(
            "Library/Application Support/dev.minute.app/models/llm/Qwen3.5-4B-Q4_K_M.gguf",
        );
        assert!(
            model_path.exists(),
            "expected qwen3.5-4b model at {model_path:?} (run \
             real_download_of_qwen3_5_4b_verifies_checksum_and_marks_installed in \
             download.rs first)"
        );

        let backend = LlamaBackend::init().expect("failed to init llama backend");
        eprintln!(
            "backend built with GPU offload support: {}",
            backend.supports_gpu_offload()
        );

        // Offload every layer we can to Metal — llama.cpp clamps this to the
        // model's actual layer count, so an oversized value is the normal
        // "offload everything" idiom rather than something needing the
        // exact layer count up front.
        let model_params = LlamaModelParams::default().with_n_gpu_layers(1_000_000);

        let load_start = Instant::now();
        let model = LlamaModel::load_from_file(&backend, &model_path, &model_params)
            .expect(
                "failed to load Qwen3.5-4B GGUF — if this rejects the model architecture, the \
                 vendored llama.cpp inside this llama-cpp-2 version is too old for Qwen3.5; see \
                 the plan's model-support risk contingency before swapping anything",
            );
        let load_elapsed = load_start.elapsed();
        eprintln!("model load took {load_elapsed:?}");

        let ctx_params = LlamaContextParams::default().with_n_ctx(NonZeroU32::new(4096));
        let mut ctx = model
            .new_context(&backend, ctx_params)
            .expect("failed to create llama context");

        let tmpl = model
            .chat_template(None)
            .expect("model has no baked-in chat template");
        let messages = vec![LlamaChatMessage::new(
            "user".to_string(),
            "Say OK and nothing else.".to_string(),
        )
        .expect("chat message construction should not fail on plain ASCII")];
        let prompt = model
            .apply_chat_template(&tmpl, &messages, true)
            .expect("chat template application failed");
        eprintln!("prompt: {prompt:?}");

        let prompt_tokens = model
            .str_to_token(&prompt, AddBos::Always)
            .expect("tokenization failed");
        assert!(!prompt_tokens.is_empty(), "tokenized prompt was empty");

        let mut batch = LlamaBatch::new(prompt_tokens.len().max(512), 1);
        let last_index = prompt_tokens.len() - 1;
        for (i, token) in prompt_tokens.iter().enumerate() {
            batch
                .add(*token, i as i32, &[0], i == last_index)
                .expect("failed to add prompt token to batch");
        }
        ctx.decode(&mut batch).expect("prompt decode failed");

        let mut sampler = LlamaSampler::chain_simple([LlamaSampler::greedy()]);
        let mut output_bytes: Vec<u8> = Vec::new();
        let max_new_tokens = 16;
        let mut n_cur = batch.n_tokens();

        let gen_start = Instant::now();
        let mut generated = 0usize;
        loop {
            let token = sampler.sample(&ctx, batch.n_tokens() - 1);
            sampler.accept(token);
            if model.is_eog_token(token) {
                break;
            }

            let piece = model
                .token_to_piece_bytes(token, 64, false, None)
                .expect("failed to decode generated token to bytes");
            output_bytes.extend_from_slice(&piece);

            generated += 1;
            if generated >= max_new_tokens {
                break;
            }

            batch.clear();
            batch
                .add(token, n_cur, &[0], true)
                .expect("failed to add generated token to batch");
            n_cur += 1;
            ctx.decode(&mut batch).expect("generation decode failed");
        }
        let gen_elapsed = gen_start.elapsed();
        let tokens_per_sec = generated as f64 / gen_elapsed.as_secs_f64();

        let output = String::from_utf8_lossy(&output_bytes).to_string();
        eprintln!(
            "generated {generated} tokens in {gen_elapsed:?} ({tokens_per_sec:.2} tok/s)"
        );
        eprintln!("output: {output:?}");

        assert!(!output.trim().is_empty(), "generated output was empty");
    }
}
