//! Time, injectable so expiry is testable without waiting, and the journal's timestamp format.

use std::time::{SystemTime, UNIX_EPOCH};

pub trait Clock: Send + Sync {
    /// Milliseconds since the Unix epoch.
    fn now_ms(&self) -> u64;

    /// `2026-10-16T12:00:01.250Z`: what `Date.prototype.toISOString` gives, and what `c3` accepts.
    fn now_iso(&self) -> String {
        iso8601(self.now_ms())
    }
}

#[derive(Debug, Default, Clone, Copy)]
pub struct SystemClock;

impl Clock for SystemClock {
    fn now_ms(&self) -> u64 {
        SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
    }
}

/// UTC, millisecond precision, `Z` suffix (civil-from-days, Howard Hinnant's algorithm).
pub fn iso8601(ms: u64) -> String {
    let secs = (ms / 1000) as i64;
    let millis = ms % 1000;
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (hour, minute, second) = (rem / 3600, (rem % 3600) / 60, rem % 60);

    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if month <= 2 { year + 1 } else { year };

    format!("{year:04}-{month:02}-{day:02}T{hour:02}:{minute:02}:{second:02}.{millis:03}Z")
}

#[cfg(test)]
mod tests {
    use super::iso8601;

    #[test]
    fn formats_like_to_iso_string() {
        assert_eq!(iso8601(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(iso8601(1_760_616_001_250), "2025-10-16T12:00:01.250Z");
        assert_eq!(iso8601(951_782_400_000), "2000-02-29T00:00:00.000Z");
    }
}
