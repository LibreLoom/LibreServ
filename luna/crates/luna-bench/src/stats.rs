//! Summary statistics over timing samples.

use serde_json::{Value, json};

/// Nearest-rank percentile of `sorted` (ascending). `p` is 0–100.
pub fn percentile(sorted: &[f64], p: f64) -> Option<f64> {
    if sorted.is_empty() {
        return None;
    }
    let rank = ((p / 100.0) * sorted.len() as f64).ceil() as usize;
    Some(sorted[rank.clamp(1, sorted.len()) - 1])
}

fn round1(v: f64) -> f64 {
    (v * 10.0).round() / 10.0
}

/// `{n, p50, p95, min, max, mean}` for `samples`, rounded to 0.1.
pub fn summary(samples: &[f64]) -> Value {
    let mut sorted = samples.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mean = if sorted.is_empty() {
        None
    } else {
        Some(round1(sorted.iter().sum::<f64>() / sorted.len() as f64))
    };
    json!({
        "n": sorted.len(),
        "p50": percentile(&sorted, 50.0).map(round1),
        "p95": percentile(&sorted, 95.0).map(round1),
        "min": sorted.first().copied().map(round1),
        "max": sorted.last().copied().map(round1),
        "mean": mean,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_rank() {
        let s: Vec<f64> = (1..=20).map(f64::from).collect();
        assert_eq!(percentile(&s, 50.0), Some(10.0));
        assert_eq!(percentile(&s, 95.0), Some(19.0));
        assert_eq!(percentile(&[5.0], 95.0), Some(5.0));
        assert_eq!(percentile(&[], 50.0), None);
    }
}
