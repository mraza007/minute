//! Shared error type used across the recording, storage, and transcription modules.

#[derive(Debug, thiserror::Error)]
pub enum MinuteError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// A caller-initiated cancellation (currently only `cancel_download`'s
    /// in-flight download loop) — distinguished from `Other` so callers can
    /// `match` on it instead of string-comparing an error message to
    /// recover "was this cancelled?".
    #[error("cancelled")]
    Cancelled,
    /// A templated LLM prompt tokenized past the loaded model's context
    /// budget — distinguished from `Other` so `llm.rs`'s prompt-fitting
    /// loop can catch it, shrink the transcript proportionally using the
    /// carried counts, and retry. Only reaches a user if that loop gives
    /// up, so the message explains the situation in their terms.
    #[error(
        "the transcript is too long for the summary model's context \
         ({prompt_tokens} prompt tokens + {max_tokens} response budget > {context_tokens})"
    )]
    PromptTooLong {
        prompt_tokens: usize,
        max_tokens: usize,
        context_tokens: usize,
    },
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, MinuteError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn other_variant_displays_its_message() {
        let err = MinuteError::Other("boom".to_string());
        assert_eq!(err.to_string(), "boom");
    }

    #[test]
    fn io_error_converts_via_from() {
        let io_err = std::io::Error::new(std::io::ErrorKind::NotFound, "missing");
        let err: MinuteError = io_err.into();
        assert!(matches!(err, MinuteError::Io(_)));
    }
}
