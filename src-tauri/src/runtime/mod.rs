pub mod capture_health;
pub mod ocr_pool;
pub mod window_lane;

#[allow(unused_imports)]
pub use capture_health::{
    apply_health_to_captured_frame, analyze_rgb_frame, classify_control_frame, sample_from_captured,
    CaptureHealthIssue, CaptureHealthReport, FrameHealthSample,
};
pub use ocr_pool::{OcrJobStage, OcrPoolError, OcrWorkerPool};
pub use window_lane::{ExecutionContextInput, ExecutionControl, WindowLaneRegistry};
