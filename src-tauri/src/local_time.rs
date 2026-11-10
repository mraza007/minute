//! The system time zone, for the calendar day a note shows.

use time::{OffsetDateTime, UtcOffset};

/// The UTC offset in force at an instant, or `None` when it is not known.
pub type OffsetAt = fn(OffsetDateTime) -> Option<UtcOffset>;

/// The system time zone's offset at `at`, daylight time included. This is
/// the zone the app's own date labels use.
///
/// It asks Foundation because `time`'s local-offset lookup refuses to run in
/// a process with more than one thread on Unix, so it would fail here every
/// time.
#[cfg(target_os = "macos")]
pub fn system_offset_at(at: OffsetDateTime) -> Option<UtcOffset> {
    use objc2_foundation::{NSDate, NSTimeZone};
    objc2::rc::autoreleasepool(|_| {
        let date = NSDate::dateWithTimeIntervalSince1970(at.unix_timestamp() as f64);
        let seconds = NSTimeZone::localTimeZone().secondsFromGMTForDate(&date);
        UtcOffset::from_whole_seconds(i32::try_from(seconds).ok()?).ok()
    })
}

#[cfg(not(target_os = "macos"))]
pub fn system_offset_at(_at: OffsetDateTime) -> Option<UtcOffset> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn the_system_offset_is_known_in_a_process_with_many_threads() {
        let others: Vec<_> = (0..4)
            .map(|_| std::thread::spawn(|| system_offset_at(OffsetDateTime::now_utc())))
            .collect();
        for other in others {
            assert!(other.join().unwrap().is_some());
        }
    }
}
