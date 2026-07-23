//! Shared error type used across the recording, storage, and transcription modules.

#[derive(Debug, thiserror::Error)]
pub enum MinuteError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    /// A caller-initiated cancellation (e.g. `cancel_download`,
    /// `pause_recording`'s stop path) — distinguished from `Other` so
    /// callers can `match` on it instead of string-comparing an error
    /// message to recover "was this cancelled?".
    #[error("cancelled")]
    Cancelled,
    #[error("{0}")]
    Other(String),
}

pub type Result<T> = std::result::Result<T, MinuteError>;

#[cfg(test)]
mod tests {
    #[test]
    fn compiles() {
        assert!(true);
    }
}
