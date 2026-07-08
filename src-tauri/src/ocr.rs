use crate::platform::RgbFrame;
use image::{codecs::png::PngEncoder, ColorType, ImageEncoder};
use serde::Deserialize;
use serde::Serialize;
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

pub const SHIKONG_OCR_MODEL_DIR_ENV: &str = "SHIKONG_OCR_MODEL_DIR";
pub const SHIKONG_PYTHON_ENV: &str = "SHIKONG_PYTHON";
pub const SCREENWATCH_OCR_MODEL_DIR_ENV: &str = "SCREENWATCH_OCR_MODEL_DIR";
pub const REQUIRED_NATIVE_OCR_ASSETS: [&str; 3] = ["det.onnx", "rec.onnx", "ppocrv5_dict.txt"];
pub const REFERENCE_RAPIDOCR_ASSETS: [&str; 3] = [
    "PP-OCRv6_det_small.onnx",
    "PP-OCRv6_rec_small.onnx",
    "ch_ppocr_mobile_v2.0_cls_mobile.onnx",
];
static OCR_TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrAvailability {
    pub available: bool,
    pub backend_name: String,
    pub model_profile: String,
    pub model_dir: String,
    pub required_models: Vec<OcrModelFileStatus>,
    pub reference_models: Vec<OcrModelFileStatus>,
    pub missing_models: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OcrModelFileStatus {
    pub name: String,
    pub path: String,
    pub exists: bool,
    pub bytes: Option<u64>,
}

#[derive(Debug, Clone)]
pub struct OcrTextRow {
    pub text: String,
    pub score: f32,
    pub box_rect: Option<[i32; 4]>,
}

pub trait OcrBackend {
    fn recognize(&mut self, frame: &RgbFrame) -> Result<Vec<OcrTextRow>, String>;
}

#[derive(Debug)]
pub struct UnavailableOcrBackend {
    reason: String,
}

pub fn ocr_availability() -> OcrAvailability {
    let model_dir = model_dir_from_env();
    let required_models = model_statuses(&model_dir, &REQUIRED_NATIVE_OCR_ASSETS);
    let reference_models = model_statuses(&model_dir, &REFERENCE_RAPIDOCR_ASSETS);
    let missing_models = required_models
        .iter()
        .filter(|model| !model.exists)
        .map(|model| model.name.clone())
        .collect::<Vec<_>>();
    let python_probe = probe_python_bridge();
    let native_available = missing_models.is_empty() && native_ocr_linked();
    let available = native_available || python_probe.is_ok();
    let backend_name = if native_available {
        native_backend_name().to_string()
    } else if python_probe.is_ok() {
        "rapidocr-python".to_string()
    } else {
        native_backend_name().to_string()
    };
    OcrAvailability {
        available,
        backend_name,
        model_profile: "ppocrv5-dbnet-svtr".to_string(),
        model_dir: model_dir.display().to_string(),
        required_models,
        reference_models,
        reason: if native_available {
            "OCR backend and model assets are ready.".to_string()
        } else if python_probe.is_ok() {
            format!(
                "RapidOCR Python bridge is ready via {}.",
                python_executable().display()
            )
        } else if !native_ocr_linked() {
            format!(
                "OCR backend is not linked and RapidOCR Python bridge is unavailable: {}",
                python_probe.err().unwrap_or_else(|| "unknown".to_string())
            )
        } else if !missing_models.is_empty() {
            format!(
                "OCR model assets are missing from the external model directory: {}",
                missing_models.join(", ")
            )
        } else {
            "OCR backend is unavailable.".to_string()
        },
        missing_models,
    }
}

pub fn create_ocr_backend() -> Box<dyn OcrBackend + Send> {
    let availability = ocr_availability();
    if !availability.available {
        return Box::new(UnavailableOcrBackend {
            reason: availability.reason,
        });
    }
    if native_ocr_linked() {
        if let Ok(backend) = create_native_backend(&model_dir_from_env()) {
            return backend;
        }
    }
    match RapidOcrPythonBackend::new() {
        Ok(backend) => Box::new(backend),
        Err(err) => Box::new(UnavailableOcrBackend {
            reason: format!("RapidOCR Python bridge failed to initialize: {err}"),
        }),
    }
}

impl OcrBackend for UnavailableOcrBackend {
    fn recognize(&mut self, _frame: &RgbFrame) -> Result<Vec<OcrTextRow>, String> {
        Err(self.reason.clone())
    }
}

fn model_dir_from_env() -> PathBuf {
    std::env::var_os(SHIKONG_OCR_MODEL_DIR_ENV)
        .or_else(|| std::env::var_os(SCREENWATCH_OCR_MODEL_DIR_ENV))
        .map(PathBuf::from)
        .unwrap_or_else(default_model_dir)
}

fn default_model_dir() -> PathBuf {
    if cfg!(windows) {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join("ScreenWatchOCR")
            .join("models")
            .join("rapidocr")
    } else {
        PathBuf::from("models").join("rapidocr")
    }
}

#[derive(Debug)]
struct RapidOcrPythonBackend {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<std::process::ChildStdout>,
}

#[derive(Debug, Deserialize)]
struct PythonOcrOutput {
    ok: bool,
    rows: Option<Vec<PythonOcrRow>>,
    error: Option<String>,
}

#[derive(Debug, Deserialize)]
struct PythonOcrRow {
    text: String,
    score: f32,
    #[serde(rename = "box")]
    box_rect: Option<[i32; 4]>,
}

impl RapidOcrPythonBackend {
    fn new() -> Result<Self, String> {
        let python = python_executable();
        let script = rapidocr_bridge_script();
        let mut child = Command::new(&python)
            .arg(&script)
            .arg("--serve")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|err| format!("failed to start {}: {err}", python.display()))?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "RapidOCR bridge stdin unavailable".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "RapidOCR bridge stdout unavailable".to_string())?;
        let mut backend = Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
        };
        let ready = backend.read_json_line()?;
        let parsed: serde_json::Value = serde_json::from_str(&ready)
            .map_err(|err| format!("invalid OCR ready JSON: {err}: {ready}"))?;
        if parsed.get("ok").and_then(serde_json::Value::as_bool) == Some(true) {
            Ok(backend)
        } else {
            Err(parsed
                .get("error")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("RapidOCR bridge did not become ready")
                .to_string())
        }
    }

    fn probe(python: &Path, script: &Path) -> Result<(), String> {
        let output = Command::new(python)
            .arg(script)
            .arg("--probe")
            .output()
            .map_err(|err| format!("failed to run {}: {err}", python.display()))?;
        if output.status.success() {
            Ok(())
        } else {
            Err(String::from_utf8_lossy(&output.stdout)
                .trim()
                .to_string()
                .if_empty(|| String::from_utf8_lossy(&output.stderr).trim().to_string()))
        }
    }

    fn read_json_line(&mut self) -> Result<String, String> {
        let mut line = String::new();
        loop {
            line.clear();
            let read = self
                .stdout
                .read_line(&mut line)
                .map_err(|err| format!("failed reading RapidOCR bridge stdout: {err}"))?;
            if read == 0 {
                return Err("RapidOCR bridge closed stdout".to_string());
            }
            let trimmed = line.trim();
            if trimmed.starts_with('{') {
                return Ok(trimmed.to_string());
            }
        }
    }
}

impl OcrBackend for RapidOcrPythonBackend {
    fn recognize(&mut self, frame: &RgbFrame) -> Result<Vec<OcrTextRow>, String> {
        let image_path = write_temp_png(frame)?;
        let request = serde_json::json!({ "image": image_path });
        let output = (|| {
            writeln!(self.stdin, "{request}")
                .map_err(|err| format!("failed writing RapidOCR bridge request: {err}"))?;
            self.stdin
                .flush()
                .map_err(|err| format!("failed flushing RapidOCR bridge request: {err}"))?;
            self.read_json_line()
        })();
        let _ = fs::remove_file(&image_path);
        let json_line = output?;
        let parsed: PythonOcrOutput = serde_json::from_str(&json_line)
            .map_err(|err| format!("invalid OCR JSON: {err}: {json_line}"))?;
        if !parsed.ok {
            return Err(parsed
                .error
                .unwrap_or_else(|| "RapidOCR bridge failed".to_string()));
        }
        Ok(parsed
            .rows
            .unwrap_or_default()
            .into_iter()
            .map(|row| OcrTextRow {
                text: row.text,
                score: row.score,
                box_rect: row.box_rect,
            })
            .collect())
    }
}

impl Drop for RapidOcrPythonBackend {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

trait EmptyStringExt {
    fn if_empty(self, fallback: impl FnOnce() -> String) -> String;
}

impl EmptyStringExt for String {
    fn if_empty(self, fallback: impl FnOnce() -> String) -> String {
        if self.is_empty() {
            fallback()
        } else {
            self
        }
    }
}

fn probe_python_bridge() -> Result<(), String> {
    RapidOcrPythonBackend::probe(&python_executable(), &rapidocr_bridge_script())
}

fn python_executable() -> PathBuf {
    std::env::var_os(SHIKONG_PYTHON_ENV)
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("python"))
}

fn rapidocr_bridge_script() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("scripts")
        .join("rapidocr_bridge.py")
}

fn write_temp_png(frame: &RgbFrame) -> Result<PathBuf, String> {
    let sequence = OCR_TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let path = std::env::temp_dir().join(format!(
        "mhxy-shikong-ocr-{}-{}-{}.png",
        std::process::id(),
        timestamp_ms(),
        sequence
    ));
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            &frame.pixels,
            frame.width,
            frame.height,
            ColorType::Rgb8.into(),
        )
        .map_err(|err| err.to_string())?;
    fs::write(&path, bytes).map_err(|err| err.to_string())?;
    Ok(path)
}

fn timestamp_ms() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis())
        .unwrap_or_default()
}

fn model_statuses(model_dir: &Path, names: &[&str]) -> Vec<OcrModelFileStatus> {
    names
        .iter()
        .map(|name| {
            let path = model_dir.join(name);
            let metadata = path.metadata().ok().filter(|meta| meta.is_file());
            OcrModelFileStatus {
                name: (*name).to_string(),
                path: path.display().to_string(),
                exists: metadata.is_some(),
                bytes: metadata.map(|meta| meta.len()),
            }
        })
        .collect()
}

fn native_ocr_linked() -> bool {
    false
}

fn native_backend_name() -> &'static str {
    "not-linked"
}

fn create_native_backend(_model_dir: &Path) -> Result<Box<dyn OcrBackend + Send>, String> {
    Err("native OCR backend is not linked".to_string())
}
