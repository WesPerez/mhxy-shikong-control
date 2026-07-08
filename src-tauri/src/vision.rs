use crate::{
    coords::{CoordinateMapper, Point, Rect},
    ocr::{create_ocr_backend, OcrBackend, OcrTextRow},
    platform::{capture_client_rgb, click_client_point, RgbFrame},
};
use image::{imageops::FilterType, DynamicImage, ImageReader, RgbImage};
use regex::Regex;
use reqwest::blocking::Client;
use reqwest::header::{AUTHORIZATION, CONTENT_TYPE};
use serde::{Deserialize, Serialize};
use serde_json::json;
use serde_json::{Map, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::OnceLock,
    thread,
    time::Duration,
};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecognitionHit {
    pub hit: bool,
    pub kind: String,
    pub score: f32,
    pub text: Option<String>,
    pub template: Option<String>,
    pub rect: Option<Rect>,
    pub follow_up: Vec<String>,
    pub detail: String,
}

impl RecognitionHit {
    pub fn miss(kind: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            hit: false,
            kind: kind.into(),
            score: 0.0,
            text: None,
            template: None,
            rect: None,
            follow_up: Vec::new(),
            detail: detail.into(),
        }
    }

    pub fn pass(kind: impl Into<String>, detail: impl Into<String>) -> Self {
        Self {
            hit: true,
            kind: kind.into(),
            score: 1.0,
            text: None,
            template: None,
            rect: None,
            follow_up: Vec::new(),
            detail: detail.into(),
        }
    }

    pub fn with_follow_up(mut self, follow_up: Vec<String>) -> Self {
        self.follow_up = follow_up;
        self
    }
}

pub struct VisionContext<'a> {
    pub project_root: &'a Path,
    pub maa_root: &'a Path,
    pub frame: &'a RgbFrame,
    pub mapper: CoordinateMapper,
    pub node_boxes: &'a BTreeMap<String, Rect>,
    hwnd: isize,
    dry_run: bool,
    ocr_backend: &'a mut Option<Box<dyn OcrBackend + Send>>,
}

impl<'a> VisionContext<'a> {
    pub fn new(
        project_root: &'a Path,
        maa_root: &'a Path,
        frame: &'a RgbFrame,
        mapper: CoordinateMapper,
        node_boxes: &'a BTreeMap<String, Rect>,
        hwnd: isize,
        dry_run: bool,
        ocr_backend: &'a mut Option<Box<dyn OcrBackend + Send>>,
    ) -> Self {
        Self {
            project_root,
            maa_root,
            frame,
            mapper,
            node_boxes,
            hwnd,
            dry_run,
            ocr_backend,
        }
    }

    pub fn recognize(
        &mut self,
        node_name: &str,
        node: &Value,
        nodes: &BTreeMap<String, Value>,
    ) -> RecognitionHit {
        let Some(kind) = node.get("recognition").and_then(Value::as_str) else {
            return RecognitionHit::pass("None", "node has no recognition requirement");
        };
        let mut hit = match kind {
            "DirectHit" => {
                RecognitionHit::pass("DirectHit", "direct-hit recognition bypassed vision")
            }
            "TemplateMatch" => self.template_match(node_name, node, nodes),
            "ColorMatch" => self.color_match(node_name, node, nodes),
            "OCR" => self.ocr_match(node_name, node, nodes),
            "Or" => self.any_of(node_name, node, nodes),
            "And" => self.all_of(node_name, node, nodes),
            "Custom" => self.custom_recognition(node, nodes),
            other => RecognitionHit::miss(other, format!("unsupported recognition type: {other}")),
        };
        if node
            .get("inverse")
            .and_then(Value::as_bool)
            .unwrap_or(false)
        {
            hit = if hit.hit {
                RecognitionHit::miss(kind, format!("inverse miss because {kind} matched"))
            } else {
                RecognitionHit::pass(kind, format!("inverse hit because {kind} did not match"))
            };
        }
        hit
    }

    fn any_of(
        &mut self,
        node_name: &str,
        node: &Value,
        nodes: &BTreeMap<String, Value>,
    ) -> RecognitionHit {
        let Some(items) = node.get("any_of").and_then(Value::as_array) else {
            return RecognitionHit::miss("Or", "Or recognition has no any_of array");
        };
        let mut misses = Vec::new();
        for item in items {
            let hit = self.recognize_child(node_name, item, nodes);
            if hit.hit {
                return hit;
            }
            misses.push(hit.detail);
        }
        RecognitionHit::miss("Or", misses.join(" | "))
    }

    fn all_of(
        &mut self,
        node_name: &str,
        node: &Value,
        nodes: &BTreeMap<String, Value>,
    ) -> RecognitionHit {
        let Some(items) = node.get("all_of").and_then(Value::as_array) else {
            return RecognitionHit::miss("And", "And recognition has no all_of array");
        };
        let mut last = RecognitionHit::pass("And", "all sub-recognitions matched");
        for item in items {
            let hit = self.recognize_child(node_name, item, nodes);
            if !hit.hit {
                return RecognitionHit::miss("And", hit.detail);
            }
            last = hit;
        }
        last.kind = "And".to_string();
        last
    }

    fn recognize_child(
        &mut self,
        node_name: &str,
        item: &Value,
        nodes: &BTreeMap<String, Value>,
    ) -> RecognitionHit {
        if let Some(name) = item.as_str() {
            let Some(node) = nodes.get(name) else {
                return RecognitionHit::miss(
                    "Reference",
                    format!("referenced recognition node is missing: {name}"),
                );
            };
            return self.recognize(name, node, nodes);
        }
        self.recognize(node_name, item, nodes)
    }

    fn template_match(
        &mut self,
        node_name: &str,
        node: &Value,
        nodes: &BTreeMap<String, Value>,
    ) -> RecognitionHit {
        let templates = template_values(node.get("template"));
        if templates.is_empty() {
            return RecognitionHit::miss("TemplateMatch", "template field is empty");
        }
        let Some(search_rect) = self.resolve_roi(node.get("roi"), nodes) else {
            return RecognitionHit::miss("TemplateMatch", "ROI is outside the current frame");
        };
        let thresholds = threshold_values(node.get("threshold"), templates.len(), 0.82);
        let green_mask = node
            .get("green_mask")
            .and_then(Value::as_bool)
            .unwrap_or(false);
        let mut best: Option<RecognitionHit> = None;
        for (index, template_ref) in templates.iter().enumerate() {
            let template_paths =
                resolve_template_paths(self.project_root, self.maa_root, template_ref);
            if template_paths.is_empty() {
                best = Some(best.unwrap_or_else(|| {
                    RecognitionHit::miss(
                        "TemplateMatch",
                        format!("template not found: {template_ref}"),
                    )
                }));
                continue;
            }
            for template_path in template_paths {
                let Ok(template) = load_template(&template_path.path) else {
                    continue;
                };
                let search_rect = template_path
                    .search
                    .and_then(|search| mapped_template_search_rect(search, self.frame))
                    .or(Some(search_rect))
                    .and_then(|rect| rect.clamp_to(self.frame.width, self.frame.height));
                let Some(search_rect) = search_rect else {
                    continue;
                };
                let scaled = scale_template_for_frame(
                    &template,
                    self.mapper,
                    self.frame.width,
                    self.frame.height,
                    template_path.scale,
                );
                if scaled.width == 0
                    || scaled.height == 0
                    || scaled.width > search_rect.width as u32
                    || scaled.height > search_rect.height as u32
                {
                    continue;
                }
                let candidate = match_template(
                    self.frame,
                    search_rect,
                    &scaled,
                    thresholds[index],
                    green_mask,
                );
                if let Some((rect, score)) = candidate {
                    let hit = RecognitionHit {
                        hit: true,
                        kind: "TemplateMatch".to_string(),
                        score,
                        text: None,
                        template: Some(template_path.path.display().to_string()),
                        rect: Some(rect),
                        follow_up: Vec::new(),
                        detail: format!("matched {template_ref} score {score:.3}"),
                    };
                    if best
                        .as_ref()
                        .map(|item| hit.score > item.score)
                        .unwrap_or(true)
                    {
                        best = Some(hit);
                    }
                }
            }
        }
        if let Some(hit) = self.template_text_fallback(node_name, &templates, search_rect) {
            return hit;
        }
        let gap_hint = runtime_gap_hint(&templates);
        if let Some(hit) = best {
            if let Some(hint) = gap_hint {
                return RecognitionHit::miss("TemplateMatch", format!("{}; {hint}", hit.detail));
            }
            return hit;
        }
        RecognitionHit::miss(
            "TemplateMatch",
            match gap_hint {
                Some(hint) => format!("no template matched in ROI {:?}; {hint}", search_rect),
                None => format!("no template matched in ROI {:?}", search_rect),
            },
        )
    }

    fn color_match(
        &self,
        _node_name: &str,
        node: &Value,
        nodes: &BTreeMap<String, Value>,
    ) -> RecognitionHit {
        let Some(rect) = self.resolve_roi(node.get("roi"), nodes) else {
            return RecognitionHit::miss("ColorMatch", "ROI is outside the current frame");
        };
        let upper = parse_rgb(node.get("upper")).unwrap_or([255, 255, 255]);
        let lower = parse_rgb(node.get("lower")).unwrap_or([0, 0, 0]);
        let required = node.get("count").and_then(Value::as_u64).unwrap_or(1) as usize;
        let mut count = 0usize;
        for y in rect.y..rect.y + rect.height {
            for x in rect.x..rect.x + rect.width {
                let Some(pixel) = frame_pixel(self.frame, x as u32, y as u32) else {
                    continue;
                };
                if (0..3).all(|idx| pixel[idx] >= lower[idx] && pixel[idx] <= upper[idx]) {
                    count += 1;
                    if count >= required {
                        return RecognitionHit {
                            hit: true,
                            kind: "ColorMatch".to_string(),
                            score: 1.0,
                            text: None,
                            template: None,
                            rect: Some(rect),
                            follow_up: Vec::new(),
                            detail: format!("matched {count} pixels in range"),
                        };
                    }
                }
            }
        }
        RecognitionHit::miss(
            "ColorMatch",
            format!("matched {count}/{required} pixels in range"),
        )
    }

    fn ocr_match(
        &mut self,
        _node_name: &str,
        node: &Value,
        nodes: &BTreeMap<String, Value>,
    ) -> RecognitionHit {
        let Some(rect) = self.resolve_roi(node.get("roi"), nodes) else {
            return RecognitionHit::miss("OCR", "ROI is outside the current frame");
        };
        let rows = match self.ocr_rows_in_rect(rect) {
            Ok(rows) => rows,
            Err(err) => return RecognitionHit::miss("OCR", err),
        };
        let expected = expected_values(node.get("expected"));
        let replacements = replacement_values(node.get("replace"));
        let mut best_text = String::new();
        for row in rows {
            let text = apply_replacements(&row.text, &replacements);
            if best_text.is_empty() {
                best_text = text.clone();
            }
            if expected_matches(&text, &expected) {
                let rect = row.box_rect.map(|item| Rect {
                    x: item[0],
                    y: item[1],
                    width: item[2],
                    height: item[3],
                });
                return RecognitionHit {
                    hit: true,
                    kind: "OCR".to_string(),
                    score: row.score,
                    text: Some(text.clone()),
                    template: None,
                    rect,
                    follow_up: Vec::new(),
                    detail: format!("OCR matched {text:?}"),
                };
            }
        }
        RecognitionHit::miss(
            "OCR",
            format!("OCR text {best_text:?} did not match expected"),
        )
    }

    fn custom_recognition(
        &mut self,
        node: &Value,
        nodes: &BTreeMap<String, Value>,
    ) -> RecognitionHit {
        let hook = node
            .get("custom_recognition")
            .and_then(Value::as_str)
            .unwrap_or("<missing>");
        match hook {
            "invite" => self.custom_invite(nodes),
            "OCRNum" => self.custom_ocr_num(nodes),
            "OCRVitality" => self.custom_ocr_vitality(nodes),
            "sjqy_tiku_V2" | "sjqy_tiku_V3" => self.custom_sjqy_tiku(nodes),
            "AIAnswer" | "zhipu" => self.custom_ai_answer(hook, node, nodes),
            "reco2" => RecognitionHit::pass("Custom", "legacy reco2 placeholder hit"),
            "my_reco_222" => RecognitionHit::pass("Custom", "sample my_reco_222 placeholder hit"),
            other => RecognitionHit::miss(
                "Custom",
                format!("custom recognition {other} is not ported yet"),
            ),
        }
    }

    fn custom_invite(&mut self, nodes: &BTreeMap<String, Value>) -> RecognitionHit {
        let Ok(rows) = self.ocr_rows_for_roi([336, 224, 64, 38], &[], nodes) else {
            return RecognitionHit::miss("Custom", "invite failed to OCR search button");
        };
        let Some(row) = rows
            .iter()
            .find(|row| expected_matches(&row.text, &[String::from("搜索")]))
            .or_else(|| rows.first())
        else {
            return RecognitionHit::miss("Custom", "invite did not find search button text");
        };
        let rect = row
            .box_rect
            .map(|item| Rect::new(item[0], item[1], item[2], item[3]))
            .or_else(|| self.mapper.clamp_rect(self.mapper.rect([336, 224, 64, 38])));
        if let Some(rect) = rect {
            if let Err(err) = self.click_rect(rect) {
                return RecognitionHit::miss("Custom", format!("invite click failed: {err}"));
            }
            RecognitionHit {
                hit: true,
                kind: "Custom".to_string(),
                score: row.score,
                text: Some(row.text.clone()),
                template: None,
                rect: Some(rect),
                follow_up: Vec::new(),
                detail: "invite clicked search field".to_string(),
            }
        } else {
            RecognitionHit::miss("Custom", "invite search ROI is outside current frame")
        }
    }

    fn custom_ocr_num(&mut self, nodes: &BTreeMap<String, Value>) -> RecognitionHit {
        let rows = match self.ocr_rows_for_roi([305, 586, 862, 70], &[], nodes) {
            Ok(rows) => rows,
            Err(err) => return RecognitionHit::miss("Custom", format!("OCRNum failed: {err}")),
        };
        let text = join_ocr_rows(rows);
        let Some(num) = first_i32(&text) else {
            return RecognitionHit::pass(
                "Custom",
                format!("OCRNum could not parse activity from {text:?}"),
            )
            .with_follow_up(vec!["panduan_zhujiemian".to_string()]);
        };
        if num >= 50 {
            RecognitionHit::pass("Custom", format!("OCRNum activity={num}, continue escort"))
                .with_follow_up(vec!["活动-运镖-点击日常活动".to_string()])
        } else {
            RecognitionHit::pass("Custom", format!("OCRNum activity={num}, task ends"))
                .with_follow_up(vec!["panduan_zhujiemian".to_string()])
        }
    }

    fn custom_ocr_vitality(&mut self, nodes: &BTreeMap<String, Value>) -> RecognitionHit {
        let rows = match self.ocr_rows_for_roi([380, 103, 542, 46], &[], nodes) {
            Ok(rows) => rows,
            Err(err) => {
                return RecognitionHit::miss("Custom", format!("OCRVitality failed: {err}"))
            }
        };
        let text = join_ocr_rows(rows);
        let current = text
            .split('/')
            .next()
            .and_then(first_i32)
            .unwrap_or_default();
        let work_count = (current / 100).max(0) as usize;
        RecognitionHit::pass(
            "Custom",
            format!("OCRVitality current={current}, queued 打工 x{work_count}"),
        )
        .with_follow_up(vec!["点击打工".to_string(); work_count])
    }

    fn custom_sjqy_tiku(&mut self, nodes: &BTreeMap<String, Value>) -> RecognitionHit {
        let replacements = vec![
            ("味".to_string(), "昧".to_string()),
            ("邮".to_string(), "邺".to_string()),
            ("尺".to_string(), "尸".to_string()),
            ("频".to_string(), "濒".to_string()),
            ("铜".to_string(), "锢".to_string()),
        ];
        let question_rows = match self.ocr_rows_for_roi([447, 40, 673, 94], &replacements, nodes) {
            Ok(rows) => rows,
            Err(err) => {
                return RecognitionHit::miss("Custom", format!("sjqy question OCR failed: {err}"))
            }
        };
        let question = clean_question_text(&join_ocr_rows(sort_ocr_rows(question_rows)));
        if question.is_empty() {
            return RecognitionHit::pass("Custom", "sjqy question OCR is empty");
        }
        let search = search_question_bank(self.maa_root, &question);
        if search.confidence < 80 || search.answers.is_empty() {
            let _ = self.click_baseline_point([500, 344]);
            return RecognitionHit::pass(
                "Custom",
                format!(
                    "sjqy low-confidence question={question:?}, confidence={}, clicked first answer",
                    search.confidence
                ),
            );
        }
        let answer_rows = match self.ocr_rows_for_roi([439, 218, 678, 212], &[], nodes) {
            Ok(rows) => rows,
            Err(err) => {
                return RecognitionHit::miss("Custom", format!("sjqy answer OCR failed: {err}"))
            }
        };
        let answer = answer_rows
            .iter()
            .find(|row| expected_matches(&row.text, &search.answers));
        if let Some(row) = answer {
            if let Some(rect) = row
                .box_rect
                .map(|item| Rect::new(item[0], item[1], item[2], item[3]))
            {
                if let Err(err) = self.click_rect(rect) {
                    return RecognitionHit::miss(
                        "Custom",
                        format!("sjqy answer click failed: {err}"),
                    );
                }
                return RecognitionHit {
                    hit: true,
                    kind: "Custom".to_string(),
                    score: row.score,
                    text: Some(question),
                    template: None,
                    rect: Some(rect),
                    follow_up: Vec::new(),
                    detail: format!(
                        "sjqy clicked answer {:?}, confidence={}, match={}",
                        search.answers, search.confidence, search.match_type
                    ),
                };
            }
        }
        let _ = self.click_baseline_point([500, 344]);
        RecognitionHit::pass(
            "Custom",
            format!(
                "sjqy answer {:?} not visible, clicked first answer; question={question:?}, confidence={}",
                search.answers, search.confidence
            ),
        )
    }

    fn custom_ai_answer(
        &mut self,
        hook: &str,
        node: &Value,
        nodes: &BTreeMap<String, Value>,
    ) -> RecognitionHit {
        let question = self
            .ocr_rows_for_roi([511, 186, 602, 107], &[], nodes)
            .map(sort_ocr_rows)
            .map(join_ocr_rows)
            .unwrap_or_default();
        let answer_rois = [
            ("A", [509, 306, 269, 91]),
            ("B", [825, 304, 270, 95]),
            ("C", [506, 408, 268, 88]),
            ("D", [831, 404, 265, 96]),
        ];
        let mut answers = Vec::new();
        for (label, roi) in answer_rois {
            let text = self
                .ocr_rows_for_roi(roi, &[], nodes)
                .map(sort_ocr_rows)
                .map(join_ocr_rows)
                .unwrap_or_default();
            answers.push(AiAnswerOption { label, text, roi });
        }
        let ai_result = match hook {
            "AIAnswer" => query_openai_compatible_answer(node, &question, &answers),
            "zhipu" => query_zhipu_answer(node, &question, &answers),
            _ => Err(format!("unsupported AI hook: {hook}")),
        };
        let (choice, detail) = match ai_result {
            Ok(response) => match choose_ai_answer(&response, &answers) {
                Some(choice) => (choice, format!("{hook} answered {choice}: {response}")),
                None => (
                    "A",
                    format!("{hook} response did not contain A/B/C/D, fallback A: {response}"),
                ),
            },
            Err(err) => ("A", format!("{hook} unavailable, fallback A: {err}")),
        };
        let option = answers
            .iter()
            .find(|answer| answer.label == choice)
            .unwrap_or_else(|| answers.first().expect("answer_rois is non-empty"));
        let rect = self.mapper.rect(option.roi);
        let _ = self.click_rect(rect);
        RecognitionHit::pass(
            "Custom",
            format!(
                "{detail}. question={question:?}, answers={}",
                format_ai_answers(&answers)
            ),
        )
    }

    fn ocr_rows_for_roi(
        &mut self,
        roi: [i32; 4],
        replacements: &[(String, String)],
        _nodes: &BTreeMap<String, Value>,
    ) -> Result<Vec<OcrTextRow>, String> {
        let rect = self
            .mapper
            .clamp_rect(self.mapper.rect(roi))
            .ok_or_else(|| format!("ROI is outside the current frame: {roi:?}"))?;
        let mut rows = self.ocr_rows_in_rect(rect)?;
        for row in &mut rows {
            row.text = apply_replacements(&row.text, replacements);
        }
        Ok(rows)
    }

    fn ocr_rows_in_rect(&mut self, rect: Rect) -> Result<Vec<OcrTextRow>, String> {
        self.ocr_rows_in_frame_rect(self.frame, rect)
    }

    fn ocr_rows_in_frame_rect(
        &mut self,
        frame: &RgbFrame,
        rect: Rect,
    ) -> Result<Vec<OcrTextRow>, String> {
        let cropped = crop_frame(frame, rect)?;
        if self.ocr_backend.is_none() {
            *self.ocr_backend = Some(create_ocr_backend());
        }
        let mut rows = self
            .ocr_backend
            .as_mut()
            .expect("OCR backend initialized above")
            .recognize(&cropped)?;
        for row in &mut rows {
            if let Some(box_rect) = row.box_rect.as_mut() {
                box_rect[0] += rect.x;
                box_rect[1] += rect.y;
            }
        }
        Ok(rows)
    }

    fn template_text_fallback(
        &mut self,
        node_name: &str,
        templates: &[String],
        search_rect: Rect,
    ) -> Option<RecognitionHit> {
        let rules = load_template_text_fallbacks(self.project_root);
        if rules.templates.is_empty() {
            return None;
        }
        let mut cached_rows: Vec<(Rect, Result<Vec<OcrTextRow>, String>)> = Vec::new();
        let mut ocr_errors = Vec::new();
        let inventory_rules = templates
            .iter()
            .filter_map(|template_ref| {
                let rule = rules.templates.get(template_ref)?;
                rule.inventory_name
                    .as_ref()
                    .map(|inventory| (template_ref, inventory))
            })
            .collect::<Vec<_>>();
        if let Some(hit) = self.inventory_name_fallback(node_name, &inventory_rules) {
            return Some(hit);
        }
        for template_ref in templates {
            let Some(rule) = rules.templates.get(template_ref) else {
                continue;
            };
            let rect = rule
                .default_roi
                .or(rules.default_roi)
                .and_then(|roi| self.mapper.clamp_rect(self.mapper.rect(roi)))
                .unwrap_or(search_rect);
            if let Some(color_rule) = &rule.color {
                let Some(candidate) = match_color_fallback_frame(self.frame, color_rule, rect)
                else {
                    continue;
                };
                let hit_rect = text_fallback_hit_rect(rule, &self.mapper, candidate.rect);
                return Some(RecognitionHit {
                    hit: true,
                    kind: "TemplateMatch".to_string(),
                    score: candidate.score,
                    text: None,
                    template: Some(template_ref.clone()),
                    rect: Some(hit_rect),
                    follow_up: Vec::new(),
                    detail: format!(
                        "color fallback matched {template_ref} for {node_name}: {}/{} pixels",
                        candidate.count, candidate.required
                    ),
                });
            }
            if !rule.colors.is_empty() {
                let Some(candidate) =
                    match_all_color_fallbacks_frame(self.frame, &rule.colors, rect)
                else {
                    continue;
                };
                let hit_rect = text_fallback_hit_rect(rule, &self.mapper, candidate.rect);
                return Some(RecognitionHit {
                    hit: true,
                    kind: "TemplateMatch".to_string(),
                    score: candidate.score,
                    text: None,
                    template: Some(template_ref.clone()),
                    rect: Some(hit_rect),
                    follow_up: Vec::new(),
                    detail: format!(
                        "multi-color fallback matched {template_ref} for {node_name}: {}",
                        candidate.detail
                    ),
                });
            }
            let rows = match self.cached_ocr_rows_for_text_fallback(&mut cached_rows, rect) {
                Ok(rows) => rows,
                Err(err) => {
                    ocr_errors.push(err);
                    continue;
                }
            };
            let Some(candidate) = match_text_fallback_rows(&rows, rule, rect) else {
                continue;
            };
            let hit_rect = text_fallback_hit_rect(rule, &self.mapper, candidate.rect);
            return Some(RecognitionHit {
                hit: true,
                kind: "TemplateMatch".to_string(),
                score: candidate.score,
                text: Some(candidate.text.clone()),
                template: Some(template_ref.clone()),
                rect: Some(hit_rect),
                follow_up: Vec::new(),
                detail: format!(
                    "OCR fallback matched {template_ref} for {node_name}: {}",
                    candidate.text
                ),
            });
        }
        None
    }

    fn inventory_name_fallback(
        &mut self,
        node_name: &str,
        rules: &[(&String, &InventoryNameFallbackRule)],
    ) -> Option<RecognitionHit> {
        if rules.is_empty() || self.dry_run {
            return None;
        }
        let aliases = inventory_name_aliases(rules);
        if aliases.is_empty() {
            return None;
        }
        let grid = rules
            .iter()
            .find_map(|(_, rule)| rule.grid.clone())
            .unwrap_or_default();
        let slots = inventory_grid_slots(&self.mapper, &grid, self.frame.width, self.frame.height);
        if slots.is_empty() {
            return None;
        }
        let detail_rect = rules
            .iter()
            .find_map(|(_, rule)| rule.detail_roi)
            .and_then(|roi| self.mapper.clamp_rect(self.mapper.rect(roi)));
        let delay = rules
            .iter()
            .filter_map(|(_, rule)| rule.slot_delay_ms)
            .next()
            .unwrap_or(280)
            .min(1500);
        for slot in slots {
            if self.click_rect(slot).is_err() {
                continue;
            }
            thread::sleep(Duration::from_millis(delay));
            let Ok(frame) = capture_client_rgb(self.hwnd) else {
                continue;
            };
            let rect =
                detail_rect.unwrap_or(Rect::new(0, 0, frame.width as i32, frame.height as i32));
            let Ok(rows) = self.ocr_rows_in_frame_rect(&frame, rect) else {
                continue;
            };
            let Some(candidate) = match_inventory_name_rows(&rows, &aliases) else {
                continue;
            };
            return Some(RecognitionHit {
                hit: true,
                kind: "TemplateMatch".to_string(),
                score: candidate.score,
                text: Some(candidate.text.clone()),
                template: Some(candidate.template.clone()),
                rect: Some(slot),
                follow_up: Vec::new(),
                detail: format!(
                    "inventory OCR fallback matched {} for {node_name}: alias={} text={}",
                    candidate.template, candidate.alias, candidate.text
                ),
            });
        }
        None
    }

    fn cached_ocr_rows_for_text_fallback(
        &mut self,
        cache: &mut Vec<(Rect, Result<Vec<OcrTextRow>, String>)>,
        rect: Rect,
    ) -> Result<Vec<OcrTextRow>, String> {
        if let Some((_, result)) = cache.iter().find(|(cached_rect, _)| *cached_rect == rect) {
            return result.clone();
        }
        let result = self.ocr_rows_in_rect(rect);
        cache.push((rect, result.clone()));
        result
    }

    fn click_rect(&self, rect: Rect) -> Result<(), String> {
        self.click_point(rect.center())
    }

    fn click_baseline_point(&self, point: [i32; 2]) -> Result<(), String> {
        self.click_point(self.mapper.point_from_pair(point))
    }

    fn click_point(&self, point: Point) -> Result<(), String> {
        if self.dry_run {
            return Ok(());
        }
        click_client_point(self.hwnd, point.x, point.y)?;
        thread::sleep(Duration::from_millis(120));
        Ok(())
    }

    fn resolve_roi(&self, value: Option<&Value>, nodes: &BTreeMap<String, Value>) -> Option<Rect> {
        match value {
            Some(Value::Array(items)) => parse_i32_4(items).and_then(|roi| {
                let rect = self.mapper.rect(roi);
                self.mapper.clamp_rect(rect)
            }),
            Some(Value::String(name)) => {
                if let Some(rect) = self.node_boxes.get(name) {
                    return Some(*rect);
                }
                let referenced = nodes.get(name)?;
                self.resolve_roi(referenced.get("roi"), nodes)
            }
            _ => Some(Rect::new(
                0,
                0,
                self.frame.width as i32,
                self.frame.height as i32,
            )),
        }
    }
}

#[derive(Debug, Clone)]
struct TemplateImage {
    width: u32,
    height: u32,
    pixels: Vec<u8>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateTextFallbacks {
    #[serde(default)]
    default_roi: Option<[i32; 4]>,
    #[serde(default)]
    templates: BTreeMap<String, TemplateTextFallbackRule>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateTextFallbackRule {
    #[serde(default)]
    activity: Vec<String>,
    #[serde(default)]
    status_any: Vec<String>,
    #[serde(default)]
    text_all: Vec<String>,
    #[serde(default)]
    text_any: Vec<String>,
    #[serde(default)]
    default_roi: Option<[i32; 4]>,
    #[serde(default)]
    hit_roi: Option<[i32; 4]>,
    #[serde(default)]
    color: Option<TemplateColorFallbackRule>,
    #[serde(default)]
    colors: Vec<TemplateColorFallbackRule>,
    #[serde(default)]
    inventory_name: Option<InventoryNameFallbackRule>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryNameFallbackRule {
    #[serde(default)]
    aliases: Vec<String>,
    #[serde(default)]
    min_score: Option<f32>,
    #[serde(default)]
    grid: Option<InventoryGridFallbackRule>,
    #[serde(default)]
    detail_roi: Option<[i32; 4]>,
    #[serde(default)]
    slot_delay_ms: Option<u64>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InventoryGridFallbackRule {
    left: i32,
    top: i32,
    slot_width: i32,
    slot_height: i32,
    stride_x: i32,
    stride_y: i32,
    columns: usize,
    rows: usize,
}

impl Default for InventoryGridFallbackRule {
    fn default() -> Self {
        Self {
            left: 646,
            top: 190,
            slot_width: 62,
            slot_height: 62,
            stride_x: 64,
            stride_y: 75,
            columns: 6,
            rows: 5,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TemplateColorFallbackRule {
    lower: [u8; 3],
    upper: [u8; 3],
    #[serde(default)]
    count: usize,
}

#[derive(Debug, Clone, PartialEq)]
struct TextFallbackCandidate {
    text: String,
    score: f32,
    rect: Rect,
}

#[derive(Debug, Clone, PartialEq)]
struct ColorFallbackCandidate {
    count: usize,
    required: usize,
    score: f32,
    rect: Rect,
}

#[derive(Debug, Clone, PartialEq)]
struct MultiColorFallbackCandidate {
    score: f32,
    rect: Rect,
    detail: String,
}

#[derive(Debug, Clone, PartialEq)]
struct InventoryNameAlias {
    template: String,
    alias: String,
    pattern: String,
    min_score: f32,
}

#[derive(Debug, Clone, PartialEq)]
struct InventoryNameCandidate {
    template: String,
    alias: String,
    text: String,
    score: f32,
}

fn template_values(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(item)) => vec![item.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn expected_values(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(item)) => vec![item.clone()],
        Some(Value::Array(items)) => items
            .iter()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn replacement_values(value: Option<&Value>) -> Vec<(String, String)> {
    let Some(items) = value.and_then(Value::as_array) else {
        return Vec::new();
    };
    items
        .iter()
        .filter_map(|item| {
            let pair = item.as_array()?;
            Some((
                pair.first()?.as_str()?.to_string(),
                pair.get(1)?.as_str()?.to_string(),
            ))
        })
        .collect()
}

fn threshold_values(value: Option<&Value>, len: usize, default: f32) -> Vec<f32> {
    match value {
        Some(Value::Number(number)) => vec![number.as_f64().unwrap_or(default as f64) as f32; len],
        Some(Value::Array(items)) => {
            let mut values = items
                .iter()
                .filter_map(Value::as_f64)
                .map(|value| value as f32)
                .collect::<Vec<_>>();
            if values.is_empty() {
                values.push(default);
            }
            while values.len() < len {
                values.push(*values.last().unwrap_or(&default));
            }
            values
        }
        _ => vec![default; len],
    }
}

fn runtime_gap_hint(templates: &[String]) -> Option<&'static str> {
    for template in templates {
        if template.starts_with("wujian/bcg/baicaogu_weizhi") {
            return Some(
                "known runtime gap: capture the real 百草谷/九黎 in-scene movement ground marker after 帮派地图 is visible",
            );
        }
        if template == "wujian/bcg/baicaogu_shenshu_xiaoshi.png" {
            return Some(
                "known runtime gap: capture the real 百草谷 disappeared-tree/completion state from the live scene",
            );
        }
        if template.starts_with("wujian/mz/mz_mubiao_diban") {
            return Some(
                "known runtime gap: capture the actual 帮派迷阵 endpoint floor tile from the live maze scene",
            );
        }
    }
    None
}

fn resolve_template_paths(
    project_root: &Path,
    maa_root: &Path,
    template_ref: &str,
) -> Vec<TemplatePath> {
    let replacement_root = project_root
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("image");
    let base_root = maa_root
        .join("assets")
        .join("resource")
        .join("base")
        .join("image");
    let mapping = load_template_mapping(project_root);
    let replacement_variants = mapping
        .get(template_ref)
        .map(template_variants_from_mapping)
        .unwrap_or_default();
    let mut paths = Vec::new();
    if replacement_variants.is_empty() {
        push_template_paths(
            &mut paths,
            &replacement_root.join(template_ref),
            TemplateScale::ClientPixels,
            None,
        );
    } else {
        for variant in replacement_variants {
            let path = resolve_template_variant_path(
                project_root,
                &replacement_root,
                template_ref,
                &variant,
            );
            push_template_paths(&mut paths, &path, variant.scale, variant.search);
        }
    }
    push_template_paths(
        &mut paths,
        &base_root.join(template_ref),
        TemplateScale::Baseline,
        None,
    );
    paths
}

fn push_template_paths(
    paths: &mut Vec<TemplatePath>,
    path: &Path,
    scale: TemplateScale,
    search: Option<TemplateSearch>,
) {
    if path.is_file() {
        paths.push(TemplatePath {
            path: path.to_path_buf(),
            scale,
            search,
        });
    } else if path.is_dir() {
        for entry in WalkDir::new(path)
            .into_iter()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_type().is_file())
        {
            if entry
                .path()
                .extension()
                .and_then(|item| item.to_str())
                .is_some_and(|ext| ext.eq_ignore_ascii_case("png"))
            {
                paths.push(TemplatePath {
                    path: entry.path().to_path_buf(),
                    scale,
                    search,
                });
            }
        }
    }
}

fn resolve_template_variant_path(
    project_root: &Path,
    replacement_root: &Path,
    template_ref: &str,
    variant: &TemplateVariant,
) -> PathBuf {
    if let Some(path) = variant.replacement_path.as_deref() {
        let path = PathBuf::from(path);
        if path.is_absolute() {
            path
        } else {
            project_root.join(path)
        }
    } else {
        replacement_root.join(template_ref)
    }
}

fn load_template(path: &Path) -> Result<TemplateImage, String> {
    let image = ImageReader::open(path)
        .map_err(|err| err.to_string())?
        .decode()
        .map_err(|err| err.to_string())?;
    dynamic_to_template(image)
}

fn dynamic_to_template(image: DynamicImage) -> Result<TemplateImage, String> {
    let rgb = image.to_rgb8();
    Ok(TemplateImage {
        width: rgb.width(),
        height: rgb.height(),
        pixels: rgb.into_raw(),
    })
}

#[derive(Debug, Clone)]
struct TemplatePath {
    path: PathBuf,
    scale: TemplateScale,
    search: Option<TemplateSearch>,
}

#[derive(Debug, Clone)]
struct TemplateVariant {
    replacement_path: Option<String>,
    scale: TemplateScale,
    search: Option<TemplateSearch>,
}

#[derive(Debug, Clone, Copy)]
enum TemplateScale {
    Baseline,
    SourceFrame { width: u32, height: u32 },
    ClientPixels,
}

#[derive(Debug, Clone, Copy)]
struct TemplateSearch {
    roi: [i32; 4],
    source_width: u32,
    source_height: u32,
}

fn scale_template_for_frame(
    template: &TemplateImage,
    mapper: CoordinateMapper,
    frame_width: u32,
    frame_height: u32,
    scale: TemplateScale,
) -> TemplateImage {
    let (scale_x, scale_y) = match scale {
        TemplateScale::Baseline => (mapper.scale_x(), mapper.scale_y()),
        TemplateScale::SourceFrame { width, height } => (
            frame_width as f32 / width.max(1) as f32,
            frame_height as f32 / height.max(1) as f32,
        ),
        TemplateScale::ClientPixels => (1.0, 1.0),
    };
    let width = ((template.width as f32) * scale_x).round().max(1.0) as u32;
    let height = ((template.height as f32) * scale_y).round().max(1.0) as u32;
    if width == template.width && height == template.height {
        return template.clone();
    }
    let Some(image) = RgbImage::from_raw(template.width, template.height, template.pixels.clone())
    else {
        return template.clone();
    };
    let resized = image::imageops::resize(&image, width, height, FilterType::Triangle);
    TemplateImage {
        width,
        height,
        pixels: resized.into_raw(),
    }
}

fn load_template_mapping(project_root: &Path) -> BTreeMap<String, Value> {
    let path = project_root
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("template_mapping.json");
    let Ok(text) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let Ok(value) = serde_json::from_str::<Value>(&text) else {
        return BTreeMap::new();
    };
    value
        .get("templates")
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default()
}

fn load_template_text_fallbacks(project_root: &Path) -> &'static TemplateTextFallbacks {
    static FALLBACKS: OnceLock<TemplateTextFallbacks> = OnceLock::new();
    FALLBACKS.get_or_init(|| {
        let path = project_root
            .join("assets")
            .join("resource")
            .join("ShiKong")
            .join("template_text_fallbacks.json");
        let Ok(text) = fs::read_to_string(path) else {
            return TemplateTextFallbacks {
                default_roi: None,
                templates: BTreeMap::new(),
            };
        };
        serde_json::from_str::<TemplateTextFallbacks>(&text).unwrap_or_else(|_| {
            TemplateTextFallbacks {
                default_roi: None,
                templates: BTreeMap::new(),
            }
        })
    })
}

fn match_text_fallback_rows(
    rows: &[OcrTextRow],
    rule: &TemplateTextFallbackRule,
    search_rect: Rect,
) -> Option<TextFallbackCandidate> {
    if !rule.text_all.is_empty() || !rule.text_any.is_empty() {
        return match_text_fallback_block(rows, rule, search_rect);
    }
    if rule.activity.is_empty() {
        return None;
    }
    let activity_patterns = normalized_patterns(&rule.activity);
    let status_patterns = normalized_patterns(&rule.status_any);
    let row_window = text_fallback_row_window(search_rect);
    let mut best: Option<TextFallbackCandidate> = None;
    for activity_row in rows {
        if !normalized_contains_any(&normalize_text(&activity_row.text), &activity_patterns) {
            continue;
        }
        let activity_rect = row_rect(activity_row)?;
        let activity_center_y = activity_rect.y + activity_rect.height / 2;
        let left_column = activity_rect.center().x < search_rect.x + search_rect.width / 2;
        let mut same_row = rows
            .iter()
            .filter_map(|row| {
                let rect = row_rect(row)?;
                let center_y = rect.y + rect.height / 2;
                let same_column =
                    (rect.center().x < search_rect.x + search_rect.width / 2) == left_column;
                (same_column && (center_y - activity_center_y).abs() <= row_window)
                    .then_some((row, rect))
            })
            .collect::<Vec<_>>();
        same_row.sort_by_key(|(_, rect)| (rect.y / 8, rect.x));
        let combined = same_row
            .iter()
            .map(|(row, _)| row.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let normalized_combined = normalize_text(&combined);
        if !status_patterns.is_empty()
            && !normalized_contains_any(&normalized_combined, &status_patterns)
        {
            continue;
        }
        let rect = same_row
            .iter()
            .map(|(_, rect)| *rect)
            .reduce(union_rect)
            .unwrap_or(activity_rect)
            .intersect(search_rect)
            .unwrap_or(activity_rect);
        let score = same_row
            .iter()
            .map(|(row, _)| row.score)
            .fold(activity_row.score, f32::min);
        let candidate = TextFallbackCandidate {
            text: combined,
            score,
            rect,
        };
        if best
            .as_ref()
            .map(|current| candidate.score > current.score)
            .unwrap_or(true)
        {
            best = Some(candidate);
        }
    }
    best
}

fn text_fallback_hit_rect(
    rule: &TemplateTextFallbackRule,
    mapper: &CoordinateMapper,
    fallback_rect: Rect,
) -> Rect {
    rule.hit_roi
        .and_then(|roi| mapper.clamp_rect(mapper.rect(roi)))
        .unwrap_or(fallback_rect)
}

fn match_color_fallback_frame(
    frame: &RgbFrame,
    rule: &TemplateColorFallbackRule,
    search_rect: Rect,
) -> Option<ColorFallbackCandidate> {
    let rect = search_rect.clamp_to(frame.width, frame.height)?;
    let required = rule.count.max(1);
    let mut count = 0usize;
    for y in rect.y..rect.y + rect.height {
        for x in rect.x..rect.x + rect.width {
            let Some(pixel) = frame_pixel(frame, x as u32, y as u32) else {
                continue;
            };
            if (0..3).all(|idx| pixel[idx] >= rule.lower[idx] && pixel[idx] <= rule.upper[idx]) {
                count += 1;
                if count >= required {
                    return Some(ColorFallbackCandidate {
                        count,
                        required,
                        score: 1.0,
                        rect,
                    });
                }
            }
        }
    }
    None
}

fn match_all_color_fallbacks_frame(
    frame: &RgbFrame,
    rules: &[TemplateColorFallbackRule],
    search_rect: Rect,
) -> Option<MultiColorFallbackCandidate> {
    if rules.is_empty() {
        return None;
    }
    let mut details = Vec::new();
    let mut rect: Option<Rect> = None;
    for rule in rules {
        let candidate = match_color_fallback_frame(frame, rule, search_rect)?;
        rect = Some(
            rect.map(|item| union_rect(item, candidate.rect))
                .unwrap_or(candidate.rect),
        );
        details.push(format!("{}/{} pixels", candidate.count, candidate.required));
    }
    Some(MultiColorFallbackCandidate {
        score: 1.0,
        rect: rect.unwrap_or(search_rect),
        detail: details.join(", "),
    })
}

fn match_text_fallback_block(
    rows: &[OcrTextRow],
    rule: &TemplateTextFallbackRule,
    search_rect: Rect,
) -> Option<TextFallbackCandidate> {
    let text = sorted_ocr_text(rows);
    let normalized = normalize_text(&text);
    if normalized.is_empty() {
        return None;
    }
    let all_patterns = normalized_patterns(&rule.text_all);
    if !all_patterns
        .iter()
        .all(|pattern| normalized.contains(pattern))
    {
        return None;
    }
    let any_patterns = normalized_patterns(&rule.text_any);
    if !any_patterns.is_empty() && !normalized_contains_any(&normalized, &any_patterns) {
        return None;
    }
    let matched_rows = matching_text_fallback_rows(rows, &all_patterns, &any_patterns);
    let rect = matched_rows
        .iter()
        .filter_map(|row| row_rect(row))
        .reduce(union_rect)
        .and_then(|rect| rect.intersect(search_rect))
        .unwrap_or(search_rect);
    let score_rows = if matched_rows.is_empty() {
        rows.iter().collect::<Vec<_>>()
    } else {
        matched_rows
    };
    let score = score_rows.iter().map(|row| row.score).fold(1.0, f32::min);
    Some(TextFallbackCandidate { text, score, rect })
}

fn sorted_ocr_text(rows: &[OcrTextRow]) -> String {
    let mut rows = rows.iter().collect::<Vec<_>>();
    rows.sort_by(|left, right| {
        let left_box = left.box_rect.unwrap_or([0, 0, 0, 0]);
        let right_box = right.box_rect.unwrap_or([0, 0, 0, 0]);
        let left_row = left_box[1] / 20;
        let right_row = right_box[1] / 20;
        left_row
            .cmp(&right_row)
            .then_with(|| left_box[0].cmp(&right_box[0]))
    });
    rows.into_iter()
        .map(|row| row.text.as_str())
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

fn inventory_name_aliases(
    rules: &[(&String, &InventoryNameFallbackRule)],
) -> Vec<InventoryNameAlias> {
    let mut aliases = Vec::new();
    for (template, rule) in rules {
        let min_score = rule.min_score.unwrap_or(0.58).clamp(0.0, 1.0);
        for alias in &rule.aliases {
            let pattern = normalize_text(alias);
            if pattern.is_empty() {
                continue;
            }
            aliases.push(InventoryNameAlias {
                template: (*template).clone(),
                alias: alias.clone(),
                pattern,
                min_score,
            });
        }
    }
    aliases
}

fn inventory_grid_slots(
    mapper: &CoordinateMapper,
    grid: &InventoryGridFallbackRule,
    width: u32,
    height: u32,
) -> Vec<Rect> {
    let mut slots = Vec::new();
    for row in 0..grid.rows.max(1) {
        for column in 0..grid.columns.max(1) {
            let roi = [
                grid.left
                    .saturating_add((column as i32).saturating_mul(grid.stride_x)),
                grid.top
                    .saturating_add((row as i32).saturating_mul(grid.stride_y)),
                grid.slot_width.max(1),
                grid.slot_height.max(1),
            ];
            if let Some(rect) = mapper.rect(roi).clamp_to(width, height) {
                slots.push(rect);
            }
        }
    }
    slots
}

fn match_inventory_name_rows(
    rows: &[OcrTextRow],
    aliases: &[InventoryNameAlias],
) -> Option<InventoryNameCandidate> {
    let mut best: Option<InventoryNameCandidate> = None;
    for row in rows {
        let normalized = normalize_text(&row.text);
        if normalized.is_empty() {
            continue;
        }
        for alias in aliases {
            if row.score < alias.min_score {
                continue;
            }
            if !normalized.contains(&alias.pattern) {
                continue;
            }
            let candidate = InventoryNameCandidate {
                template: alias.template.clone(),
                alias: alias.alias.clone(),
                text: row.text.clone(),
                score: row.score,
            };
            if best
                .as_ref()
                .map(|current| candidate.score > current.score)
                .unwrap_or(true)
            {
                best = Some(candidate);
            }
        }
    }
    best
}

fn matching_text_fallback_rows<'a>(
    rows: &'a [OcrTextRow],
    all_patterns: &[String],
    any_patterns: &[String],
) -> Vec<&'a OcrTextRow> {
    let mut patterns = all_patterns
        .iter()
        .chain(any_patterns.iter())
        .collect::<Vec<_>>();
    patterns.sort();
    patterns.dedup();
    if patterns.is_empty() {
        return Vec::new();
    }
    rows.iter()
        .filter(|row| {
            let normalized = normalize_text(&row.text);
            patterns.iter().any(|pattern| normalized.contains(*pattern))
        })
        .collect()
}

fn normalized_patterns(patterns: &[String]) -> Vec<String> {
    patterns
        .iter()
        .map(|pattern| normalize_text(pattern))
        .filter(|pattern| !pattern.is_empty())
        .collect()
}

fn normalized_contains_any(text: &str, patterns: &[String]) -> bool {
    patterns.iter().any(|pattern| text.contains(pattern))
}

fn normalize_text(text: &str) -> String {
    text.chars()
        .filter(|ch| {
            !ch.is_whitespace()
                && !matches!(
                    ch,
                    '，' | ','
                        | '。'
                        | '.'
                        | '、'
                        | '：'
                        | ':'
                        | '；'
                        | ';'
                        | '！'
                        | '!'
                        | '？'
                        | '?'
                        | '（'
                        | '）'
                        | '('
                        | ')'
                        | '['
                        | ']'
                        | '【'
                        | '】'
                        | '"'
                        | '\''
                )
        })
        .collect()
}

fn text_fallback_row_window(search_rect: Rect) -> i32 {
    (search_rect.height / 8).clamp(28, 58)
}

fn row_rect(row: &OcrTextRow) -> Option<Rect> {
    row.box_rect
        .map(|item| Rect::new(item[0], item[1], item[2], item[3]))
}

fn union_rect(left: Rect, right: Rect) -> Rect {
    let x1 = left.x.min(right.x);
    let y1 = left.y.min(right.y);
    let x2 = left
        .x
        .saturating_add(left.width)
        .max(right.x.saturating_add(right.width));
    let y2 = left
        .y
        .saturating_add(left.height)
        .max(right.y.saturating_add(right.height));
    Rect::new(x1, y1, (x2 - x1).max(1), (y2 - y1).max(1))
}

fn template_scale_from_mapping(value: &Value) -> Option<TemplateScale> {
    let width = value.get("sourceFrameWidth")?.as_u64()? as u32;
    let height = value.get("sourceFrameHeight")?.as_u64()? as u32;
    Some(TemplateScale::SourceFrame { width, height })
}

fn template_variants_from_mapping(value: &Value) -> Vec<TemplateVariant> {
    let mut variants = Vec::new();
    if mapping_value_can_be_variant(value) {
        variants.push(template_variant_from_mapping(value));
    }
    if let Some(items) = value.get("variants").and_then(Value::as_array) {
        for item in items {
            if item.is_object() {
                variants.push(template_variant_from_mapping(item));
            }
        }
    }
    variants
}

fn mapping_value_can_be_variant(value: &Value) -> bool {
    value
        .get("replacementPath")
        .and_then(Value::as_str)
        .is_some()
        || value
            .get("sourceFrameWidth")
            .and_then(Value::as_u64)
            .is_some()
        || value
            .get("sourceFrameHeight")
            .and_then(Value::as_u64)
            .is_some()
        || value.get("sourceRoi").and_then(Value::as_array).is_some()
}

fn template_variant_from_mapping(value: &Value) -> TemplateVariant {
    TemplateVariant {
        replacement_path: value
            .get("replacementPath")
            .and_then(Value::as_str)
            .map(ToString::to_string),
        scale: template_scale_from_mapping(value).unwrap_or(TemplateScale::ClientPixels),
        search: template_search_from_mapping(value),
    }
}

fn template_search_from_mapping(value: &Value) -> Option<TemplateSearch> {
    let source_width = value.get("sourceFrameWidth")?.as_u64()? as u32;
    let source_height = value.get("sourceFrameHeight")?.as_u64()? as u32;
    let roi = value.get("sourceRoi")?.as_array()?;
    if roi.len() < 4 {
        return None;
    }
    Some(TemplateSearch {
        roi: [
            roi[0].as_i64()? as i32,
            roi[1].as_i64()? as i32,
            roi[2].as_i64()? as i32,
            roi[3].as_i64()? as i32,
        ],
        source_width,
        source_height,
    })
}

fn mapped_template_search_rect(search: TemplateSearch, frame: &RgbFrame) -> Option<Rect> {
    let scale_x = frame.width as f32 / search.source_width.max(1) as f32;
    let scale_y = frame.height as f32 / search.source_height.max(1) as f32;
    let x = ((search.roi[0] as f32) * scale_x).round() as i32;
    let y = ((search.roi[1] as f32) * scale_y).round() as i32;
    let width = ((search.roi[2].max(1) as f32) * scale_x).round().max(1.0) as i32;
    let height = ((search.roi[3].max(1) as f32) * scale_y).round().max(1.0) as i32;
    let padding = ((width.max(height) as f32) * 0.35).round().max(6.0) as i32;
    Rect::new(
        x.saturating_sub(padding),
        y.saturating_sub(padding),
        width.saturating_add(padding * 2),
        height.saturating_add(padding * 2),
    )
    .clamp_to(frame.width, frame.height)
}

fn match_template(
    frame: &RgbFrame,
    search_rect: Rect,
    template: &TemplateImage,
    threshold: f32,
    green_mask: bool,
) -> Option<(Rect, f32)> {
    let max_x = search_rect.x + search_rect.width - template.width as i32;
    let max_y = search_rect.y + search_rect.height - template.height as i32;
    if max_x < search_rect.x || max_y < search_rect.y {
        return None;
    }
    let mut best_score = 0.0f32;
    let mut best_rect = None;
    for y in search_rect.y..=max_y {
        for x in search_rect.x..=max_x {
            let score = template_score(frame, x as u32, y as u32, template, green_mask);
            if score > best_score {
                best_score = score;
                best_rect = Some(Rect::new(
                    x,
                    y,
                    template.width as i32,
                    template.height as i32,
                ));
            }
        }
    }
    (best_score >= threshold).then_some((best_rect?, best_score))
}

fn template_score(
    frame: &RgbFrame,
    left: u32,
    top: u32,
    template: &TemplateImage,
    green_mask: bool,
) -> f32 {
    let mut diff = 0u64;
    let mut channels = 0u64;
    for ty in 0..template.height {
        let frame_start = (((top + ty) * frame.width + left) * 3) as usize;
        let template_start = (ty * template.width * 3) as usize;
        for tx in 0..template.width {
            let fi = frame_start + tx as usize * 3;
            let ti = template_start + tx as usize * 3;
            let template_pixel = [
                template.pixels[ti],
                template.pixels[ti + 1],
                template.pixels[ti + 2],
            ];
            if green_mask && is_mask_green(template_pixel) {
                continue;
            }
            diff += (frame.pixels[fi] as i16 - template_pixel[0] as i16).unsigned_abs() as u64;
            diff += (frame.pixels[fi + 1] as i16 - template_pixel[1] as i16).unsigned_abs() as u64;
            diff += (frame.pixels[fi + 2] as i16 - template_pixel[2] as i16).unsigned_abs() as u64;
            channels += 3;
        }
    }
    if channels == 0 {
        return 0.0;
    }
    1.0 - (diff as f32 / (channels as f32 * 255.0))
}

fn is_mask_green(pixel: [u8; 3]) -> bool {
    pixel[1] > 180 && pixel[0] < 100 && pixel[2] < 100
}

pub fn crop_frame(frame: &RgbFrame, rect: Rect) -> Result<RgbFrame, String> {
    let rect = rect
        .clamp_to(frame.width, frame.height)
        .ok_or_else(|| "crop rect outside frame".to_string())?;
    let mut pixels = Vec::with_capacity(rect.width as usize * rect.height as usize * 3);
    for y in rect.y as u32..(rect.y + rect.height) as u32 {
        let start = ((y * frame.width + rect.x as u32) * 3) as usize;
        let end = start + rect.width as usize * 3;
        pixels.extend_from_slice(&frame.pixels[start..end]);
    }
    Ok(RgbFrame {
        width: rect.width as u32,
        height: rect.height as u32,
        pixels,
        capture_source: frame.capture_source,
    })
}

fn frame_pixel(frame: &RgbFrame, x: u32, y: u32) -> Option<[u8; 3]> {
    if x >= frame.width || y >= frame.height {
        return None;
    }
    let index = ((y * frame.width + x) * 3) as usize;
    Some([
        frame.pixels[index],
        frame.pixels[index + 1],
        frame.pixels[index + 2],
    ])
}

fn parse_rgb(value: Option<&Value>) -> Option<[u8; 3]> {
    let items = value?.as_array()?;
    if items.len() < 3 {
        return None;
    }
    Some([
        items[0].as_u64()? as u8,
        items[1].as_u64()? as u8,
        items[2].as_u64()? as u8,
    ])
}

fn parse_i32_4(items: &[Value]) -> Option<[i32; 4]> {
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

fn apply_replacements(text: &str, replacements: &[(String, String)]) -> String {
    replacements
        .iter()
        .fold(text.to_string(), |acc, (from, to)| acc.replace(from, to))
}

fn expected_matches(text: &str, expected: &[String]) -> bool {
    if expected.is_empty() {
        return !text.trim().is_empty();
    }
    expected.iter().any(|item| {
        if item.is_empty() {
            return !text.trim().is_empty();
        }
        Regex::new(item)
            .map(|regex| regex.is_match(text))
            .unwrap_or_else(|_| text.contains(item))
    })
}

#[derive(Debug, Clone)]
struct AiAnswerOption {
    label: &'static str,
    text: String,
    roi: [i32; 4],
}

fn query_openai_compatible_answer(
    node: &Value,
    question: &str,
    answers: &[AiAnswerOption],
) -> Result<String, String> {
    let attach = node
        .get("attach")
        .and_then(Value::as_object)
        .ok_or_else(|| "missing attach config".to_string())?;
    let api_key = attach
        .get("apikey")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing apikey".to_string())?;
    let url = attach
        .get("url")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing url".to_string())?;
    let model = attach
        .get("model")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing model".to_string())?;
    post_chat_completion(url, api_key, model, &ai_prompt(question, answers))
}

fn query_zhipu_answer(
    node: &Value,
    question: &str,
    answers: &[AiAnswerOption],
) -> Result<String, String> {
    let api_key = node
        .get("attach")
        .and_then(Value::as_object)
        .and_then(|attach| attach.get("apikey"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "missing zhipu apikey".to_string())?;
    post_chat_completion(
        "https://open.bigmodel.cn/api/paas/v4/chat/completions",
        api_key,
        "GLM-4-Flash-250414",
        &ai_prompt(question, answers),
    )
}

fn post_chat_completion(
    url: &str,
    api_key: &str,
    model: &str,
    prompt: &str,
) -> Result<String, String> {
    let client = Client::builder()
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|err| err.to_string())?;
    let response = client
        .post(url)
        .header(CONTENT_TYPE, "application/json")
        .header(AUTHORIZATION, format!("Bearer {api_key}"))
        .json(&json!({
            "model": model,
            "messages": [
                { "role": "system", "content": "You answer multiple-choice game quiz questions. Reply with only one letter: A, B, C, or D." },
                { "role": "user", "content": prompt }
            ],
            "temperature": 0.2,
            "max_tokens": 10,
            "stream": false
        }))
        .send()
        .map_err(|err| format!("request failed: {err}"))?;
    let status = response.status();
    let body: Value = response
        .json()
        .map_err(|err| format!("invalid JSON response from {url}: {err}"))?;
    if !status.is_success() {
        return Err(format!("HTTP {status}: {body}"));
    }
    body.get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .ok_or_else(|| format!("missing choices[0].message.content: {body}"))
}

fn ai_prompt(question: &str, answers: &[AiAnswerOption]) -> String {
    let mut prompt = format!(
        "问题：{}\n请从以下选项中选择一个最正确的答案，并只返回选项字母 A、B、C 或 D。\n",
        question.trim()
    );
    for answer in answers {
        if !answer.text.trim().is_empty() {
            prompt.push_str(&format!("{}: {}\n", answer.label, answer.text.trim()));
        }
    }
    prompt
}

fn choose_ai_answer(response: &str, answers: &[AiAnswerOption]) -> Option<&'static str> {
    let upper = response.trim().to_uppercase();
    for ch in upper.chars() {
        match ch {
            'A' => return Some("A"),
            'B' => return Some("B"),
            'C' => return Some("C"),
            'D' => return Some("D"),
            _ => {}
        }
    }
    answers
        .iter()
        .find(|answer| {
            let text = answer.text.trim();
            !text.is_empty() && response.contains(text)
        })
        .map(|answer| answer.label)
}

fn format_ai_answers(answers: &[AiAnswerOption]) -> String {
    answers
        .iter()
        .map(|answer| format!("{}:{}", answer.label, answer.text))
        .collect::<Vec<_>>()
        .join(" | ")
}

#[derive(Debug, Clone)]
struct QuestionSearch {
    answers: Vec<String>,
    confidence: i32,
    match_type: String,
}

fn sort_ocr_rows(mut rows: Vec<OcrTextRow>) -> Vec<OcrTextRow> {
    rows.sort_by(|left, right| {
        let left_box = left.box_rect.unwrap_or([0, 0, 0, 0]);
        let right_box = right.box_rect.unwrap_or([0, 0, 0, 0]);
        let left_row = left_box[1] / 20;
        let right_row = right_box[1] / 20;
        left_row
            .cmp(&right_row)
            .then_with(|| left_box[0].cmp(&right_box[0]))
    });
    rows
}

fn join_ocr_rows(rows: Vec<OcrTextRow>) -> String {
    rows.into_iter()
        .map(|row| row.text)
        .filter(|text| !text.trim().is_empty())
        .collect::<Vec<_>>()
        .join("")
}

fn first_i32(text: &str) -> Option<i32> {
    Regex::new(r"\d+")
        .ok()?
        .find(text)
        .and_then(|item| item.as_str().parse::<i32>().ok())
}

fn clean_question_text(text: &str) -> String {
    Regex::new(r"第\d+题：|[（(]\d+/\d+[）)]")
        .map(|regex| regex.replace_all(text, "").trim().to_string())
        .unwrap_or_else(|_| text.trim().to_string())
}

fn search_question_bank(maa_root: &Path, query: &str) -> QuestionSearch {
    let bank = load_question_bank(maa_root);
    let normalized_query = normalize_question(query);
    if normalized_query.is_empty() || bank.is_empty() {
        return QuestionSearch {
            answers: Vec::new(),
            confidence: 0,
            match_type: "题库为空或题目为空".to_string(),
        };
    }

    for (question, answers) in &bank {
        if normalized_query == normalize_question(question) {
            return QuestionSearch {
                answers: answers.clone(),
                confidence: 100,
                match_type: "精确匹配".to_string(),
            };
        }
    }

    let mut best_question = String::new();
    let mut best_score = 0;
    for question in bank.keys() {
        let score = similarity_percent(&normalized_query, &normalize_question(question));
        if score > best_score {
            best_score = score;
            best_question = question.clone();
        }
    }
    let answers = bank.get(&best_question).cloned().unwrap_or_default();
    QuestionSearch {
        answers,
        confidence: best_score,
        match_type: if best_score >= 70 {
            "相似度匹配".to_string()
        } else {
            "低于阈值".to_string()
        },
    }
}

fn load_question_bank(maa_root: &Path) -> BTreeMap<String, Vec<String>> {
    let path = maa_root
        .join("agent")
        .join("custom")
        .join("recognition")
        .join("tiku.txt");
    let Ok(content) = fs::read_to_string(path) else {
        return BTreeMap::new();
    };
    let Ok(question_regex) = Regex::new(r#""\s*([^"]+)\s*"\s*:\s*\[\s*([^\]]*?)\s*\]"#) else {
        return BTreeMap::new();
    };
    let Ok(answer_regex) = Regex::new(r#""([^"]+)""#) else {
        return BTreeMap::new();
    };
    let mut bank = BTreeMap::new();
    for capture in question_regex.captures_iter(&content) {
        let Some(question) = capture.get(1).map(|item| item.as_str().trim().to_string()) else {
            continue;
        };
        let answer_blob = capture.get(2).map(|item| item.as_str()).unwrap_or_default();
        let mut answers = Vec::new();
        for answer_capture in answer_regex.captures_iter(answer_blob) {
            if let Some(answer) = answer_capture.get(1) {
                for part in answer.as_str().split('，') {
                    let part = part.trim().trim_matches('"');
                    if !part.is_empty() {
                        answers.push(part.to_string());
                    }
                }
            }
        }
        if !question.is_empty() && !answers.is_empty() {
            bank.insert(question, answers);
        }
    }
    bank
}

fn normalize_question(text: &str) -> String {
    text.chars()
        .filter(|ch| {
            !ch.is_whitespace()
                && !matches!(
                    ch,
                    '，' | ','
                        | '、'
                        | '。'
                        | '！'
                        | '？'
                        | '?'
                        | '!'
                        | '：'
                        | ':'
                        | '；'
                        | ';'
                        | '“'
                        | '”'
                        | '"'
                        | '\''
                        | '（'
                        | '）'
                        | '('
                        | ')'
                        | '【'
                        | '】'
                        | '['
                        | ']'
                        | '-'
                        | '·'
                        | '—'
                        | '…'
                )
        })
        .flat_map(char::to_lowercase)
        .collect()
}

fn similarity_percent(left: &str, right: &str) -> i32 {
    let left_chars = left.chars().collect::<Vec<_>>();
    let right_chars = right.chars().collect::<Vec<_>>();
    if left_chars.is_empty() || right_chars.is_empty() {
        return 0;
    }
    let mut previous = vec![0usize; right_chars.len() + 1];
    let mut current = vec![0usize; right_chars.len() + 1];
    for left_ch in &left_chars {
        for (index, right_ch) in right_chars.iter().enumerate() {
            current[index + 1] = if left_ch == right_ch {
                previous[index] + 1
            } else {
                previous[index + 1].max(current[index])
            };
        }
        std::mem::swap(&mut previous, &mut current);
        current.fill(0);
    }
    let lcs = previous[right_chars.len()] as f32;
    ((2.0 * lcs / (left_chars.len() + right_chars.len()) as f32) * 100.0).round() as i32
}

pub fn merge_objects(base: &Value, overlay: &Value) -> Value {
    match (base.as_object(), overlay.as_object()) {
        (Some(base), Some(overlay)) => {
            let mut merged = Map::new();
            for (key, value) in base {
                merged.insert(key.clone(), value.clone());
            }
            for (key, value) in overlay {
                let merged_value = merged
                    .get(key)
                    .map(|base_value| merge_objects(base_value, value))
                    .unwrap_or_else(|| value.clone());
                merged.insert(key.clone(), merged_value);
            }
            Value::Object(merged)
        }
        _ => overlay.clone(),
    }
}

pub fn rect_from_value(value: &Value, mapper: CoordinateMapper) -> Option<Rect> {
    value
        .as_array()
        .and_then(|items| parse_i32_4(items))
        .map(|roi| mapper.rect(roi))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::coords::CoordinateMode;
    use serde_json::json;

    #[test]
    fn merge_objects_recursively_preserves_nested_pipeline_fields() {
        let base = json!({
            "action": "Custom",
            "custom_action_param": {
                "LoopNode": "loop",
                "nextTask": "done",
                "target_count": 2
            }
        });
        let overlay = json!({
            "custom_action_param": {
                "target_count": 5
            }
        });
        let merged = merge_objects(&base, &overlay);
        assert_eq!(merged["action"], "Custom");
        assert_eq!(merged["custom_action_param"]["LoopNode"], "loop");
        assert_eq!(merged["custom_action_param"]["nextTask"], "done");
        assert_eq!(merged["custom_action_param"]["target_count"], 5);
    }

    #[test]
    fn direct_hit_recognition_passes_without_vision_requirements() {
        let frame = RgbFrame {
            width: 4,
            height: 3,
            pixels: vec![0; 4 * 3 * 3],
            capture_source: crate::platform::CaptureSource::ImageFile,
        };
        let boxes = BTreeMap::new();
        let mut ocr_backend = None;
        let mut vision = VisionContext::new(
            Path::new("."),
            Path::new("."),
            &frame,
            CoordinateMapper::new(frame.width, frame.height, CoordinateMode::default()),
            &boxes,
            0,
            true,
            &mut ocr_backend,
        );

        let hit = vision.recognize(
            "直接执行节点",
            &json!({ "recognition": "DirectHit" }),
            &BTreeMap::new(),
        );

        assert!(hit.hit);
        assert_eq!(hit.kind, "DirectHit");
    }

    #[test]
    fn choose_ai_answer_extracts_letter_or_matching_answer_text() {
        let answers = vec![
            AiAnswerOption {
                label: "A",
                text: "东海湾".to_string(),
                roi: [0, 0, 1, 1],
            },
            AiAnswerOption {
                label: "B",
                text: "长安城".to_string(),
                roi: [0, 0, 1, 1],
            },
        ];
        assert_eq!(choose_ai_answer("答案是 B。", &answers), Some("B"));
        assert_eq!(choose_ai_answer("长安城", &answers), Some("B"));
        assert_eq!(choose_ai_answer("不知道", &answers), None);
    }

    #[test]
    fn scales_replacement_templates_from_source_frame() {
        let template = TemplateImage {
            width: 40,
            height: 20,
            pixels: vec![0; 40 * 20 * 3],
        };
        let mapper = CoordinateMapper::new(828, 666, crate::coords::CoordinateMode::CropCenter4x3);

        let replacement = scale_template_for_frame(
            &template,
            mapper,
            1656,
            1332,
            TemplateScale::SourceFrame {
                width: 828,
                height: 666,
            },
        );
        assert_eq!(replacement.width, 80);
        assert_eq!(replacement.height, 40);

        let baseline =
            scale_template_for_frame(&template, mapper, 828, 666, TemplateScale::Baseline);
        assert_eq!(baseline.width, 35);
        assert_eq!(baseline.height, 19);
    }

    #[test]
    fn template_mapping_expands_top_level_and_variant_entries() {
        let mapping = json!({
            "replacementPath": "assets/resource/ShiKong/image/a.png",
            "sourceRoi": [10, 20, 30, 40],
            "sourceFrameWidth": 800,
            "sourceFrameHeight": 600,
            "variants": [
                {
                    "name": "small-window",
                    "replacementPath": "assets/resource/ShiKong/image_variants/a-small.png",
                    "sourceRoi": [1, 2, 3, 4],
                    "sourceFrameWidth": 400,
                    "sourceFrameHeight": 300
                }
            ]
        });

        let variants = template_variants_from_mapping(&mapping);
        assert_eq!(variants.len(), 2);
        assert_eq!(
            variants[0].replacement_path.as_deref(),
            Some("assets/resource/ShiKong/image/a.png")
        );
        assert!(matches!(
            variants[0].scale,
            TemplateScale::SourceFrame {
                width: 800,
                height: 600
            }
        ));
        assert_eq!(variants[0].search.expect("search").roi, [10, 20, 30, 40]);
        assert_eq!(
            variants[1].replacement_path.as_deref(),
            Some("assets/resource/ShiKong/image_variants/a-small.png")
        );
        assert!(matches!(
            variants[1].scale,
            TemplateScale::SourceFrame {
                width: 400,
                height: 300
            }
        ));
        assert_eq!(variants[1].search.expect("search").roi, [1, 2, 3, 4]);
    }

    #[test]
    fn runtime_gap_hint_only_marks_known_scene_gaps() {
        let hint = runtime_gap_hint(&["wujian/mz/mz_mubiao_diban.png".to_string()])
            .expect("maze floor hint");
        assert!(hint.contains("known runtime gap"));
        assert!(hint.contains("帮派迷阵"));

        assert!(runtime_gap_hint(&["zonghe/jiahao.png".to_string()]).is_none());
    }

    #[test]
    fn text_fallback_matches_activity_and_status_in_same_column() {
        let rows = vec![
            ocr_row("宝图任务", 0.99, [244, 265, 70, 22]),
            ocr_row("次数0/10 活跃0/10", 0.97, [243, 294, 121, 18]),
            ocr_row("参加", 0.99, [382, 283, 42, 25]),
            ocr_row("运镖", 0.99, [512, 265, 41, 23]),
            ocr_row("参加", 0.99, [653, 283, 40, 25]),
        ];
        let rule = TemplateTextFallbackRule {
            activity: vec!["宝图任务".to_string()],
            status_any: vec!["参加".to_string()],
            text_all: Vec::new(),
            text_any: Vec::new(),
            default_roi: None,
            hit_roi: None,
            color: None,
            colors: Vec::new(),
            inventory_name: None,
        };

        let hit = match_text_fallback_rows(&rows, &rule, Rect::new(124, 60, 663, 360))
            .expect("fallback hit");

        assert!(hit.text.contains("宝图任务"));
        assert!(hit.text.contains("参加"));
        assert!(hit.rect.x <= 244);
        assert!(hit.rect.x + hit.rect.width >= 424);
    }

    #[test]
    fn text_fallback_does_not_borrow_status_from_other_activity_column() {
        let rows = vec![
            ocr_row("科举乡试", 0.99, [242, 115, 73, 24]),
            ocr_row("17:00开启", 0.99, [359, 115, 69, 21]),
            ocr_row("师门任务", 0.99, [513, 115, 71, 22]),
            ocr_row("参加", 0.99, [653, 109, 40, 24]),
        ];
        let rule = TemplateTextFallbackRule {
            activity: vec!["科举乡试".to_string()],
            status_any: vec!["参加".to_string()],
            text_all: Vec::new(),
            text_any: Vec::new(),
            default_roi: None,
            hit_roi: None,
            color: None,
            colors: Vec::new(),
            inventory_name: None,
        };

        let hit = match_text_fallback_rows(&rows, &rule, Rect::new(124, 60, 663, 360));

        assert!(hit.is_none());
    }

    #[test]
    fn text_fallback_matches_not_started_status_text() {
        let rows = vec![
            ocr_row("科举乡试", 0.99, [242, 115, 73, 24]),
            ocr_row("17:00开启", 0.99, [359, 115, 69, 21]),
        ];
        let rule = TemplateTextFallbackRule {
            activity: vec!["科举乡试".to_string()],
            status_any: vec!["开启".to_string()],
            text_all: Vec::new(),
            text_any: Vec::new(),
            default_roi: None,
            hit_roi: None,
            color: None,
            colors: Vec::new(),
            inventory_name: None,
        };

        let hit = match_text_fallback_rows(&rows, &rule, Rect::new(124, 60, 663, 360))
            .expect("fallback hit");

        assert!(hit.text.contains("17:00开启"));
    }

    #[test]
    fn text_fallback_block_requires_all_and_one_any_pattern() {
        let rows = vec![
            ocr_row("师门任务完成", 0.98, [330, 180, 180, 28]),
            ocr_row("点击确定继续", 0.96, [360, 230, 100, 24]),
        ];
        let rule = TemplateTextFallbackRule {
            activity: Vec::new(),
            status_any: Vec::new(),
            text_all: vec!["师门".to_string(), "完成".to_string()],
            text_any: vec!["确定".to_string(), "取消".to_string()],
            default_roi: None,
            hit_roi: None,
            color: None,
            colors: Vec::new(),
            inventory_name: None,
        };
        let search_rect = Rect::new(250, 120, 300, 160);

        let hit = match_text_fallback_rows(&rows, &rule, search_rect).expect("fallback hit");

        assert_eq!(hit.rect, Rect::new(330, 180, 180, 74));
        assert!(hit.text.contains("师门任务完成"));
        assert!(hit.text.contains("点击确定继续"));
    }

    #[test]
    fn text_fallback_hit_roi_overrides_matched_text_rect() {
        let rule = TemplateTextFallbackRule {
            activity: Vec::new(),
            status_any: Vec::new(),
            text_all: vec!["选择召唤灵".to_string()],
            text_any: vec!["确定".to_string()],
            default_roi: None,
            hit_roi: Some([473, 163, 94, 100]),
            color: None,
            colors: Vec::new(),
            inventory_name: None,
        };
        let mapper = CoordinateMapper::new(960, 720, CoordinateMode::CropCenter4x3);
        let text_rect = Rect::new(340, 75, 620, 546);

        let hit_rect = text_fallback_hit_rect(&rule, &mapper, text_rect);

        assert_eq!(hit_rect, Rect::new(313, 163, 94, 100));
    }

    #[test]
    fn text_fallback_block_misses_when_required_text_is_absent() {
        let rows = vec![ocr_row("点击确定继续", 0.96, [560, 230, 110, 24])];
        let rule = TemplateTextFallbackRule {
            activity: Vec::new(),
            status_any: Vec::new(),
            text_all: vec!["师门".to_string(), "完成".to_string()],
            text_any: vec!["确定".to_string()],
            default_roi: None,
            hit_roi: None,
            color: None,
            colors: Vec::new(),
            inventory_name: None,
        };

        let hit = match_text_fallback_rows(&rows, &rule, Rect::new(250, 120, 300, 160));

        assert!(hit.is_none());
    }

    #[test]
    fn inventory_grid_slots_scale_to_current_bag_panel() {
        let mapper = CoordinateMapper::new(763, 573, CoordinateMode::CropCenter4x3);
        let slots = inventory_grid_slots(&mapper, &InventoryGridFallbackRule::default(), 763, 573);

        assert_eq!(slots.len(), 30);
        assert_eq!(slots[0], Rect::new(386, 151, 49, 49));
        assert_eq!(slots[1], Rect::new(437, 151, 49, 49));
        assert_eq!(slots[6], Rect::new(386, 211, 49, 49));
    }

    #[test]
    fn inventory_name_rows_respect_aliases_and_min_score() {
        let template = "mijing_cailiao/bulaogen.png".to_string();
        let rule = InventoryNameFallbackRule {
            aliases: vec!["不老根".to_string()],
            min_score: Some(0.7),
            grid: None,
            detail_roi: None,
            slot_delay_ms: None,
        };
        let aliases = inventory_name_aliases(&[(&template, &rule)]);
        let rows = vec![
            ocr_row("不老根", 0.62, [120, 80, 60, 24]),
            ocr_row("获得 不老根", 0.93, [120, 110, 120, 24]),
        ];

        let hit = match_inventory_name_rows(&rows, &aliases).expect("inventory name hit");

        assert_eq!(hit.template, template);
        assert_eq!(hit.alias, "不老根");
        assert_eq!(hit.score, 0.93);
        assert!(match_inventory_name_rows(&rows[..1], &aliases).is_none());
    }

    #[test]
    fn color_fallback_counts_pixels_inside_search_rect() {
        let mut frame = RgbFrame {
            width: 10,
            height: 10,
            pixels: vec![0; 10 * 10 * 3],
            capture_source: crate::platform::CaptureSource::ImageFile,
        };
        for (x, y) in [(3u32, 3u32), (4, 3), (5, 4)] {
            let index = ((y * frame.width + x) * 3) as usize;
            frame.pixels[index..index + 3].copy_from_slice(&[230, 55, 25]);
        }
        let rule = TemplateColorFallbackRule {
            lower: [200, 30, 0],
            upper: [255, 90, 60],
            count: 3,
        };

        let hit = match_color_fallback_frame(&frame, &rule, Rect::new(2, 2, 5, 4))
            .expect("color fallback hit");

        assert_eq!(hit.count, 3);
        assert_eq!(hit.required, 3);
        assert_eq!(hit.rect, Rect::new(2, 2, 5, 4));
        assert!(match_color_fallback_frame(&frame, &rule, Rect::new(0, 0, 2, 2)).is_none());
    }

    #[test]
    fn multi_color_fallback_requires_every_range() {
        let mut frame = RgbFrame {
            width: 12,
            height: 8,
            pixels: vec![0; 12 * 8 * 3],
            capture_source: crate::platform::CaptureSource::ImageFile,
        };
        for (x, y, pixel) in [
            (2u32, 2u32, [155u8, 92u8, 45u8]),
            (3, 2, [160, 88, 42]),
            (7, 4, [0, 245, 25]),
            (8, 4, [15, 255, 35]),
        ] {
            let index = ((y * frame.width + x) * 3) as usize;
            frame.pixels[index..index + 3].copy_from_slice(&pixel);
        }
        let heart = TemplateColorFallbackRule {
            lower: [120, 55, 20],
            upper: [190, 125, 80],
            count: 2,
        };
        let green_bar = TemplateColorFallbackRule {
            lower: [0, 220, 0],
            upper: [70, 255, 80],
            count: 2,
        };
        let missing_blue = TemplateColorFallbackRule {
            lower: [0, 0, 200],
            upper: [50, 50, 255],
            count: 1,
        };

        let hit = match_all_color_fallbacks_frame(
            &frame,
            &[heart.clone(), green_bar.clone()],
            Rect::new(0, 0, 12, 8),
        )
        .expect("multi-color hit");

        assert!(hit.detail.contains("2/2 pixels"));
        assert!(match_all_color_fallbacks_frame(
            &frame,
            &[heart, missing_blue],
            Rect::new(0, 0, 12, 8)
        )
        .is_none());
    }

    fn ocr_row(text: &str, score: f32, rect: [i32; 4]) -> OcrTextRow {
        OcrTextRow {
            text: text.to_string(),
            score,
            box_rect: Some(rect),
        }
    }
}
