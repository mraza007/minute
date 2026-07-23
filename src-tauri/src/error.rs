//! Shared error type used across the recording, storage, and transcription modules.

#[derive(Debug, thiserror::Error)]
pub enum MinuteError {
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
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
