//! Capture frame health classification for fail-closed control decisions.
//!
//! Control input may only proceed when a target-window frame is health-verified.
//! Black, near-uniform, size-mismatch, and stale/repeated frames stay blocked.

use crate::platform::{CaptureProvider, CaptureReliability, CapturedFrame, RgbFrame};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureHealthIssue {
    EmptyFrame,
    BlackFrame,
    UniformFrame,
    SizeMismatch,
    StaleFrame,
}

impl CaptureHealthIssue {
    #[allow(dead_code)]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::EmptyFrame => "empty_frame",
            Self::BlackFrame => "black_frame",
            Self::UniformFrame => "uniform_frame",
            Self::SizeMismatch => "size_mismatch",
            Self::StaleFrame => "stale_frame",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CaptureHealthReport {
    pub reliability: CaptureReliability,
    pub issue: Option<CaptureHealthIssue>,
    pub mean_luma: u8,
    pub dynamic_range: u8,
    pub black_ratio_bps: u16,
}

#[derive(Debug, Clone)]
pub struct FrameHealthSample {
    pub frame_hash: String,
    pub width: u32,
    pub height: u32,
    pub captured_at_ms: u64,
}

const BLACK_LUMA_THRESHOLD: u8 = 8;
const BLACK_RATIO_BPS_LIMIT: u16 = 9_700;
const UNIFORM_DYNAMIC_RANGE_LIMIT: u8 = 6;
const STALE_REPEAT_WINDOW_MS: u64 = 15_000;

pub fn analyze_rgb_frame(frame: &RgbFrame) -> CaptureHealthReport {
    if frame.width == 0 || frame.height == 0 || frame.pixels.is_empty() {
        return CaptureHealthReport {
            reliability: CaptureReliability::TargetWindowUnverified,
            issue: Some(CaptureHealthIssue::EmptyFrame),
            mean_luma: 0,
            dynamic_range: 0,
            black_ratio_bps: 10_000,
        };
    }

    let expected = (frame.width as usize)
        .saturating_mul(frame.height as usize)
        .saturating_mul(3);
    if frame.pixels.len() < expected {
        return CaptureHealthReport {
            reliability: CaptureReliability::TargetWindowUnverified,
            issue: Some(CaptureHealthIssue::EmptyFrame),
            mean_luma: 0,
            dynamic_range: 0,
            black_ratio_bps: 10_000,
        };
    }

    let mut sum: u64 = 0;
    let mut min_luma: u8 = 255;
    let mut max_luma: u8 = 0;
    let mut black_pixels: u64 = 0;
    let sample_count = (frame.width as u64).saturating_mul(frame.height as u64).max(1);

    for pixel in frame.pixels.chunks_exact(3) {
        let luma = ((u16::from(pixel[0]) * 30) + (u16::from(pixel[1]) * 59) + (u16::from(pixel[2]) * 11)) / 100;
        let luma = luma.min(255) as u8;
        sum += u64::from(luma);
        min_luma = min_luma.min(luma);
        max_luma = max_luma.max(luma);
        if luma <= BLACK_LUMA_THRESHOLD {
            black_pixels += 1;
        }
    }

    let mean_luma = (sum / sample_count).min(255) as u8;
    let dynamic_range = max_luma.saturating_sub(min_luma);
    let black_ratio_bps = ((black_pixels.saturating_mul(10_000)) / sample_count).min(10_000) as u16;

    if black_ratio_bps >= BLACK_RATIO_BPS_LIMIT {
        return CaptureHealthReport {
            reliability: CaptureReliability::TargetWindowUnverified,
            issue: Some(CaptureHealthIssue::BlackFrame),
            mean_luma,
            dynamic_range,
            black_ratio_bps,
        };
    }
    if dynamic_range <= UNIFORM_DYNAMIC_RANGE_LIMIT {
        return CaptureHealthReport {
            reliability: CaptureReliability::TargetWindowUnverified,
            issue: Some(CaptureHealthIssue::UniformFrame),
            mean_luma,
            dynamic_range,
            black_ratio_bps,
        };
    }

    CaptureHealthReport {
        reliability: CaptureReliability::HealthVerified,
        issue: None,
        mean_luma,
        dynamic_range,
        black_ratio_bps,
    }
}

pub fn classify_control_frame(
    frame: &RgbFrame,
    expected_width: Option<u32>,
    expected_height: Option<u32>,
    previous: Option<&FrameHealthSample>,
    current_hash: &str,
    current_captured_at_ms: u64,
) -> CaptureHealthReport {
    if let (Some(expected_width), Some(expected_height)) = (expected_width, expected_height) {
        if expected_width > 0
            && expected_height > 0
            && (frame.width != expected_width || frame.height != expected_height)
        {
            return CaptureHealthReport {
                reliability: CaptureReliability::TargetWindowUnverified,
                issue: Some(CaptureHealthIssue::SizeMismatch),
                mean_luma: 0,
                dynamic_range: 0,
                black_ratio_bps: 0,
            };
        }
    }

    let mut report = analyze_rgb_frame(frame);
    if report.issue.is_some() {
        return report;
    }

    if let Some(previous) = previous {
        let age_ms = current_captured_at_ms.saturating_sub(previous.captured_at_ms);
        if previous.frame_hash == current_hash
            && previous.width == frame.width
            && previous.height == frame.height
            && age_ms <= STALE_REPEAT_WINDOW_MS
        {
            report.reliability = CaptureReliability::TargetWindowUnverified;
            report.issue = Some(CaptureHealthIssue::StaleFrame);
        }
    }

    report
}

pub fn apply_health_to_captured_frame(
    mut captured: CapturedFrame,
    expected_width: Option<u32>,
    expected_height: Option<u32>,
    previous: Option<&FrameHealthSample>,
) -> CapturedFrame {
    if captured.metadata.provider == CaptureProvider::DesktopVisibleGdi || captured.metadata.fallback_used {
        captured.metadata.reliability = CaptureReliability::PreviewOnly;
        return captured;
    }

    let report = classify_control_frame(
        &captured.rgb,
        expected_width,
        expected_height,
        previous,
        &captured.metadata.frame_hash,
        captured.metadata.captured_at_ms,
    );
    captured.metadata.reliability = report.reliability;
    captured
}

#[allow(dead_code)]
pub fn sample_from_captured(captured: &CapturedFrame) -> FrameHealthSample {
    FrameHealthSample {
        frame_hash: captured.metadata.frame_hash.clone(),
        width: captured.metadata.width,
        height: captured.metadata.height,
        captured_at_ms: captured.metadata.captured_at_ms,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rgb_frame(width: u32, height: u32, fill: [u8; 3]) -> RgbFrame {
        let mut pixels = Vec::with_capacity((width * height * 3) as usize);
        for _ in 0..(width * height) {
            pixels.extend_from_slice(&fill);
        }
        RgbFrame {
            width,
            height,
            pixels,
        }
    }

    fn gradient_frame(width: u32, height: u32) -> RgbFrame {
        let mut pixels = Vec::with_capacity((width * height * 3) as usize);
        for y in 0..height {
            for x in 0..width {
                let value = ((x * 17 + y * 31) % 220 + 20) as u8;
                pixels.extend_from_slice(&[value, value.saturating_add(10), value.saturating_add(20)]);
            }
        }
        RgbFrame {
            width,
            height,
            pixels,
        }
    }

    #[test]
    fn black_frame_is_rejected() {
        let report = analyze_rgb_frame(&rgb_frame(8, 8, [0, 0, 0]));
        assert_eq!(report.issue, Some(CaptureHealthIssue::BlackFrame));
        assert_eq!(report.reliability, CaptureReliability::TargetWindowUnverified);
    }

    #[test]
    fn uniform_frame_is_rejected() {
        let report = analyze_rgb_frame(&rgb_frame(8, 8, [40, 40, 40]));
        assert_eq!(report.issue, Some(CaptureHealthIssue::UniformFrame));
        assert_ne!(report.reliability, CaptureReliability::HealthVerified);
    }

    #[test]
    fn gradient_frame_is_health_verified() {
        let report = analyze_rgb_frame(&gradient_frame(16, 12));
        assert_eq!(report.issue, None);
        assert_eq!(report.reliability, CaptureReliability::HealthVerified);
    }

    #[test]
    fn size_mismatch_blocks_control() {
        let frame = gradient_frame(10, 10);
        let report = classify_control_frame(&frame, Some(20), Some(10), None, "hash-a", 100);
        assert_eq!(report.issue, Some(CaptureHealthIssue::SizeMismatch));
    }

    #[test]
    fn repeated_hash_within_window_is_stale() {
        let frame = gradient_frame(12, 8);
        let previous = FrameHealthSample {
            frame_hash: "same".into(),
            width: 12,
            height: 8,
            captured_at_ms: 1_000,
        };
        let report = classify_control_frame(&frame, Some(12), Some(8), Some(&previous), "same", 2_000);
        assert_eq!(report.issue, Some(CaptureHealthIssue::StaleFrame));
        assert_eq!(report.reliability, CaptureReliability::TargetWindowUnverified);
    }

    #[test]
    fn desktop_preview_stays_preview_only() {
        let captured = CapturedFrame {
            rgb: gradient_frame(4, 4),
            metadata: crate::platform::CaptureMetadata {
                provider: CaptureProvider::DesktopVisibleGdi,
                reliability: CaptureReliability::PreviewOnly,
                captured_at_ms: 10,
                frame_hash: "fnv1a64:test".into(),
                width: 4,
                height: 4,
                fallback_used: true,
            },
        };
        let verified = apply_health_to_captured_frame(captured, None, None, None);
        assert_eq!(verified.metadata.reliability, CaptureReliability::PreviewOnly);
        assert!(!verified.metadata.permits_control_decision());
    }
}
