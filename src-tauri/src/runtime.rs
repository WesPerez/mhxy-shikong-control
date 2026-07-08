use crate::{
    coords::{CoordinateMapper, CoordinateMode, Point, Rect},
    ocr::OcrBackend,
    platform::{
        capture_client_rgb, click_client_point, close_window_by_hwnd, drag_client_points,
        input_text_to_window, send_scancode_sequence, window_identity_by_hwnd, CaptureSource,
        RgbFrame, WindowIdentity,
    },
    vision::{crop_frame, merge_objects, rect_from_value, RecognitionHit, VisionContext},
};
use image::{codecs::png::PngEncoder, ColorType, ImageEncoder};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet, VecDeque},
    fs,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex, OnceLock,
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use walkdir::WalkDir;
#[cfg(windows)]
use windows::{
    core::PCWSTR,
    Win32::{
        Foundation::{CloseHandle, GetLastError, ERROR_ALREADY_EXISTS, HANDLE},
        System::Threading::{CreateMutexW, ReleaseMutex},
    },
};

const DEFAULT_MAX_STEPS: usize = 2_000;
const DEFAULT_CANDIDATE_TIMEOUT_MS: u64 = 20_000;
const DEFAULT_CANDIDATE_RATE_LIMIT_MS: u64 = 1_000;
const FREEZE_POLL_MS: u64 = 250;
const FREEZE_MAX_WAIT_MS: u64 = 30_000;
const FREEZE_DIFF_THRESHOLD: f32 = 2.5;

static CANCEL_FLAGS: OnceLock<Mutex<BTreeMap<String, Arc<AtomicBool>>>> = OnceLock::new();
static WINDOW_RUNS: OnceLock<Mutex<BTreeMap<isize, String>>> = OnceLock::new();
static WINDOW_RUN_SEQUENCE: AtomicU64 = AtomicU64::new(1);

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunTaskRequest {
    pub hwnd: isize,
    pub entry: String,
    #[serde(default)]
    pub task_name: Option<String>,
    #[serde(default)]
    pub dry_run: bool,
    #[serde(default)]
    pub max_steps: Option<usize>,
    #[serde(default)]
    pub coordinate_mode: CoordinateMode,
    #[serde(default)]
    pub run_id: Option<String>,
    #[serde(default)]
    pub pipeline_overrides: Option<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskRunReport {
    pub hwnd: isize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub task_name: Option<String>,
    pub entry: String,
    pub coordinate_mode: CoordinateMode,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub controller_elevated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub target_elevated: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_aspect: Option<f32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub aspect_close_to_4x3: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_evidence_capture_source: Option<CaptureSource>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub capture_sources: Vec<CaptureSource>,
    pub used_screen_region_fallback: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub initial_window_identity: Option<WindowIdentity>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub final_window_identity: Option<WindowIdentity>,
    pub dry_run: bool,
    pub completed: bool,
    pub stopped_reason: String,
    pub steps: Vec<TaskStepLog>,
    pub duration_ms: u128,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskStepLog {
    pub index: usize,
    pub node: String,
    pub status: String,
    pub recognition: Option<RecognitionHit>,
    pub action: Option<String>,
    pub queued: Vec<String>,
    pub detail: String,
}

pub fn run_task(
    request: RunTaskRequest,
    project_root: &Path,
    maa_root: &Path,
) -> Result<TaskRunReport, String> {
    let started = Instant::now();
    let window_run_guard = acquire_window_run_guard(&request)?;
    let window_identity = window_run_guard
        .as_ref()
        .and_then(|guard| guard.identity.clone());
    let initial_window_identity = window_identity.clone();
    let library =
        PipelineLibrary::load(project_root, maa_root, request.pipeline_overrides.as_ref())?;
    let cancel_registration = request
        .run_id
        .as_deref()
        .map(register_cancel_flag)
        .transpose()?;
    let cancel_flag = cancel_registration
        .as_ref()
        .map(|registration| Arc::clone(&registration.flag));
    let mut runner = TaskRunner {
        request,
        library,
        project_root: project_root.to_path_buf(),
        maa_root: maa_root.to_path_buf(),
        queue: VecDeque::new(),
        hit_counts: BTreeMap::new(),
        node_boxes: BTreeMap::new(),
        global_count: 0,
        node_success_count: 0,
        ocr_backend: None,
        cancel_flag,
        steps: Vec::new(),
        window_identity,
        capture_sources: BTreeSet::new(),
    };
    runner.queue.push_back(QueueItem::Node(NodeRef {
        name: runner.request.entry.clone(),
        parent: None,
        jump_back_parent: None,
        error_path: false,
        candidate_scan: false,
    }));
    let result = runner.run_loop();
    let task_name = runner.request.task_name.clone();
    let coordinate_mode = runner.request.coordinate_mode;
    let used_screen_region_fallback = runner
        .capture_sources
        .contains(&CaptureSource::ScreenRegionFallback);
    let final_window_identity = if runner.request.dry_run {
        None
    } else {
        window_identity_by_hwnd(runner.request.hwnd).ok()
    };
    Ok(TaskRunReport {
        hwnd: runner.request.hwnd,
        run_id: runner.request.run_id.clone(),
        task_name,
        entry: runner.request.entry,
        coordinate_mode,
        controller_elevated: None,
        target_elevated: None,
        client_width: None,
        client_height: None,
        client_aspect: None,
        aspect_close_to_4x3: None,
        client_evidence_capture_source: None,
        capture_sources: runner.capture_sources.iter().copied().collect(),
        used_screen_region_fallback,
        initial_window_identity,
        final_window_identity,
        dry_run: runner.request.dry_run,
        completed: result.completed,
        stopped_reason: result.reason,
        steps: runner.steps,
        duration_ms: started.elapsed().as_millis(),
    })
}

pub fn cancel_task(run_id: &str) -> bool {
    let Some(flags) = CANCEL_FLAGS.get() else {
        return false;
    };
    let Ok(flags) = flags.lock() else {
        return false;
    };
    let Some(flag) = flags.get(run_id) else {
        return false;
    };
    flag.store(true, Ordering::Relaxed);
    true
}

fn register_cancel_flag(run_id: &str) -> Result<CancelRegistration, String> {
    if run_id.trim().is_empty() {
        return Err("runId 不能为空".to_string());
    }
    let flag = Arc::new(AtomicBool::new(false));
    let flags = CANCEL_FLAGS.get_or_init(|| Mutex::new(BTreeMap::new()));
    let mut flags = flags
        .lock()
        .map_err(|_| "取消状态锁已损坏，无法注册任务".to_string())?;
    if flags.contains_key(run_id) {
        return Err(format!("runId 已在运行：{run_id}"));
    }
    flags.insert(run_id.to_string(), Arc::clone(&flag));
    Ok(CancelRegistration {
        run_id: run_id.to_string(),
        flag,
    })
}

fn unregister_cancel_flag(run_id: &str, flag: &Arc<AtomicBool>) {
    let Some(flags) = CANCEL_FLAGS.get() else {
        return;
    };
    if let Ok(mut flags) = flags.lock() {
        let should_remove = flags
            .get(run_id)
            .map(|registered| Arc::ptr_eq(registered, flag))
            .unwrap_or(false);
        if should_remove {
            flags.remove(run_id);
        }
    }
}

struct CancelRegistration {
    run_id: String,
    flag: Arc<AtomicBool>,
}

impl Drop for CancelRegistration {
    fn drop(&mut self) {
        unregister_cancel_flag(&self.run_id, &self.flag);
    }
}

fn acquire_window_run_guard(request: &RunTaskRequest) -> Result<Option<WindowRunGuard>, String> {
    if request.dry_run {
        return Ok(None);
    }
    let identity = initial_window_identity(request.hwnd)?;
    if identity.hwnd != request.hwnd {
        return Err(format!(
            "窗口句柄复核失败：请求 hwnd={}，实际 hwnd={}",
            request.hwnd, identity.hwnd
        ));
    }
    let process_mutex = ProcessWindowMutex::acquire(request.hwnd)?;
    let owner_prefix = request
        .run_id
        .as_deref()
        .filter(|run_id| !run_id.trim().is_empty())
        .unwrap_or(&request.entry);
    let owner = format!(
        "{owner_prefix}-{}",
        WINDOW_RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    );
    let runs = WINDOW_RUNS.get_or_init(|| Mutex::new(BTreeMap::new()));
    let mut runs = runs
        .lock()
        .map_err(|_| "窗口运行锁已损坏，无法启动任务".to_string())?;
    if let Some(active_owner) = runs.get(&request.hwnd) {
        return Err(format!(
            "窗口 {} 已有任务运行（{}），请等待结束或先停止当前任务",
            request.hwnd, active_owner
        ));
    }
    runs.insert(request.hwnd, owner.clone());
    Ok(Some(WindowRunGuard {
        hwnd: request.hwnd,
        owner,
        _process_mutex: process_mutex,
        identity: Some(identity),
    }))
}

fn initial_window_identity(hwnd: isize) -> Result<WindowIdentity, String> {
    #[cfg(test)]
    if hwnd < 0 {
        return Ok(WindowIdentity {
            hwnd,
            title: "test-window".to_string(),
            process_id: std::process::id(),
            process_name: "mhxy-shikong-control-test".to_string(),
        });
    }
    window_identity_by_hwnd(hwnd)
}

struct WindowRunGuard {
    hwnd: isize,
    owner: String,
    _process_mutex: ProcessWindowMutex,
    identity: Option<WindowIdentity>,
}

impl Drop for WindowRunGuard {
    fn drop(&mut self) {
        let Some(runs) = WINDOW_RUNS.get() else {
            return;
        };
        if let Ok(mut runs) = runs.lock() {
            let should_remove = runs
                .get(&self.hwnd)
                .map(|owner| owner == &self.owner)
                .unwrap_or(false);
            if should_remove {
                runs.remove(&self.hwnd);
            }
        }
    }
}

struct ProcessWindowMutex {
    #[cfg(windows)]
    handle: HANDLE,
}

impl ProcessWindowMutex {
    fn acquire(hwnd: isize) -> Result<Self, String> {
        acquire_process_window_mutex(hwnd)
    }
}

#[cfg(windows)]
fn acquire_process_window_mutex(hwnd: isize) -> Result<ProcessWindowMutex, String> {
    let name = format!("Local\\MHXY-ShiKong-Control-Hwnd-{hwnd}");
    let wide_name = name
        .encode_utf16()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe {
        let handle = CreateMutexW(None, true, PCWSTR(wide_name.as_ptr()))
            .map_err(|err| format!("无法创建窗口运行互斥锁 {name}: {err}"))?;
        if GetLastError() == ERROR_ALREADY_EXISTS {
            let _ = CloseHandle(handle);
            return Err(format!(
                "窗口 {hwnd} 已被另一个接管台或验收进程占用，请等待该任务结束"
            ));
        }
        Ok(ProcessWindowMutex { handle })
    }
}

#[cfg(not(windows))]
fn acquire_process_window_mutex(_hwnd: isize) -> Result<ProcessWindowMutex, String> {
    Ok(ProcessWindowMutex {})
}

#[cfg(windows)]
impl Drop for ProcessWindowMutex {
    fn drop(&mut self) {
        unsafe {
            let _ = ReleaseMutex(self.handle);
            let _ = CloseHandle(self.handle);
        }
    }
}

struct LoopResult {
    completed: bool,
    reason: String,
}

struct TaskRunner {
    request: RunTaskRequest,
    library: PipelineLibrary,
    project_root: PathBuf,
    maa_root: PathBuf,
    queue: VecDeque<QueueItem>,
    hit_counts: BTreeMap<String, usize>,
    node_boxes: BTreeMap<String, Rect>,
    global_count: usize,
    node_success_count: usize,
    ocr_backend: Option<Box<dyn OcrBackend + Send>>,
    cancel_flag: Option<Arc<AtomicBool>>,
    steps: Vec<TaskStepLog>,
    window_identity: Option<WindowIdentity>,
    capture_sources: BTreeSet<CaptureSource>,
}

#[derive(Debug, Clone)]
enum QueueItem {
    Node(NodeRef),
    CandidateGroup(CandidateGroup),
    JumpBackReturn { parent: String },
}

#[derive(Debug, Clone)]
struct NodeRef {
    name: String,
    parent: Option<String>,
    jump_back_parent: Option<String>,
    error_path: bool,
    candidate_scan: bool,
}

#[derive(Debug, Clone)]
struct CandidateGroup {
    parent: String,
    refs: Vec<NodeRef>,
    cursor: usize,
    round: usize,
    started: Instant,
    timeout_ms: u64,
    rate_limit_ms: u64,
    error_path: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NodeOutcome {
    Hit,
    Miss,
    Skipped,
    Failed,
    Missing,
}

impl NodeOutcome {
    fn should_continue_candidate_group(self) -> bool {
        matches!(self, Self::Miss | Self::Skipped | Self::Missing)
    }
}

struct ActionResult {
    detail: String,
    success: bool,
}

impl ActionResult {
    fn success(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
            success: true,
        }
    }

    fn failure(detail: impl Into<String>) -> Self {
        Self {
            detail: detail.into(),
            success: false,
        }
    }
}

impl TaskRunner {
    fn run_loop(&mut self) -> LoopResult {
        let max_steps = self.request.max_steps.unwrap_or(DEFAULT_MAX_STEPS).max(1);
        let mut index = 0usize;
        while let Some(item) = self.queue.pop_front() {
            if self.cancelled() {
                return LoopResult {
                    completed: false,
                    reason: "cancelled".to_string(),
                };
            }
            if index >= max_steps {
                return LoopResult {
                    completed: false,
                    reason: format!("reached maxSteps={max_steps}"),
                };
            }
            index += 1;
            let node_ref = match item {
                QueueItem::Node(node_ref) => node_ref,
                QueueItem::CandidateGroup(group) => {
                    self.run_candidate_group(index, group);
                    continue;
                }
                QueueItem::JumpBackReturn { parent } => {
                    self.remove_pending_siblings(&parent);
                    let Some(parent_node) = self.library.node(&parent) else {
                        self.steps.push(TaskStepLog {
                            index,
                            node: parent,
                            status: "jump-back-missing-parent".to_string(),
                            recognition: None,
                            action: None,
                            queued: self.queue_labels(),
                            detail: "jump_back parent node is missing".to_string(),
                        });
                        continue;
                    };
                    self.enqueue_next_refs(&parent, &parent_node, false);
                    self.steps.push(TaskStepLog {
                        index,
                        node: parent,
                        status: "jump-back-return".to_string(),
                        recognition: None,
                        action: None,
                        queued: self.queue_labels(),
                        detail: "returned to parent next list after jump_back branch".to_string(),
                    });
                    continue;
                }
            };
            self.run_node_ref(index, node_ref);
            if self.cancelled() {
                return LoopResult {
                    completed: false,
                    reason: "cancelled".to_string(),
                };
            }
        }
        self.queue_drained_result()
    }

    fn queue_drained_result(&self) -> LoopResult {
        if let Some(bad_step) = self.steps.iter().rev().find(|step| {
            matches!(
                step.status.as_str(),
                "action-failed"
                    | "candidate-cancelled"
                    | "candidate-empty"
                    | "candidate-timeout"
                    | "capture-error"
                    | "window-identity-mismatch"
            )
        }) {
            return LoopResult {
                completed: false,
                reason: format!(
                    "queue drained after incomplete node {} status {}",
                    bad_step.node, bad_step.status
                ),
            };
        }
        if let Some(last_step) = self
            .steps
            .iter()
            .rev()
            .find(|step| step.status != "jump-back-return")
        {
            if matches!(last_step.status.as_str(), "miss" | "missing") {
                return LoopResult {
                    completed: false,
                    reason: format!(
                        "queue drained after incomplete node {} status {}",
                        last_step.node, last_step.status
                    ),
                };
            }
        }
        LoopResult {
            completed: true,
            reason: "queue drained".to_string(),
        }
    }

    fn run_candidate_group(&mut self, index: usize, mut group: CandidateGroup) {
        if group.refs.is_empty() {
            self.steps.push(TaskStepLog {
                index,
                node: group.parent,
                status: "candidate-empty".to_string(),
                recognition: None,
                action: None,
                queued: self.queue_labels(),
                detail: "candidate group has no usable refs".to_string(),
            });
            return;
        }
        if group.started.elapsed() >= Duration::from_millis(group.timeout_ms) {
            if !group.error_path {
                if let Some(parent_node) = self.library.node(&group.parent) {
                    self.enqueue_error_refs(&group.parent, &parent_node);
                }
            }
            self.steps.push(TaskStepLog {
                index,
                node: group.parent,
                status: "candidate-timeout".to_string(),
                recognition: None,
                action: None,
                queued: self.queue_labels(),
                detail: format!(
                    "candidate list timed out after {}ms and {} round(s)",
                    group.started.elapsed().as_millis(),
                    group.round
                ),
            });
            return;
        }
        if group.cursor >= group.refs.len() {
            group.cursor = 0;
            group.round += 1;
            if let Some(reason) = self.sleep_ms(Some(group.rate_limit_ms)) {
                if self.cancelled() {
                    self.steps.push(TaskStepLog {
                        index,
                        node: group.parent.clone(),
                        status: "candidate-cancelled".to_string(),
                        recognition: None,
                        action: None,
                        queued: self.queue_labels(),
                        detail: reason,
                    });
                    return;
                }
            }
        }
        let node_ref = group.refs[group.cursor].clone();
        group.cursor += 1;
        let outcome = self.run_node_ref(index, node_ref);
        if !self.cancelled() && outcome.should_continue_candidate_group() {
            self.queue.push_front(QueueItem::CandidateGroup(group));
        }
    }

    fn run_node_ref(&mut self, index: usize, node_ref: NodeRef) -> NodeOutcome {
        let node_name = node_ref.name.clone();
        let Some(node) = self.library.node(&node_name) else {
            self.steps.push(TaskStepLog {
                index,
                node: node_name,
                status: "missing".to_string(),
                recognition: None,
                action: None,
                queued: self.queue_labels(),
                detail: "node is not present in loaded pipelines".to_string(),
            });
            return NodeOutcome::Missing;
        };
        self.run_node(index, node_ref, node)
    }

    fn run_node(&mut self, index: usize, node_ref: NodeRef, node: Value) -> NodeOutcome {
        let node_name = node_ref.name.clone();
        if node
            .get("enabled")
            .and_then(Value::as_bool)
            .is_some_and(|enabled| !enabled)
        {
            self.steps.push(TaskStepLog {
                index,
                node: node_name,
                status: "disabled".to_string(),
                recognition: None,
                action: None,
                queued: self.queue_labels(),
                detail: "node disabled by pipeline option; skipped without executing next"
                    .to_string(),
            });
            return NodeOutcome::Skipped;
        }

        if let Some(max_hit) = node.get("max_hit").and_then(Value::as_u64) {
            let count = self.hit_counts.get(&node_name).copied().unwrap_or_default();
            if count >= max_hit as usize {
                self.steps.push(TaskStepLog {
                    index,
                    node: node_name,
                    status: "max-hit".to_string(),
                    recognition: None,
                    action: None,
                    queued: self.queue_labels(),
                    detail: format!("hit count reached max_hit={max_hit}"),
                });
                return NodeOutcome::Skipped;
            }
        }

        if let Err(err) = self.verify_window_identity() {
            self.steps.push(TaskStepLog {
                index,
                node: node_name,
                status: "window-identity-mismatch".to_string(),
                recognition: None,
                action: None,
                queued: self.queue_labels(),
                detail: err,
            });
            return NodeOutcome::Failed;
        }

        let frame = match self.capture_client_frame() {
            Ok(frame) => frame,
            Err(err) => {
                self.steps.push(TaskStepLog {
                    index,
                    node: node_name,
                    status: "capture-error".to_string(),
                    recognition: None,
                    action: None,
                    queued: self.queue_labels(),
                    detail: err,
                });
                return NodeOutcome::Failed;
            }
        };
        let mapper = CoordinateMapper::new(frame.width, frame.height, self.request.coordinate_mode);
        let mut vision = VisionContext::new(
            &self.project_root,
            &self.maa_root,
            &frame,
            mapper,
            &self.node_boxes,
            self.request.hwnd,
            self.request.dry_run,
            &mut self.ocr_backend,
        );
        let recognition = vision.recognize(&node_name, &node, &self.library.nodes);
        let recognition_hit = recognition.hit;
        let follow_up = recognition.follow_up.clone();
        if let Some(rect) = recognition.rect {
            self.node_boxes.insert(node_name.clone(), rect);
        }

        if !recognition_hit {
            let repeat_freeze = if node_ref.candidate_scan {
                None
            } else {
                self.wait_freezes(node.get("repeat_wait_freezes"))
            };
            if !node_ref.candidate_scan
                && node.get("repeat_wait_freezes").is_some()
                && !self.cancelled()
            {
                self.queue.push_front(QueueItem::Node(node_ref));
            } else if !node_ref.candidate_scan {
                self.enqueue_error_refs(&node_name, &node);
            }
            self.steps.push(TaskStepLog {
                index,
                node: node_name,
                status: "miss".to_string(),
                recognition: Some(recognition),
                action: None,
                queued: self.queue_labels(),
                detail: join_details("recognition missed", &[repeat_freeze]),
            });
            return NodeOutcome::Miss;
        }

        *self.hit_counts.entry(node_name.clone()).or_default() += 1;
        let pre_freeze = self.wait_freezes(node.get("pre_wait_freezes"));
        if self.cancelled() {
            self.steps.push(TaskStepLog {
                index,
                node: node_name,
                status: "cancelled".to_string(),
                recognition: None,
                action: None,
                queued: self.queue_labels(),
                detail: "cancelled during pre_wait_freezes".to_string(),
            });
            return NodeOutcome::Failed;
        }
        let pre_delay = self.sleep_ms(node.get("pre_delay").and_then(Value::as_u64));
        if self.cancelled() {
            self.steps.push(TaskStepLog {
                index,
                node: node_name,
                status: "cancelled".to_string(),
                recognition: None,
                action: None,
                queued: self.queue_labels(),
                detail: pre_delay.unwrap_or_else(|| "cancelled during pre_delay".to_string()),
            });
            return NodeOutcome::Failed;
        }

        if let Err(err) = self.verify_window_identity() {
            self.steps.push(TaskStepLog {
                index,
                node: node_name,
                status: "window-identity-mismatch".to_string(),
                recognition: Some(recognition),
                action: None,
                queued: self.queue_labels(),
                detail: err,
            });
            return NodeOutcome::Failed;
        }

        let action = self.perform_action(&node_name, &node, mapper, recognition.rect);
        if !action.success {
            self.enqueue_error_refs(&node_name, &node);
            self.steps.push(TaskStepLog {
                index,
                node: node_name,
                status: "action-failed".to_string(),
                recognition: Some(recognition),
                action: Some(action.detail),
                queued: self.queue_labels(),
                detail: join_details("action failed", &[pre_freeze, pre_delay]),
            });
            return NodeOutcome::Failed;
        }

        let sibling_detail = (!node_ref.candidate_scan)
            .then(|| self.discard_sibling_candidates_after_hit(&node_ref))
            .flatten();
        if node_ref.jump_back_parent.is_some() && !node_ref.error_path {
            if let Some(parent) = node_ref.jump_back_parent.clone() {
                self.queue.push_front(QueueItem::JumpBackReturn { parent });
            }
        }
        self.enqueue_next_refs(&node_name, &node, node_ref.error_path);
        self.enqueue_follow_up(follow_up);
        let capture_sequence = self.post_capture_sequence(&node_name, &node);
        let post_freeze = self.wait_freezes(node.get("post_wait_freezes"));
        let delay_detail = self.sleep_ms(node.get("post_delay").and_then(Value::as_u64));
        let focus_detail = focus_detail(&node, &node_name, &recognition, &action.detail);
        self.steps.push(TaskStepLog {
            index,
            node: node_name,
            status: if self.cancelled() { "cancelled" } else { "hit" }.to_string(),
            recognition: Some(recognition),
            action: Some(action.detail),
            queued: self.queue_labels(),
            detail: join_details(
                "node executed",
                &[
                    pre_freeze,
                    pre_delay,
                    sibling_detail,
                    focus_detail,
                    capture_sequence,
                    post_freeze,
                    delay_detail,
                ],
            ),
        });
        NodeOutcome::Hit
    }

    fn verify_window_identity(&self) -> Result<(), String> {
        if self.request.dry_run {
            return Ok(());
        }
        let Some(expected) = self.window_identity.as_ref() else {
            return Ok(());
        };
        let actual = window_identity_by_hwnd(self.request.hwnd)?;
        if actual.hwnd != expected.hwnd
            || actual.process_id != expected.process_id
            || actual.title != expected.title
            || (!expected.process_name.is_empty()
                && !actual.process_name.is_empty()
                && !actual
                    .process_name
                    .eq_ignore_ascii_case(&expected.process_name))
        {
            return Err(format!(
                "窗口身份变化：expected hwnd={} pid={} process={} title={:?}; actual hwnd={} pid={} process={} title={:?}",
                expected.hwnd,
                expected.process_id,
                expected.process_name,
                expected.title,
                actual.hwnd,
                actual.process_id,
                actual.process_name,
                actual.title
            ));
        }
        Ok(())
    }

    fn perform_action(
        &mut self,
        node_name: &str,
        node: &Value,
        mapper: CoordinateMapper,
        recognition_rect: Option<Rect>,
    ) -> ActionResult {
        let Some(action) = node.get("action").and_then(Value::as_str) else {
            return ActionResult::success("none");
        };
        if self.request.dry_run {
            return ActionResult::success(format!("{action} (dry-run)"));
        }
        match action {
            "Click" => action_detail_result(self.action_click(node, mapper, recognition_rect)),
            "Swipe" => action_detail_result(self.action_swipe(node, mapper)),
            "MultiSwipe" => action_detail_result(self.action_multi_swipe(node, mapper)),
            "InputText" => action_detail_result(self.action_input_text(node)),
            "ClickKey" => action_detail_result(self.action_click_key(node)),
            "Custom" => self.action_custom(node_name, node, mapper),
            "StartApp" => ActionResult::success(
                "StartApp confirmed: task is bound to an existing ShiKong PC client hwnd",
            ),
            "StopApp" => action_detail_result(self.action_stop_app()),
            other => ActionResult::failure(format!("{other} unsupported")),
        }
    }

    fn action_click(
        &mut self,
        node: &Value,
        mapper: CoordinateMapper,
        recognition_rect: Option<Rect>,
    ) -> String {
        let target = node
            .get("target")
            .and_then(|value| rect_from_value(value, mapper))
            .or(recognition_rect);
        let Some(mut target) = target else {
            return "Click skipped: no target or recognition box".to_string();
        };
        if let Some(offset) = parse_offset(node.get("target_offset")) {
            target = apply_target_offset(target, offset, mapper);
        }
        let point = target.center();
        let repeat = node
            .get("repeat")
            .and_then(Value::as_u64)
            .unwrap_or(1)
            .max(1);
        let repeat_delay = node
            .get("repeat_delay")
            .and_then(Value::as_u64)
            .unwrap_or(80);
        for index in 0..repeat {
            if let Err(err) = click_client_point(self.request.hwnd, point.x, point.y) {
                return format!("Click failed: {err}");
            }
            if index + 1 < repeat {
                let _ = self.wait_freezes(node.get("repeat_wait_freezes"));
                thread::sleep(Duration::from_millis(repeat_delay.min(FREEZE_MAX_WAIT_MS)));
            }
        }
        format!(
            "Click {},{} x{} repeatDelay={}ms",
            point.x, point.y, repeat, repeat_delay
        )
    }

    fn action_swipe(&self, node: &Value, mapper: CoordinateMapper) -> String {
        let Some(begin) = point_from_node(node.get("begin"), mapper) else {
            return "Swipe skipped: missing begin".to_string();
        };
        let Some(end) = point_from_node(node.get("end"), mapper) else {
            return "Swipe skipped: missing end".to_string();
        };
        let duration = node.get("duration").and_then(Value::as_u64).unwrap_or(300);
        let end_hold = node.get("end_hold").and_then(Value::as_u64).unwrap_or(0);
        match drag_client_points(self.request.hwnd, begin.x, begin.y, end.x, end.y, duration) {
            Ok(()) => {
                if end_hold > 0 {
                    thread::sleep(Duration::from_millis(end_hold.min(FREEZE_MAX_WAIT_MS)));
                }
                format!(
                    "Swipe {},{} -> {},{} endHold={}ms",
                    begin.x, begin.y, end.x, end.y, end_hold
                )
            }
            Err(err) => format!("Swipe failed: {err}"),
        }
    }

    fn action_multi_swipe(&self, node: &Value, mapper: CoordinateMapper) -> String {
        let Some(swipes) = node.get("swipes").and_then(Value::as_array) else {
            return "MultiSwipe skipped: missing swipes".to_string();
        };
        let mut done = 0usize;
        for swipe in swipes {
            let starting = swipe.get("starting").and_then(Value::as_u64).unwrap_or(0);
            thread::sleep(Duration::from_millis(starting));
            let Some(begin) = point_from_node(swipe.get("begin"), mapper) else {
                continue;
            };
            let Some(end) = point_from_node(swipe.get("end"), mapper) else {
                continue;
            };
            let duration = swipe.get("duration").and_then(Value::as_u64).unwrap_or(300);
            if drag_client_points(self.request.hwnd, begin.x, begin.y, end.x, end.y, duration)
                .is_ok()
            {
                done += 1;
            }
        }
        format!("MultiSwipe executed {done}/{} swipes", swipes.len())
    }

    fn action_input_text(&self, node: &Value) -> String {
        let text = node.get("input_text").and_then(Value::as_str).unwrap_or("");
        match input_text_to_window(self.request.hwnd, text) {
            Ok(()) => format!("InputText {} chars", text.chars().count()),
            Err(err) => format!("InputText failed: {err}"),
        }
    }

    fn action_click_key(&self, node: &Value) -> String {
        let keys = node
            .get("key")
            .and_then(Value::as_array)
            .map(|items| {
                items
                    .iter()
                    .filter_map(Value::as_u64)
                    .map(|value| value as u16)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if keys.is_empty() {
            return "ClickKey skipped: missing key".to_string();
        }
        match send_scancode_sequence(self.request.hwnd, &keys) {
            Ok(()) => format!("ClickKey scancodes {:?}", keys),
            Err(err) => format!("ClickKey failed: {err}"),
        }
    }

    fn action_stop_app(&self) -> String {
        match close_window_by_hwnd(self.request.hwnd) {
            Ok(()) => "StopApp posted WM_CLOSE to bound hwnd".to_string(),
            Err(err) => format!("StopApp failed: {err}"),
        }
    }

    fn action_custom(
        &mut self,
        node_name: &str,
        node: &Value,
        mapper: CoordinateMapper,
    ) -> ActionResult {
        let hook = node
            .get("custom_action")
            .and_then(Value::as_str)
            .unwrap_or("");
        match hook {
            "count" | "countGlobal" | "countZG" => {
                ActionResult::success(self.custom_count(hook, node_name, node))
            }
            "input_node_success_num" => {
                self.node_success_count += 1;
                ActionResult::success(format!(
                    "custom input_node_success_num incremented to {}",
                    self.node_success_count
                ))
            }
            "output_node_success_num" => {
                let count = self.node_success_count;
                self.node_success_count = 0;
                ActionResult::success(format!(
                    "custom output_node_success_num counter={count}; reset node success counter"
                ))
            }
            "returnOCR" => action_detail_result(self.custom_return_ocr(node, mapper)),
            "my_action_111" => ActionResult::success("custom my_action_111 sample placeholder"),
            "" => ActionResult::failure(format!("custom action missing on {node_name}")),
            other => ActionResult::failure(format!("custom action {other} not ported")),
        }
    }

    fn custom_count(&mut self, hook: &str, node_name: &str, node: &Value) -> String {
        let Some(param) = node.get("custom_action_param") else {
            return "custom count skipped: missing custom_action_param".to_string();
        };
        let target = if hook == "countZG" {
            self.library
                .node("抓鬼轮数")
                .and_then(|node| node.get("custom_action_param").cloned())
                .and_then(|param| parse_custom_target_count(&param))
                .or_else(|| parse_custom_target_count(param))
                .unwrap_or(0)
        } else {
            parse_custom_target_count(param).unwrap_or(0)
        };
        let loop_node = param.get("LoopNode").and_then(Value::as_str).unwrap_or("");
        let next_task = param.get("nextTask").and_then(Value::as_str).unwrap_or("");
        if hook == "count" {
            let key = format!("custom-count:{}", next_task);
            let count = self.hit_counts.entry(key).or_default();
            if *count < target {
                *count += 1;
                if !loop_node.is_empty() {
                    self.queue.push_front(QueueItem::Node(NodeRef {
                        name: strip_jumpback(loop_node),
                        parent: Some(node_name.to_string()),
                        jump_back_parent: None,
                        error_path: false,
                        candidate_scan: false,
                    }));
                }
                return format!("custom count {}/{} -> loop {}", count, target, loop_node);
            }
            *count = 0;
            if !next_task.is_empty() {
                self.queue.push_front(QueueItem::Node(NodeRef {
                    name: strip_jumpback(next_task),
                    parent: Some(node_name.to_string()),
                    jump_back_parent: None,
                    error_path: false,
                    candidate_scan: false,
                }));
            }
            return format!("custom count reached {target} -> next {next_task}");
        }
        let counter = &mut self.global_count;
        if *counter < target {
            *counter += 1;
            if !loop_node.is_empty() {
                self.queue.push_front(QueueItem::Node(NodeRef {
                    name: strip_jumpback(loop_node),
                    parent: Some(node_name.to_string()),
                    jump_back_parent: None,
                    error_path: false,
                    candidate_scan: false,
                }));
            }
            format!("custom {hook} {}/{} -> loop {}", counter, target, loop_node)
        } else {
            *counter = 0;
            if !next_task.is_empty() {
                self.queue.push_front(QueueItem::Node(NodeRef {
                    name: strip_jumpback(next_task),
                    parent: Some(node_name.to_string()),
                    jump_back_parent: None,
                    error_path: false,
                    candidate_scan: false,
                }));
            }
            format!("custom {hook} reached {target} -> next {next_task}")
        }
    }

    fn custom_return_ocr(&mut self, node: &Value, mapper: CoordinateMapper) -> String {
        let Some(param) = node.get("custom_action_param") else {
            return "custom returnOCR skipped: missing custom_action_param".to_string();
        };
        let recognition_name = param
            .get("recognition_name")
            .and_then(Value::as_str)
            .unwrap_or("");
        if recognition_name.is_empty() {
            return "custom returnOCR skipped: missing recognition_name".to_string();
        }
        let frame = match self.capture_client_frame() {
            Ok(frame) => frame,
            Err(err) => return format!("custom returnOCR capture failed: {err}"),
        };
        let Some(recognition_node) = self.library.node(recognition_name) else {
            return format!("custom returnOCR recognition node missing: {recognition_name}");
        };
        let mut vision = VisionContext::new(
            &self.project_root,
            &self.maa_root,
            &frame,
            mapper,
            &self.node_boxes,
            self.request.hwnd,
            self.request.dry_run,
            &mut self.ocr_backend,
        );
        let hit = vision.recognize(recognition_name, &recognition_node, &self.library.nodes);
        if !hit.hit {
            return format!("custom returnOCR miss: {}", hit.detail);
        }
        if param.get("action_key").and_then(Value::as_str) == Some("Click") {
            let target = param
                .get("click_target")
                .and_then(|value| rect_from_value(value, mapper))
                .or(hit.rect);
            if let Some(rect) = target {
                let point = rect.center();
                if let Err(err) = click_client_point(self.request.hwnd, point.x, point.y) {
                    return format!("custom returnOCR click failed: {err}");
                }
            }
        }
        let label = param
            .get("return_text")
            .and_then(Value::as_str)
            .unwrap_or("returnOCR");
        format!("{label} {}", hit.text.unwrap_or(hit.detail))
    }

    fn enqueue_next_refs(&mut self, parent: &str, node: &Value, error_path: bool) {
        self.enqueue_refs(parent, node.get("next"), error_path);
    }

    fn enqueue_error_refs(&mut self, parent: &str, node: &Value) {
        self.enqueue_refs(parent, node.get("on_error"), true);
    }

    fn enqueue_refs(&mut self, parent: &str, value: Option<&Value>, error_path: bool) {
        let mut refs = node_refs_from_value(value, parent, error_path);
        if refs.is_empty() {
            return;
        }
        let parent_node = self.library.node(parent).unwrap_or_default();
        let timeout_ms = node_delay_ms(&parent_node, "timeout", DEFAULT_CANDIDATE_TIMEOUT_MS);
        let rate_limit_ms =
            node_delay_ms(&parent_node, "rate_limit", DEFAULT_CANDIDATE_RATE_LIMIT_MS);
        for node_ref in &mut refs {
            node_ref.candidate_scan = true;
        }
        self.queue
            .push_front(QueueItem::CandidateGroup(CandidateGroup {
                parent: parent.to_string(),
                refs,
                cursor: 0,
                round: 0,
                started: Instant::now(),
                timeout_ms,
                rate_limit_ms,
                error_path,
            }));
    }

    fn enqueue_follow_up(&mut self, mut items: Vec<String>) {
        for item in items.drain(..).rev() {
            self.queue.push_front(QueueItem::Node(NodeRef {
                name: strip_jumpback(&item),
                parent: None,
                jump_back_parent: None,
                error_path: false,
                candidate_scan: false,
            }));
        }
    }

    fn remove_pending_siblings(&mut self, parent: &str) {
        self.queue.retain(|item| match item {
            QueueItem::Node(node_ref) => node_ref.parent.as_deref() != Some(parent),
            QueueItem::CandidateGroup(group) => group.parent != parent,
            QueueItem::JumpBackReturn {
                parent: return_parent,
            } => return_parent != parent,
        });
    }

    fn queue_labels(&self) -> Vec<String> {
        self.queue
            .iter()
            .map(|item| match item {
                QueueItem::Node(node_ref) => {
                    let mut label = node_ref.name.clone();
                    if node_ref.jump_back_parent.is_some() {
                        label = format!("[JumpBack]{label}");
                    }
                    if node_ref.error_path {
                        label = format!("[Error]{label}");
                    }
                    label
                }
                QueueItem::CandidateGroup(group) => {
                    let prefix = if group.error_path {
                        "[ErrorCandidates]"
                    } else {
                        "[Candidates]"
                    };
                    format!(
                        "{prefix}{}:{}/{}@round{}",
                        group.parent,
                        group.cursor,
                        group.refs.len(),
                        group.round
                    )
                }
                QueueItem::JumpBackReturn { parent } => format!("[Return]{parent}"),
            })
            .collect()
    }

    fn discard_sibling_candidates_after_hit(&mut self, node_ref: &NodeRef) -> Option<String> {
        if node_ref.jump_back_parent.is_some() {
            return None;
        }
        let parent = node_ref.parent.as_deref()?;
        let before = self.queue.len();
        self.remove_pending_siblings(parent);
        let removed = before.saturating_sub(self.queue.len());
        (removed > 0).then(|| {
            format!("selected candidate for parent {parent}; removed {removed} pending sibling(s)")
        })
    }

    fn cancelled(&self) -> bool {
        self.cancel_flag
            .as_ref()
            .is_some_and(|flag| flag.load(Ordering::Relaxed))
    }

    fn sleep_ms(&self, value: Option<u64>) -> Option<String> {
        if self.request.dry_run {
            return value.map(|ms| format!("dry-run skipped delay {ms}ms"));
        }
        let Some(ms) = value else {
            return None;
        };
        let deadline = Instant::now() + Duration::from_millis(ms.min(FREEZE_MAX_WAIT_MS));
        while Instant::now() < deadline {
            if self.cancelled() {
                return Some("cancelled during delay".to_string());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            thread::sleep(remaining.min(Duration::from_millis(100)));
        }
        Some(format!("delay {ms}ms"))
    }

    fn wait_freezes(&mut self, value: Option<&Value>) -> Option<String> {
        let params = freeze_wait_params(value?)?;
        if self.request.dry_run {
            return Some(format!(
                "dry-run skipped wait_freezes {}ms",
                params.target_ms
            ));
        }
        let target_ms = params.target_ms.clamp(1, FREEZE_MAX_WAIT_MS);
        let max_wait = Duration::from_millis((target_ms * 6 + 2_000).min(FREEZE_MAX_WAIT_MS));
        let started = Instant::now();
        let mut stable_ms = 0u64;
        let mut previous = match self.capture_freeze_frame(params.target) {
            Ok(frame) => frame,
            Err(err) => return Some(format!("wait_freezes capture failed: {err}")),
        };
        while started.elapsed() < max_wait {
            if self.cancelled() {
                return Some("cancelled during wait_freezes".to_string());
            }
            thread::sleep(Duration::from_millis(FREEZE_POLL_MS));
            let current = match self.capture_freeze_frame(params.target) {
                Ok(frame) => frame,
                Err(err) => return Some(format!("wait_freezes capture failed: {err}")),
            };
            let diff = frame_diff_score(&previous, &current);
            if diff <= params.diff_threshold {
                stable_ms += FREEZE_POLL_MS;
                if stable_ms >= target_ms {
                    return Some(format!(
                        "wait_freezes stable {}ms diff {:.2}",
                        stable_ms, diff
                    ));
                }
            } else {
                stable_ms = 0;
            }
            previous = current;
        }
        Some(format!(
            "wait_freezes timeout after {}ms, stable {}ms",
            started.elapsed().as_millis(),
            stable_ms
        ))
    }

    fn capture_freeze_frame(
        &mut self,
        target: Option<[i32; 4]>,
    ) -> Result<RgbFrame, String> {
        let frame = self.capture_client_frame()?;
        let Some(target) = target else {
            return Ok(frame);
        };
        let mapper = CoordinateMapper::new(frame.width, frame.height, self.request.coordinate_mode);
        let rect = mapper
            .clamp_rect(mapper.rect(target))
            .ok_or_else(|| format!("wait_freezes target ROI is outside frame: {target:?}"))?;
        crop_frame(&frame, rect)
    }

    fn capture_client_frame(&mut self) -> Result<RgbFrame, String> {
        let frame = capture_client_rgb(self.request.hwnd)?;
        self.capture_sources.insert(frame.capture_source);
        if !self.request.dry_run && frame.capture_source == CaptureSource::ScreenRegionFallback {
            return Err(
                "capture used screen-region fallback; refusing real automation because the game window may be obscured or not capturable in the background"
                    .to_string(),
            );
        }
        Ok(frame)
    }

    fn post_capture_sequence(&mut self, node_name: &str, node: &Value) -> Option<String> {
        let config = node.get("post_capture_sequence")?;
        if config.as_bool() == Some(false) || config.is_null() {
            return None;
        }
        let delays = post_capture_delays_ms(config);
        if delays.is_empty() {
            return None;
        }
        let capture_dir = self
            .project_root
            .join("assets")
            .join("resource")
            .join("ShiKong")
            .join("captures")
            .join("post_action");
        if let Err(err) = fs::create_dir_all(&capture_dir) {
            return Some(format!("post_capture_sequence mkdir failed: {err}"));
        }
        let stem = format!("{}-{}", timestamp_ns(), sanitize_runtime_file_part(node_name));
        let started = Instant::now();
        let mut saved = Vec::new();
        for delay in delays {
            if self.cancelled() {
                break;
            }
            let elapsed = started.elapsed().as_millis() as u64;
            if delay > elapsed {
                thread::sleep(Duration::from_millis(delay - elapsed));
            }
            match self.capture_client_frame() {
                Ok(frame) => {
                    let path = capture_dir.join(format!("{stem}-{delay}ms.png"));
                    match save_frame_png(&frame, &path) {
                        Ok(()) => saved.push(format!("{}ms={}", delay, path.display())),
                        Err(err) => saved.push(format!("{delay}ms=save failed:{err}")),
                    }
                }
                Err(err) => saved.push(format!("{delay}ms=capture failed:{err}")),
            }
        }
        Some(format!("post_capture_sequence {}", saved.join("; ")))
    }
}

fn post_capture_delays_ms(config: &Value) -> Vec<u64> {
    let default = || vec![0, 250, 500, 1000, 1500, 2500, 3500, 5000];
    if config.as_bool() == Some(true) {
        return default();
    }
    let values = config
        .get("delays_ms")
        .or_else(|| config.get("delaysMs"))
        .and_then(Value::as_array)
        .cloned()
        .or_else(|| config.as_array().cloned());
    let Some(values) = values else {
        return default();
    };
    let mut delays = values
        .iter()
        .filter_map(Value::as_u64)
        .filter(|delay| *delay <= 10_000)
        .collect::<Vec<_>>();
    delays.sort_unstable();
    delays.dedup();
    delays
}

fn save_frame_png(frame: &RgbFrame, path: &Path) -> Result<(), String> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            &frame.pixels,
            frame.width,
            frame.height,
            ColorType::Rgb8.into(),
        )
        .map_err(|err| err.to_string())?;
    fs::write(path, bytes).map_err(|err| err.to_string())
}

fn sanitize_runtime_file_part(value: &str) -> String {
    let sanitized = value
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
                ch
            } else {
                '_'
            }
        })
        .collect::<String>();
    if sanitized.trim_matches('_').is_empty() {
        "capture".to_string()
    } else {
        sanitized
    }
}

fn timestamp_ns() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default()
}

#[derive(Debug, Clone)]
struct PipelineLibrary {
    nodes: BTreeMap<String, Value>,
    default_node: Value,
}

impl PipelineLibrary {
    fn load(
        project_root: &Path,
        maa_root: &Path,
        pipeline_overrides: Option<&Value>,
    ) -> Result<Self, String> {
        let mut nodes = BTreeMap::new();
        let default_path = maa_root
            .join("assets")
            .join("resource")
            .join("base")
            .join("default_pipeline.json");
        let default_json =
            read_json(&default_path).unwrap_or_else(|_| Value::Object(Default::default()));
        let default_node = default_json
            .get("Default")
            .cloned()
            .unwrap_or_else(|| Value::Object(Default::default()));
        for root in [
            maa_root
                .join("assets")
                .join("resource")
                .join("base")
                .join("pipeline"),
            project_root
                .join("assets")
                .join("resource")
                .join("ShiKong")
                .join("pipeline"),
        ] {
            if !root.exists() {
                continue;
            }
            for entry in WalkDir::new(root)
                .into_iter()
                .filter_map(Result::ok)
                .filter(|entry| entry.file_type().is_file())
                .filter(|entry| {
                    entry
                        .path()
                        .extension()
                        .and_then(|item| item.to_str())
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("json"))
                })
            {
                let data = read_json(entry.path())?;
                let Some(map) = data.as_object() else {
                    continue;
                };
                for (name, value) in map {
                    nodes.insert(name.clone(), value.clone());
                }
            }
        }
        if let Some(overrides) = pipeline_overrides.and_then(Value::as_object) {
            for (name, override_value) in overrides {
                let merged = nodes
                    .get(name)
                    .map(|node| merge_objects(node, override_value))
                    .unwrap_or_else(|| override_value.clone());
                nodes.insert(name.clone(), merged);
            }
        }
        Ok(Self {
            nodes,
            default_node,
        })
    }

    fn node(&self, name: &str) -> Option<Value> {
        let node = self.nodes.get(name)?;
        Some(merge_objects(&self.default_node, node))
    }
}

fn node_refs_from_value(value: Option<&Value>, parent: &str, error_path: bool) -> Vec<NodeRef> {
    match value {
        Some(Value::String(item)) => node_ref_from_str(item, parent, error_path)
            .into_iter()
            .collect(),
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(|item| match item {
                Value::String(raw) => node_ref_from_str(raw, parent, error_path),
                Value::Object(map) => map
                    .get("name")
                    .or_else(|| map.get("task"))
                    .or_else(|| map.get("node"))
                    .and_then(Value::as_str)
                    .and_then(|raw| node_ref_from_str(raw, parent, error_path)),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

fn node_ref_from_str(raw: &str, parent: &str, error_path: bool) -> Option<NodeRef> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let jump_back = trimmed.starts_with("[JumpBack]");
    let name = strip_jumpback(trimmed);
    if name.is_empty() || name == "空节点" {
        return None;
    }
    Some(NodeRef {
        name,
        parent: Some(parent.to_string()),
        jump_back_parent: (jump_back && !error_path).then(|| parent.to_string()),
        error_path,
        candidate_scan: true,
    })
}

fn point_from_node(value: Option<&Value>, mapper: CoordinateMapper) -> Option<Point> {
    let items = value?.as_array()?;
    if items.len() >= 4 {
        Some(mapper.point_from_rect([
            items[0].as_i64()? as i32,
            items[1].as_i64()? as i32,
            items[2].as_i64()? as i32,
            items[3].as_i64()? as i32,
        ]))
    } else if items.len() >= 2 {
        Some(mapper.point_from_pair([items[0].as_i64()? as i32, items[1].as_i64()? as i32]))
    } else {
        None
    }
}

fn parse_offset(value: Option<&Value>) -> Option<[i32; 4]> {
    let items = value?.as_array()?;
    if items.len() < 4 {
        return None;
    }
    Some([
        items[0].as_i64()? as i32,
        items[1].as_i64()? as i32,
        items[2].as_i64()? as i32,
        items[3].as_i64()? as i32,
    ])
}

fn apply_target_offset(rect: Rect, offset: [i32; 4], mapper: CoordinateMapper) -> Rect {
    Rect {
        x: rect.x + ((offset[0] as f32) * mapper.scale_x()).round() as i32,
        y: rect.y + ((offset[1] as f32) * mapper.scale_y()).round() as i32,
        width: (rect.width + ((offset[2] as f32) * mapper.scale_x()).round() as i32).max(1),
        height: (rect.height + ((offset[3] as f32) * mapper.scale_y()).round() as i32).max(1),
    }
}

fn action_detail_result(detail: String) -> ActionResult {
    let lowered = detail.to_ascii_lowercase();
    if lowered.contains("failed")
        || lowered.contains("skipped")
        || lowered.contains("unsupported")
        || lowered.contains("not ported")
    {
        ActionResult::failure(detail)
    } else {
        ActionResult::success(detail)
    }
}

fn parse_custom_target_count(param: &Value) -> Option<usize> {
    param
        .get("target_count")
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
        .map(|value| value as usize)
}

fn node_delay_ms(node: &Value, key: &str, default_ms: u64) -> u64 {
    node.get(key)
        .and_then(|value| value.as_u64().or_else(|| value.as_str()?.parse().ok()))
        .unwrap_or(default_ms)
        .min(FREEZE_MAX_WAIT_MS)
}

fn focus_detail(
    node: &Value,
    node_name: &str,
    recognition: &RecognitionHit,
    action: &str,
) -> Option<String> {
    let focus = node.get("focus")?.as_object()?;
    let key = if action == "none" {
        "Node.Recognition.Succeeded"
    } else {
        "Node.Action.Succeeded"
    };
    let message = focus
        .get(key)
        .or_else(|| focus.get("Node.Recognition.Succeeded"))
        .or_else(|| focus.get("Node.Action.Succeeded"))?
        .as_str()?;
    let best_result = recognition
        .text
        .as_deref()
        .filter(|text| !text.is_empty())
        .unwrap_or(&recognition.detail);
    Some(format!(
        "focus: {}",
        message
            .replace("{name}", node_name)
            .replace("{best_result}", best_result)
    ))
}

fn strip_jumpback(name: &str) -> String {
    name.strip_prefix("[JumpBack]")
        .unwrap_or(name)
        .trim()
        .to_string()
}

fn join_details(base: &str, details: &[Option<String>]) -> String {
    let mut items = vec![base.to_string()];
    items.extend(details.iter().filter_map(Clone::clone));
    items.join("; ")
}

#[derive(Debug, Clone, Copy)]
struct FreezeWaitParams {
    target_ms: u64,
    diff_threshold: f32,
    target: Option<[i32; 4]>,
}

fn freeze_wait_params(value: &Value) -> Option<FreezeWaitParams> {
    if let Some(target_ms) = value.as_u64() {
        return Some(FreezeWaitParams {
            target_ms,
            diff_threshold: FREEZE_DIFF_THRESHOLD,
            target: None,
        });
    }
    let object = value.as_object()?;
    let target_ms = object
        .get("time")
        .or_else(|| object.get("timeout"))
        .and_then(Value::as_u64)?;
    let diff_threshold = object
        .get("threshold")
        .and_then(Value::as_f64)
        .map(|threshold| {
            if threshold <= 1.0 {
                ((1.0 - threshold).max(0.0) * 255.0) as f32
            } else {
                threshold as f32
            }
        })
        .unwrap_or(FREEZE_DIFF_THRESHOLD);
    Some(FreezeWaitParams {
        target_ms,
        diff_threshold,
        target: object.get("target").and_then(roi_from_value),
    })
}

fn roi_from_value(value: &Value) -> Option<[i32; 4]> {
    let items = value.as_array()?;
    if items.len() < 4 {
        return None;
    }
    Some([
        items[0].as_i64()? as i32,
        items[1].as_i64()? as i32,
        items[2].as_i64()? as i32,
        items[3].as_i64()? as i32,
    ])
}

fn frame_diff_score(left: &crate::platform::RgbFrame, right: &crate::platform::RgbFrame) -> f32 {
    if left.width != right.width
        || left.height != right.height
        || left.pixels.len() != right.pixels.len()
    {
        return f32::MAX;
    }
    let pixel_count = (left.width as usize)
        .saturating_mul(left.height as usize)
        .max(1);
    let stride_pixels = (pixel_count / 4096).max(1);
    let stride = stride_pixels * 3;
    let mut diff = 0u64;
    let mut channels = 0u64;
    let mut index = 0usize;
    while index + 2 < left.pixels.len() {
        diff += (left.pixels[index] as i16 - right.pixels[index] as i16).unsigned_abs() as u64;
        diff +=
            (left.pixels[index + 1] as i16 - right.pixels[index + 1] as i16).unsigned_abs() as u64;
        diff +=
            (left.pixels[index + 2] as i16 - right.pixels[index + 2] as i16).unsigned_abs() as u64;
        channels += 3;
        index += stride;
    }
    if channels == 0 {
        0.0
    } else {
        diff as f32 / channels as f32
    }
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|err| format!("{}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("{}: {err}", path.display()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn parses_object_freeze_wait_params() {
        let value = json!({
            "time": 2000,
            "threshold": 0.95,
            "target": [1032, 507, 240, 161]
        });
        let params = freeze_wait_params(&value).expect("freeze params");
        assert_eq!(params.target_ms, 2000);
        assert_eq!(params.target, Some([1032, 507, 240, 161]));
        assert!((params.diff_threshold - 12.75).abs() < 0.01);
    }

    #[test]
    fn parses_numeric_freeze_wait_params() {
        let value = json!(500);
        let params = freeze_wait_params(&value).expect("freeze params");
        assert_eq!(params.target_ms, 500);
        assert_eq!(params.target, None);
        assert_eq!(params.diff_threshold, FREEZE_DIFF_THRESHOLD);
    }

    #[test]
    fn post_capture_delay_config_sorts_dedups_and_bounds_values() {
        let value = json!({
            "delays_ms": [500, 0, 250, 500, 12000]
        });

        assert_eq!(post_capture_delays_ms(&value), vec![0, 250, 500]);
        assert_eq!(
            post_capture_delays_ms(&json!(true)),
            vec![0, 250, 500, 1000, 1500, 2500, 3500, 5000]
        );
    }

    #[test]
    fn parses_custom_target_count_from_number_or_string() {
        assert_eq!(
            parse_custom_target_count(&json!({ "target_count": 7 })),
            Some(7)
        );
        assert_eq!(
            parse_custom_target_count(&json!({ "target_count": "12" })),
            Some(12)
        );
    }

    #[test]
    fn duplicate_cancel_run_id_is_rejected_until_registration_drops() {
        let run_id = unique_test_id("cancel");
        let registration = register_cancel_flag(&run_id).expect("register cancel flag");

        assert!(register_cancel_flag(&run_id).is_err());
        assert!(cancel_task(&run_id));

        drop(registration);
        assert!(!cancel_task(&run_id));
    }

    #[test]
    fn window_run_guard_blocks_same_hwnd_until_release() {
        let hwnd = -(WINDOW_RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed) as isize);
        let request = RunTaskRequest {
            hwnd,
            entry: unique_test_id("entry"),
            task_name: None,
            dry_run: false,
            max_steps: Some(1),
            coordinate_mode: CoordinateMode::default(),
            run_id: Some(unique_test_id("run")),
            pipeline_overrides: None,
        };
        let guard = acquire_window_run_guard(&request)
            .expect("acquire window guard")
            .expect("real runs get a guard");

        assert!(acquire_window_run_guard(&request).is_err());

        drop(guard);
        assert!(acquire_window_run_guard(&request)
            .expect("window guard can be reacquired")
            .is_some());
    }

    #[test]
    fn target_offset_adjusts_rect_before_taking_click_center() {
        let mapper = CoordinateMapper::new(1280, 720, CoordinateMode::Stretch1280x720);
        let rect = Rect::new(100, 200, 30, 40);
        let adjusted = apply_target_offset(rect, [5, 6, -10, -20], mapper);

        assert_eq!(adjusted, Rect::new(105, 206, 20, 20));
        assert_eq!(adjusted.center(), Point { x: 115, y: 216 });
    }

    #[test]
    fn target_offset_scales_with_current_client_size() {
        let mapper = CoordinateMapper::new(800, 600, CoordinateMode::CropCenter4x3);
        let rect = Rect::new(80, 100, 40, 40);
        let adjusted = apply_target_offset(rect, [12, 12, -24, -24], mapper);

        assert_eq!(adjusted, Rect::new(90, 110, 20, 20));
        assert_eq!(adjusted.center(), Point { x: 100, y: 120 });
    }

    #[test]
    fn renders_focus_detail_with_node_and_best_result() {
        let node = json!({
            "focus": {
                "Node.Recognition.Succeeded": "{name} -> {best_result}"
            }
        });
        let hit = RecognitionHit {
            hit: true,
            kind: "OCR".to_string(),
            score: 1.0,
            text: Some("长安城".to_string()),
            template: None,
            rect: None,
            follow_up: Vec::new(),
            detail: "OCR matched".to_string(),
        };
        assert_eq!(
            focus_detail(&node, "位置识别", &hit, "none"),
            Some("focus: 位置识别 -> 长安城".to_string())
        );
    }

    #[test]
    fn parses_jump_back_refs_only_on_normal_path() {
        let normal = node_refs_from_value(Some(&json!(["A", "[JumpBack]B"])), "Parent", false);
        assert_eq!(normal.len(), 2);
        assert_eq!(normal[0].name, "A");
        assert_eq!(normal[0].jump_back_parent, None);
        assert_eq!(normal[1].name, "B");
        assert_eq!(normal[1].jump_back_parent, Some("Parent".to_string()));

        let error_path = node_refs_from_value(Some(&json!(["[JumpBack]B"])), "Parent", true);
        assert_eq!(error_path[0].name, "B");
        assert_eq!(error_path[0].jump_back_parent, None);
        assert!(error_path[0].error_path);
    }

    #[test]
    fn skips_empty_noop_node_refs() {
        let refs = node_refs_from_value(Some(&json!(["空节点", "A"])), "Parent", true);
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].name, "A");
    }

    #[test]
    fn enqueue_next_refs_creates_candidate_group_with_timing() {
        let mut runner = test_runner_with_queue(Vec::new());
        let parent = json!({
            "next": ["A", "[JumpBack]B"],
            "timeout": 1234,
            "rate_limit": 50
        });
        runner
            .library
            .nodes
            .insert("Parent".to_string(), parent.clone());

        runner.enqueue_next_refs("Parent", &parent, false);

        let Some(QueueItem::CandidateGroup(group)) = runner.queue.front() else {
            panic!("expected candidate group");
        };
        assert_eq!(group.parent, "Parent");
        assert_eq!(group.timeout_ms, 1234);
        assert_eq!(group.rate_limit_ms, 50);
        assert!(!group.error_path);
        assert_eq!(group.refs.len(), 2);
        assert_eq!(group.refs[0].name, "A");
        assert!(group.refs[0].candidate_scan);
        assert_eq!(group.refs[1].name, "B");
        assert_eq!(group.refs[1].jump_back_parent, Some("Parent".to_string()));
    }

    #[test]
    fn jump_back_return_removes_pending_siblings_from_same_parent() {
        let mut runner = TaskRunner {
            request: RunTaskRequest {
                hwnd: 0,
                entry: "Root".to_string(),
                task_name: None,
                dry_run: true,
                max_steps: Some(1),
                coordinate_mode: CoordinateMode::default(),
                run_id: None,
                pipeline_overrides: None,
            },
            library: PipelineLibrary {
                nodes: BTreeMap::new(),
                default_node: Value::Object(Default::default()),
            },
            project_root: PathBuf::new(),
            maa_root: PathBuf::new(),
            queue: VecDeque::from(vec![
                QueueItem::Node(NodeRef {
                    name: "SiblingA".to_string(),
                    parent: Some("Parent".to_string()),
                    jump_back_parent: None,
                    error_path: false,
                    candidate_scan: false,
                }),
                QueueItem::Node(NodeRef {
                    name: "OuterSibling".to_string(),
                    parent: Some("Outer".to_string()),
                    jump_back_parent: None,
                    error_path: false,
                    candidate_scan: false,
                }),
                QueueItem::JumpBackReturn {
                    parent: "Parent".to_string(),
                },
            ]),
            hit_counts: BTreeMap::new(),
            node_boxes: BTreeMap::new(),
            global_count: 0,
            node_success_count: 0,
            ocr_backend: None,
            cancel_flag: None,
            steps: Vec::new(),
            window_identity: None,
            capture_sources: BTreeSet::new(),
        };

        runner.remove_pending_siblings("Parent");
        assert_eq!(runner.queue_labels(), vec!["OuterSibling"]);
    }

    #[test]
    fn normal_candidate_hit_discards_pending_siblings() {
        let mut runner = test_runner_with_queue(vec![
            QueueItem::Node(NodeRef {
                name: "SiblingA".to_string(),
                parent: Some("Parent".to_string()),
                jump_back_parent: None,
                error_path: false,
                candidate_scan: false,
            }),
            QueueItem::Node(NodeRef {
                name: "OuterSibling".to_string(),
                parent: Some("Outer".to_string()),
                jump_back_parent: None,
                error_path: false,
                candidate_scan: false,
            }),
        ]);
        let selected = NodeRef {
            name: "Selected".to_string(),
            parent: Some("Parent".to_string()),
            jump_back_parent: None,
            error_path: false,
            candidate_scan: false,
        };

        let detail = runner.discard_sibling_candidates_after_hit(&selected);
        assert_eq!(
            detail,
            Some("selected candidate for parent Parent; removed 1 pending sibling(s)".to_string())
        );
        assert_eq!(runner.queue_labels(), vec!["OuterSibling"]);
    }

    #[test]
    fn jump_back_candidate_hit_keeps_siblings_until_return() {
        let mut runner = test_runner_with_queue(vec![QueueItem::Node(NodeRef {
            name: "SiblingA".to_string(),
            parent: Some("Parent".to_string()),
            jump_back_parent: None,
            error_path: false,
            candidate_scan: false,
        })]);
        let selected = NodeRef {
            name: "FixPopup".to_string(),
            parent: Some("Parent".to_string()),
            jump_back_parent: Some("Parent".to_string()),
            error_path: false,
            candidate_scan: false,
        };

        assert_eq!(runner.discard_sibling_candidates_after_hit(&selected), None);
        assert_eq!(runner.queue_labels(), vec!["SiblingA"]);
    }

    #[test]
    fn queue_drain_does_not_complete_after_incomplete_status() {
        let mut runner = test_runner_with_queue(Vec::new());
        runner.steps.push(test_step("OpenTeam", "hit"));
        runner
            .steps
            .push(test_step("TeamCandidate", "candidate-timeout"));

        let result = runner.queue_drained_result();

        assert!(!result.completed);
        assert!(result.reason.contains("candidate-timeout"));
    }

    #[test]
    fn queue_drain_does_not_complete_after_trailing_miss() {
        let mut runner = test_runner_with_queue(Vec::new());
        runner.steps.push(test_step("OpenMap", "hit"));
        runner.steps.push(test_step("Parent", "jump-back-return"));
        runner.steps.push(test_step("NpcChoice", "miss"));

        let result = runner.queue_drained_result();

        assert!(!result.completed);
        assert!(result.reason.contains("miss"));
    }

    #[test]
    fn queue_drain_completes_after_clean_hits() {
        let mut runner = test_runner_with_queue(Vec::new());
        runner.steps.push(test_step("OpenMap", "hit"));
        runner.steps.push(test_step("Parent", "jump-back-return"));
        runner.steps.push(test_step("NpcChoice", "hit"));

        let result = runner.queue_drained_result();

        assert!(result.completed);
        assert_eq!(result.reason, "queue drained");
    }

    fn test_runner_with_queue(queue: Vec<QueueItem>) -> TaskRunner {
        TaskRunner {
            request: RunTaskRequest {
                hwnd: 0,
                entry: "Root".to_string(),
                task_name: None,
                dry_run: true,
                max_steps: Some(1),
                coordinate_mode: CoordinateMode::default(),
                run_id: None,
                pipeline_overrides: None,
            },
            library: PipelineLibrary {
                nodes: BTreeMap::new(),
                default_node: Value::Object(Default::default()),
            },
            project_root: PathBuf::new(),
            maa_root: PathBuf::new(),
            queue: VecDeque::from(queue),
            hit_counts: BTreeMap::new(),
            node_boxes: BTreeMap::new(),
            global_count: 0,
            node_success_count: 0,
            ocr_backend: None,
            cancel_flag: None,
            steps: Vec::new(),
            window_identity: None,
            capture_sources: BTreeSet::new(),
        }
    }

    fn test_step(node: &str, status: &str) -> TaskStepLog {
        TaskStepLog {
            index: 1,
            node: node.to_string(),
            status: status.to_string(),
            recognition: None,
            action: None,
            queued: Vec::new(),
            detail: String::new(),
        }
    }

    fn unique_test_id(prefix: &str) -> String {
        format!(
            "{prefix}-{}",
            WINDOW_RUN_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        )
    }
}
