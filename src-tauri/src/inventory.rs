use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::Path,
};
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaaTask {
    pub id: String,
    pub name: String,
    pub entry: String,
    pub pipeline: Option<String>,
    pub options: Vec<String>,
    pub description: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateRef {
    pub id: String,
    pub template: String,
    pub pipeline: String,
    pub node: String,
    pub roi: Option<[i32; 4]>,
    pub replacement_path: Option<String>,
    pub replacement_source_space: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MaaInventory {
    pub tasks: Vec<MaaTask>,
    pub templates: Vec<TemplateRef>,
    pub option_definitions: BTreeMap<String, Value>,
    pub presets: Vec<Value>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateCoverageReport {
    pub total_refs: usize,
    pub unique_templates: usize,
    pub replaced_refs: usize,
    pub unreplaced_refs: usize,
    pub replaced_templates: usize,
    pub unreplaced_templates: usize,
    pub source_space_counts: BTreeMap<String, usize>,
    pub domains: Vec<CoverageBucket>,
    pub pipelines: Vec<CoverageBucket>,
    pub tasks: Vec<CoverageBucket>,
    pub templates: Vec<TemplateCoverageTemplate>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageBucket {
    pub name: String,
    pub total_refs: usize,
    pub replaced_refs: usize,
    pub unreplaced_refs: usize,
    pub unique_templates: usize,
    pub replaced_templates: usize,
    pub unreplaced_templates: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateCoverageTemplate {
    pub template: String,
    pub total_refs: usize,
    pub replaced: bool,
    pub source_space: Option<String>,
    pub replacement_path: Option<String>,
    pub priority: usize,
    pub domains: Vec<String>,
    pub pipelines: Vec<String>,
    pub tasks: Vec<String>,
    pub nodes: Vec<String>,
    pub rois: Vec<[i32; 4]>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineCompatReport {
    pub pipeline_files: usize,
    pub node_definitions: usize,
    pub interface_tasks: usize,
    pub task_entries_found: usize,
    pub task_entries_missing: Vec<String>,
    pub presets: usize,
    pub preset_task_refs: usize,
    pub preset_task_refs_missing: Vec<String>,
    pub node_refs: usize,
    pub missing_node_refs: Vec<CompatRefIssue>,
    pub recognition_types: Vec<CompatCounter>,
    pub action_types: Vec<CompatCounter>,
    pub custom_recognitions: Vec<CompatCounter>,
    pub custom_actions: Vec<CompatCounter>,
    pub pipelines: Vec<PipelineCompatSummary>,
    pub issues: Vec<CompatIssue>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatCounter {
    pub name: String,
    pub count: usize,
    pub status: String,
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatIssue {
    pub category: String,
    pub name: String,
    pub status: String,
    pub count: usize,
    pub detail: String,
    pub examples: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatRefIssue {
    pub from_pipeline: String,
    pub from_node: String,
    pub field: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PipelineCompatSummary {
    pub pipeline: String,
    pub node_count: usize,
    pub task_entries: Vec<String>,
    pub recognition_types: Vec<String>,
    pub action_types: Vec<String>,
    pub custom_recognitions: Vec<String>,
    pub custom_actions: Vec<String>,
    pub template_refs: usize,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TemplateCaptureResult {
    pub saved_path: String,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug, Deserialize)]
struct InterfaceTask {
    name: String,
    entry: String,
    #[serde(default, rename = "option")]
    options: Vec<String>,
    #[serde(default)]
    description: Option<String>,
}

pub fn load_inventory(root: &Path, project_root: Option<&Path>) -> Result<MaaInventory, String> {
    let interface_path = root.join("assets").join("interface.json");
    let interface: Value = read_json(&interface_path)?;
    let tasks: Vec<InterfaceTask> = serde_json::from_value(
        interface
            .get("task")
            .cloned()
            .ok_or_else(|| "interface.json missing task".to_string())?,
    )
    .map_err(|err| err.to_string())?;

    let pipeline_root = root.join("assets").join("resource");
    let mut node_to_pipeline = BTreeMap::<String, String>::new();
    let mut templates = Vec::<TemplateRef>::new();
    let mut seen_templates = BTreeSet::<String>::new();

    for entry in WalkDir::new(&pipeline_root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| {
            entry.path().extension().and_then(|value| value.to_str()) == Some("json")
                && entry
                    .path()
                    .components()
                    .any(|part| part.as_os_str() == "pipeline")
        })
    {
        let path = entry.path();
        let rel = slash_path(path.strip_prefix(root).unwrap_or(path));
        let data: Value = read_json(path)?;
        let Some(nodes) = data.as_object() else {
            continue;
        };
        for (node, value) in nodes {
            node_to_pipeline.entry(node.clone()).or_insert(rel.clone());
            collect_templates(value, None, &rel, node, &mut templates, &mut seen_templates);
        }
    }

    let tasks = tasks
        .into_iter()
        .enumerate()
        .map(|(index, task)| MaaTask {
            id: format!("{}|{}|{}", index + 1, task.name, task.entry),
            pipeline: node_to_pipeline.get(&task.entry).cloned(),
            name: task.name,
            entry: task.entry,
            options: task.options,
            description: task.description,
        })
        .collect();

    let mapping = project_root
        .map(load_template_mapping)
        .transpose()?
        .unwrap_or_default();
    for template in &mut templates {
        if let Some(mapped) = mapping.get(&template.template) {
            template.replacement_path = mapping_first_string(mapped, "replacementPath");
            template.replacement_source_space = mapping_first_string(mapped, "sourceSpace");
        }
    }

    templates.sort_by(|left, right| {
        left.template
            .cmp(&right.template)
            .then_with(|| left.pipeline.cmp(&right.pipeline))
            .then_with(|| left.node.cmp(&right.node))
    });

    let option_definitions = interface
        .get("option")
        .and_then(Value::as_object)
        .map(|map| {
            map.iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default();
    let presets = interface
        .get("preset")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();

    Ok(MaaInventory {
        tasks,
        templates,
        option_definitions,
        presets,
    })
}

pub fn build_template_coverage_report(inventory: &MaaInventory) -> TemplateCoverageReport {
    let mut source_space_counts = BTreeMap::<String, usize>::new();
    let mut domain_buckets = BTreeMap::<String, BucketAcc>::new();
    let mut pipeline_buckets = BTreeMap::<String, BucketAcc>::new();
    let mut task_buckets = BTreeMap::<String, BucketAcc>::new();
    let mut template_groups = BTreeMap::<String, TemplateAcc>::new();
    let mut unique_templates = BTreeSet::<String>::new();
    let mut replaced_templates = BTreeSet::<String>::new();
    let mut tasks_by_pipeline = BTreeMap::<String, Vec<String>>::new();

    for task in &inventory.tasks {
        if let Some(pipeline) = &task.pipeline {
            tasks_by_pipeline
                .entry(pipeline.clone())
                .or_default()
                .push(format!("{} ({})", task.name, task.entry));
        }
    }

    let mut replaced_refs = 0usize;
    for template in &inventory.templates {
        let replaced = template.replacement_path.is_some();
        if replaced {
            replaced_refs += 1;
            replaced_templates.insert(template.template.clone());
        }
        unique_templates.insert(template.template.clone());

        let source_space = template
            .replacement_source_space
            .as_deref()
            .unwrap_or("unreplaced")
            .to_string();
        *source_space_counts.entry(source_space.clone()).or_default() += 1;

        let domain = template_domain(&template.template);
        domain_buckets
            .entry(domain.clone())
            .or_default()
            .insert(&template.template, replaced);
        pipeline_buckets
            .entry(template.pipeline.clone())
            .or_default()
            .insert(&template.template, replaced);

        let task_names = tasks_by_pipeline
            .get(&template.pipeline)
            .cloned()
            .unwrap_or_else(|| vec!["(no direct task)".to_string()]);
        for task_name in &task_names {
            task_buckets
                .entry(task_name.clone())
                .or_default()
                .insert(&template.template, replaced);
        }

        let group = template_groups
            .entry(template.template.clone())
            .or_default();
        group.total_refs += 1;
        group.replaced |= replaced;
        if group.source_space.is_none() {
            group.source_space = template.replacement_source_space.clone();
        }
        if group.replacement_path.is_none() {
            group.replacement_path = template.replacement_path.clone();
        }
        group.domains.insert(domain);
        group.pipelines.insert(template.pipeline.clone());
        group.nodes.insert(template.node.clone());
        for task_name in task_names {
            group.tasks.insert(task_name);
        }
        if let Some(roi) = template.roi {
            group.rois.insert(roi);
        }
    }

    let unique_template_count = unique_templates.len();
    let replaced_template_count = replaced_templates.len();
    let mut templates: Vec<TemplateCoverageTemplate> = template_groups
        .into_iter()
        .map(|(template, group)| {
            let priority = template_priority(&template, &group);
            TemplateCoverageTemplate {
                template,
                total_refs: group.total_refs,
                replaced: group.replaced,
                source_space: group.source_space,
                replacement_path: group.replacement_path,
                priority,
                domains: group.domains.into_iter().collect(),
                pipelines: group.pipelines.into_iter().collect(),
                tasks: group.tasks.into_iter().collect(),
                nodes: group.nodes.into_iter().collect(),
                rois: group.rois.into_iter().collect(),
            }
        })
        .collect();

    templates.sort_by(|left, right| {
        left.replaced
            .cmp(&right.replaced)
            .then_with(|| right.priority.cmp(&left.priority))
            .then_with(|| left.template.cmp(&right.template))
    });

    TemplateCoverageReport {
        total_refs: inventory.templates.len(),
        unique_templates: unique_template_count,
        replaced_refs,
        unreplaced_refs: inventory.templates.len().saturating_sub(replaced_refs),
        replaced_templates: replaced_template_count,
        unreplaced_templates: unique_template_count.saturating_sub(replaced_template_count),
        source_space_counts,
        domains: sorted_buckets(domain_buckets),
        pipelines: sorted_buckets(pipeline_buckets),
        tasks: sorted_buckets(task_buckets),
        templates,
    }
}

pub fn build_pipeline_compat_report(root: &Path) -> Result<PipelineCompatReport, String> {
    let interface_path = root.join("assets").join("interface.json");
    let interface: Value = read_json(&interface_path)?;
    let tasks: Vec<InterfaceTask> = serde_json::from_value(
        interface
            .get("task")
            .cloned()
            .ok_or_else(|| "interface.json missing task".to_string())?,
    )
    .map_err(|err| err.to_string())?;
    let task_names = tasks
        .iter()
        .map(|task| task.name.clone())
        .collect::<BTreeSet<_>>();

    let mut preset_task_refs = 0usize;
    let mut preset_task_refs_missing = Vec::new();
    let presets = interface
        .get("preset")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    for preset in &presets {
        let preset_name = preset
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or("(unnamed preset)");
        if let Some(items) = preset.get("task").and_then(Value::as_array) {
            for item in items {
                let Some(name) = item.get("name").and_then(Value::as_str) else {
                    continue;
                };
                preset_task_refs += 1;
                if !task_names.contains(name) {
                    preset_task_refs_missing.push(format!("{preset_name} -> {name}"));
                }
            }
        }
    }

    let mut recognition_types = BTreeMap::<String, CounterAcc>::new();
    let mut action_types = BTreeMap::<String, CounterAcc>::new();
    let mut custom_recognitions = BTreeMap::<String, CounterAcc>::new();
    let mut custom_actions = BTreeMap::<String, CounterAcc>::new();
    let mut pipeline_accs = BTreeMap::<String, PipelineCompatAcc>::new();
    let mut all_nodes = BTreeSet::<String>::new();
    let mut node_to_pipeline = BTreeMap::<String, String>::new();
    let mut raw_refs = Vec::<RawNodeRef>::new();
    let mut pipeline_files = 0usize;
    let mut node_definitions = 0usize;

    let pipeline_root = root.join("assets").join("resource");
    for entry in WalkDir::new(&pipeline_root)
        .into_iter()
        .filter_map(Result::ok)
        .filter(|entry| entry.file_type().is_file())
        .filter(|entry| {
            entry.path().extension().and_then(|value| value.to_str()) == Some("json")
                && entry
                    .path()
                    .components()
                    .any(|part| part.as_os_str() == "pipeline")
        })
    {
        let path = entry.path();
        let rel = slash_path(path.strip_prefix(root).unwrap_or(path));
        let data: Value = read_json(path)?;
        let Some(nodes) = data.as_object() else {
            continue;
        };
        pipeline_files += 1;
        node_definitions += nodes.len();
        let acc = pipeline_accs.entry(rel.clone()).or_default();
        acc.node_count += nodes.len();
        for (node, value) in nodes {
            all_nodes.insert(node.clone());
            node_to_pipeline.entry(node.clone()).or_insert(rel.clone());
            let example = format!("{rel} :: {node}");
            collect_compat_value(
                value,
                &rel,
                node,
                &example,
                &mut recognition_types,
                &mut action_types,
                &mut custom_recognitions,
                &mut custom_actions,
                acc,
                &mut raw_refs,
            );
        }
    }

    let mut task_entries_missing = Vec::new();
    let mut tasks_by_pipeline = BTreeMap::<String, Vec<String>>::new();
    for task in &tasks {
        if let Some(pipeline) = node_to_pipeline.get(&task.entry) {
            tasks_by_pipeline
                .entry(pipeline.clone())
                .or_default()
                .push(format!("{} ({})", task.name, task.entry));
        } else {
            task_entries_missing.push(format!("{} ({})", task.name, task.entry));
        }
    }

    let node_refs = raw_refs.len();
    let missing_node_refs = raw_refs
        .into_iter()
        .filter(|item| !all_nodes.contains(&item.target))
        .map(|item| CompatRefIssue {
            from_pipeline: item.from_pipeline,
            from_node: item.from_node,
            field: item.field,
            target: item.target,
        })
        .collect::<Vec<_>>();

    let recognition_types = counters_with_status(recognition_types, recognition_status);
    let action_types = counters_with_status(action_types, action_status);
    let custom_recognitions = counters_with_status(custom_recognitions, custom_recognition_status);
    let custom_actions = counters_with_status(custom_actions, custom_action_status);

    let mut issues = Vec::new();
    collect_issues("recognition", &recognition_types, &mut issues);
    collect_issues("action", &action_types, &mut issues);
    collect_issues("custom_recognition", &custom_recognitions, &mut issues);
    collect_issues("custom_action", &custom_actions, &mut issues);
    if !missing_node_refs.is_empty() {
        issues.push(CompatIssue {
            category: "node_ref".to_string(),
            name: "missing next/on_error target".to_string(),
            status: "unsupported".to_string(),
            count: missing_node_refs.len(),
            detail: "pipeline references nodes that are not present in loaded resources"
                .to_string(),
            examples: missing_node_refs
                .iter()
                .take(5)
                .map(|item| {
                    format!(
                        "{} :: {} -> {} ({})",
                        item.from_pipeline, item.from_node, item.target, item.field
                    )
                })
                .collect(),
        });
    }

    let mut pipelines = pipeline_accs
        .into_iter()
        .map(|(pipeline, acc)| {
            let status = pipeline_status(&acc);
            PipelineCompatSummary {
                task_entries: tasks_by_pipeline
                    .get(&pipeline)
                    .cloned()
                    .unwrap_or_default(),
                pipeline,
                node_count: acc.node_count,
                recognition_types: acc.recognition_types.into_iter().collect(),
                action_types: acc.action_types.into_iter().collect(),
                custom_recognitions: acc.custom_recognitions.into_iter().collect(),
                custom_actions: acc.custom_actions.into_iter().collect(),
                template_refs: acc.template_refs,
                status,
            }
        })
        .collect::<Vec<_>>();
    pipelines.sort_by(|left, right| {
        status_rank(&left.status)
            .cmp(&status_rank(&right.status))
            .then_with(|| {
                left.task_entries
                    .is_empty()
                    .cmp(&right.task_entries.is_empty())
            })
            .then_with(|| left.pipeline.cmp(&right.pipeline))
    });

    Ok(PipelineCompatReport {
        pipeline_files,
        node_definitions,
        interface_tasks: tasks.len(),
        task_entries_found: tasks.len().saturating_sub(task_entries_missing.len()),
        task_entries_missing,
        presets: presets.len(),
        preset_task_refs,
        preset_task_refs_missing,
        node_refs,
        missing_node_refs,
        recognition_types,
        action_types,
        custom_recognitions,
        custom_actions,
        pipelines,
        issues,
    })
}

pub fn record_mapping(
    root: &Path,
    template: &TemplateRef,
    source_roi: Option<[i32; 4]>,
    source_space: &str,
    coordinate_mode: Option<&str>,
    save_path: &Path,
    width: u32,
    height: u32,
    source_frame: Option<(u32, u32)>,
) -> Result<(), String> {
    let mapping_path = root
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("template_mapping.json");
    if let Some(parent) = mapping_path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }

    let mut mapping = if mapping_path.exists() {
        read_json(&mapping_path)?
    } else {
        json!({ "version": 1, "templates": {} })
    };
    let templates = mapping
        .get_mut("templates")
        .and_then(Value::as_object_mut)
        .ok_or_else(|| "template_mapping.json has invalid shape".to_string())?;
    let mut entry = json!({
        "sourcePipeline": template.pipeline,
        "sourceNode": template.node,
        "sourceRoi": source_roi,
        "sourceSpace": source_space,
        "coordinateMode": coordinate_mode,
        "replacementPath": slash_path(save_path.strip_prefix(root).unwrap_or(save_path)),
        "width": width,
        "height": height
    });
    if let Some((frame_width, frame_height)) = source_frame {
        entry["sourceFrameWidth"] = json!(frame_width);
        entry["sourceFrameHeight"] = json!(frame_height);
    }
    templates.insert(template.template.clone(), entry);
    let text = serde_json::to_string_pretty(&mapping).map_err(|err| err.to_string())?;
    fs::write(mapping_path, text).map_err(|err| err.to_string())
}

#[derive(Default)]
struct CounterAcc {
    count: usize,
    examples: BTreeSet<String>,
}

impl CounterAcc {
    fn add(&mut self, example: &str) {
        self.count += 1;
        if self.examples.len() < 8 {
            self.examples.insert(example.to_string());
        }
    }
}

#[derive(Default)]
struct PipelineCompatAcc {
    node_count: usize,
    recognition_types: BTreeSet<String>,
    action_types: BTreeSet<String>,
    custom_recognitions: BTreeSet<String>,
    custom_actions: BTreeSet<String>,
    template_refs: usize,
}

struct RawNodeRef {
    from_pipeline: String,
    from_node: String,
    field: String,
    target: String,
}

fn collect_compat_value(
    value: &Value,
    pipeline: &str,
    node: &str,
    example: &str,
    recognition_types: &mut BTreeMap<String, CounterAcc>,
    action_types: &mut BTreeMap<String, CounterAcc>,
    custom_recognitions: &mut BTreeMap<String, CounterAcc>,
    custom_actions: &mut BTreeMap<String, CounterAcc>,
    pipeline_acc: &mut PipelineCompatAcc,
    raw_refs: &mut Vec<RawNodeRef>,
) {
    match value {
        Value::Object(map) => {
            if let Some(recognition) = map.get("recognition").and_then(Value::as_str) {
                recognition_types
                    .entry(recognition.to_string())
                    .or_default()
                    .add(example);
                pipeline_acc
                    .recognition_types
                    .insert(recognition.to_string());
            }
            if let Some(action) = map.get("action").and_then(Value::as_str) {
                action_types
                    .entry(action.to_string())
                    .or_default()
                    .add(example);
                pipeline_acc.action_types.insert(action.to_string());
            }
            if let Some(custom) = map.get("custom_recognition").and_then(Value::as_str) {
                custom_recognitions
                    .entry(custom.to_string())
                    .or_default()
                    .add(example);
                pipeline_acc.custom_recognitions.insert(custom.to_string());
            }
            if let Some(custom) = map.get("custom_action").and_then(Value::as_str) {
                custom_actions
                    .entry(custom.to_string())
                    .or_default()
                    .add(example);
                pipeline_acc.custom_actions.insert(custom.to_string());
            }
            if let Some(template_value) = map.get("template") {
                pipeline_acc.template_refs += template_strings(template_value).len();
            }
            for field in ["next", "on_error"] {
                collect_raw_refs(map.get(field), pipeline, node, field, raw_refs);
            }
            for child in map.values() {
                collect_compat_value(
                    child,
                    pipeline,
                    node,
                    example,
                    recognition_types,
                    action_types,
                    custom_recognitions,
                    custom_actions,
                    pipeline_acc,
                    raw_refs,
                );
            }
        }
        Value::Array(items) => {
            for child in items {
                collect_compat_value(
                    child,
                    pipeline,
                    node,
                    example,
                    recognition_types,
                    action_types,
                    custom_recognitions,
                    custom_actions,
                    pipeline_acc,
                    raw_refs,
                );
            }
        }
        _ => {}
    }
}

fn collect_raw_refs(
    value: Option<&Value>,
    pipeline: &str,
    node: &str,
    field: &str,
    raw_refs: &mut Vec<RawNodeRef>,
) {
    let Some(value) = value else {
        return;
    };
    match value {
        Value::String(raw) => push_raw_ref(raw, pipeline, node, field, raw_refs),
        Value::Array(items) => {
            for item in items {
                match item {
                    Value::String(raw) => push_raw_ref(raw, pipeline, node, field, raw_refs),
                    Value::Object(map) => {
                        if let Some(raw) = map
                            .get("name")
                            .or_else(|| map.get("task"))
                            .or_else(|| map.get("node"))
                            .and_then(Value::as_str)
                        {
                            push_raw_ref(raw, pipeline, node, field, raw_refs);
                        }
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
}

fn push_raw_ref(
    raw: &str,
    pipeline: &str,
    node: &str,
    field: &str,
    raw_refs: &mut Vec<RawNodeRef>,
) {
    let target = strip_jumpback(raw);
    if target.is_empty() || target == "空节点" {
        return;
    }
    raw_refs.push(RawNodeRef {
        from_pipeline: pipeline.to_string(),
        from_node: node.to_string(),
        field: field.to_string(),
        target,
    });
}

fn strip_jumpback(raw: &str) -> String {
    raw.trim()
        .strip_prefix("[JumpBack]")
        .unwrap_or(raw.trim())
        .trim()
        .to_string()
}

fn counters_with_status(
    counters: BTreeMap<String, CounterAcc>,
    status_fn: fn(&str) -> &'static str,
) -> Vec<CompatCounter> {
    let mut items = counters
        .into_iter()
        .map(|(name, acc)| CompatCounter {
            status: status_fn(&name).to_string(),
            name,
            count: acc.count,
            examples: acc.examples.into_iter().take(5).collect(),
        })
        .collect::<Vec<_>>();
    items.sort_by(|left, right| {
        status_rank(&left.status)
            .cmp(&status_rank(&right.status))
            .then_with(|| right.count.cmp(&left.count))
            .then_with(|| left.name.cmp(&right.name))
    });
    items
}

fn collect_issues(category: &str, counters: &[CompatCounter], issues: &mut Vec<CompatIssue>) {
    for counter in counters {
        if counter.status == "supported" {
            continue;
        }
        issues.push(CompatIssue {
            category: category.to_string(),
            name: counter.name.clone(),
            status: counter.status.clone(),
            count: counter.count,
            detail: compat_detail(category, &counter.name, &counter.status).to_string(),
            examples: counter.examples.clone(),
        });
    }
}

fn recognition_status(name: &str) -> &'static str {
    match name {
        "DirectHit" | "TemplateMatch" | "ColorMatch" | "OCR" | "Or" | "And" | "Custom" => {
            "supported"
        }
        _ => "unsupported",
    }
}

fn action_status(name: &str) -> &'static str {
    match name {
        "Click" | "Swipe" | "MultiSwipe" | "InputText" | "ClickKey" | "Custom" | "StartApp"
        | "StopApp" => "supported",
        _ => "unsupported",
    }
}

fn custom_recognition_status(name: &str) -> &'static str {
    match name {
        "invite" | "OCRNum" | "OCRVitality" | "sjqy_tiku_V2" | "sjqy_tiku_V3" | "AIAnswer"
        | "zhipu" => "supported",
        "reco2" | "my_reco_222" => "placeholder",
        _ => "unsupported",
    }
}

fn custom_action_status(name: &str) -> &'static str {
    match name {
        "count"
        | "countGlobal"
        | "countZG"
        | "input_node_success_num"
        | "output_node_success_num"
        | "returnOCR" => "supported",
        "my_action_111" => "placeholder",
        _ => "unsupported",
    }
}

fn compat_detail(category: &str, name: &str, status: &str) -> &'static str {
    match (category, name, status) {
        (_, _, "placeholder") => "sample or legacy hook has a non-failing placeholder",
        (_, _, "manual") => "requires explicit PC-client policy before full automation",
        _ => "not implemented in the Rust compatibility runtime",
    }
}

fn pipeline_status(acc: &PipelineCompatAcc) -> String {
    let has_unsupported = acc
        .recognition_types
        .iter()
        .any(|name| recognition_status(name) == "unsupported")
        || acc
            .action_types
            .iter()
            .any(|name| action_status(name) == "unsupported")
        || acc
            .custom_recognitions
            .iter()
            .any(|name| custom_recognition_status(name) == "unsupported")
        || acc
            .custom_actions
            .iter()
            .any(|name| custom_action_status(name) == "unsupported");
    if has_unsupported {
        return "unsupported".to_string();
    }
    let has_partial = acc
        .action_types
        .iter()
        .any(|name| action_status(name) != "supported")
        || acc
            .custom_recognitions
            .iter()
            .any(|name| custom_recognition_status(name) != "supported")
        || acc
            .custom_actions
            .iter()
            .any(|name| custom_action_status(name) != "supported");
    if has_partial {
        "partial".to_string()
    } else {
        "supported".to_string()
    }
}

fn status_rank(status: &str) -> usize {
    match status {
        "unsupported" => 0,
        "manual" => 1,
        "placeholder" => 2,
        "partial" => 3,
        "supported" => 4,
        _ => 5,
    }
}

#[derive(Default)]
struct BucketAcc {
    total_refs: usize,
    replaced_refs: usize,
    templates: BTreeSet<String>,
    replaced_templates: BTreeSet<String>,
}

impl BucketAcc {
    fn insert(&mut self, template: &str, replaced: bool) {
        self.total_refs += 1;
        if replaced {
            self.replaced_refs += 1;
            self.replaced_templates.insert(template.to_string());
        }
        self.templates.insert(template.to_string());
    }
}

#[derive(Default)]
struct TemplateAcc {
    total_refs: usize,
    replaced: bool,
    source_space: Option<String>,
    replacement_path: Option<String>,
    domains: BTreeSet<String>,
    pipelines: BTreeSet<String>,
    tasks: BTreeSet<String>,
    nodes: BTreeSet<String>,
    rois: BTreeSet<[i32; 4]>,
}

fn sorted_buckets(buckets: BTreeMap<String, BucketAcc>) -> Vec<CoverageBucket> {
    let mut result: Vec<CoverageBucket> = buckets
        .into_iter()
        .map(|(name, bucket)| {
            let unique_templates = bucket.templates.len();
            let replaced_templates = bucket.replaced_templates.len();
            CoverageBucket {
                name,
                total_refs: bucket.total_refs,
                replaced_refs: bucket.replaced_refs,
                unreplaced_refs: bucket.total_refs.saturating_sub(bucket.replaced_refs),
                unique_templates,
                replaced_templates,
                unreplaced_templates: unique_templates.saturating_sub(replaced_templates),
            }
        })
        .collect();
    result.sort_by(|left, right| {
        right
            .unreplaced_refs
            .cmp(&left.unreplaced_refs)
            .then_with(|| right.total_refs.cmp(&left.total_refs))
            .then_with(|| left.name.cmp(&right.name))
    });
    result
}

fn template_domain(template: &str) -> String {
    template
        .split(['/', '\\'])
        .next()
        .filter(|value| !value.is_empty())
        .unwrap_or("(root)")
        .to_string()
}

fn template_priority(template: &str, group: &TemplateAcc) -> usize {
    let mut priority = group.total_refs * 10 + group.tasks.len() * 4 + group.pipelines.len() * 2;
    let domain = template_domain(template);
    if matches!(domain.as_str(), "zonghe" | "duiwu" | "qiandao" | "beibao") {
        priority += 40;
    }
    if template.contains("jiemian")
        || template.contains("panduan")
        || template.contains("zhujiemian")
    {
        priority += 25;
    }
    priority
}

fn collect_templates(
    value: &Value,
    inherited_roi: Option<[i32; 4]>,
    pipeline: &str,
    node: &str,
    out: &mut Vec<TemplateRef>,
    seen: &mut BTreeSet<String>,
) {
    match value {
        Value::Object(map) => {
            let roi = parse_roi(map.get("roi")).or(inherited_roi);
            if let Some(template_value) = map.get("template") {
                for template in template_strings(template_value) {
                    let id = format!(
                        "{}|{}|{}|{}",
                        template,
                        pipeline,
                        node,
                        roi.map(|item| format!("{},{},{},{}", item[0], item[1], item[2], item[3]))
                            .unwrap_or_else(|| "-".to_string())
                    );
                    if seen.insert(id.clone()) {
                        out.push(TemplateRef {
                            id,
                            template,
                            pipeline: pipeline.to_string(),
                            node: node.to_string(),
                            roi,
                            replacement_path: None,
                            replacement_source_space: None,
                        });
                    }
                }
            }
            for child in map.values() {
                collect_templates(child, roi, pipeline, node, out, seen);
            }
        }
        Value::Array(items) => {
            for item in items {
                collect_templates(item, inherited_roi, pipeline, node, out, seen);
            }
        }
        _ => {}
    }
}

fn template_strings(value: &Value) -> Vec<String> {
    match value {
        Value::String(item) => vec![item.clone()],
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .map(ToString::to_string)
            .collect(),
        _ => Vec::new(),
    }
}

fn parse_roi(value: Option<&Value>) -> Option<[i32; 4]> {
    let items = value?.as_array()?;
    if items.len() != 4 {
        return None;
    }
    Some([
        items[0].as_i64()? as i32,
        items[1].as_i64()? as i32,
        items[2].as_i64()? as i32,
        items[3].as_i64()? as i32,
    ])
}

fn read_json(path: &Path) -> Result<Value, String> {
    let text = fs::read_to_string(path).map_err(|err| format!("{}: {err}", path.display()))?;
    serde_json::from_str(&text).map_err(|err| format!("{}: {err}", path.display()))
}

fn load_template_mapping(root: &Path) -> Result<BTreeMap<String, Value>, String> {
    let mapping_path = root
        .join("assets")
        .join("resource")
        .join("ShiKong")
        .join("template_mapping.json");
    if !mapping_path.exists() {
        return Ok(BTreeMap::new());
    }
    let mapping = read_json(&mapping_path)?;
    Ok(mapping
        .get("templates")
        .and_then(Value::as_object)
        .map(|items| {
            items
                .iter()
                .map(|(key, value)| (key.clone(), value.clone()))
                .collect()
        })
        .unwrap_or_default())
}

fn mapping_first_string(value: &Value, key: &str) -> Option<String> {
    value
        .get(key)
        .and_then(Value::as_str)
        .or_else(|| {
            value
                .get("variants")
                .and_then(Value::as_array)
                .and_then(|items| {
                    items
                        .iter()
                        .find_map(|item| item.get(key).and_then(Value::as_str))
                })
        })
        .map(ToString::to_string)
}

fn slash_path(path: &Path) -> String {
    path.components()
        .map(|part| part.as_os_str().to_string_lossy())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coverage_report_groups_refs_and_prioritizes_unreplaced_templates() {
        let inventory = MaaInventory {
            tasks: vec![MaaTask {
                id: "1|daily|Start".to_string(),
                name: "daily".to_string(),
                entry: "Start".to_string(),
                pipeline: Some("assets/resource/base/pipeline/common.json".to_string()),
                options: Vec::new(),
                description: None,
            }],
            templates: vec![
                TemplateRef {
                    id: "a".to_string(),
                    template: "zonghe/home.png".to_string(),
                    pipeline: "assets/resource/base/pipeline/common.json".to_string(),
                    node: "Start".to_string(),
                    roi: Some([1, 2, 3, 4]),
                    replacement_path: None,
                    replacement_source_space: None,
                },
                TemplateRef {
                    id: "b".to_string(),
                    template: "zonghe/home.png".to_string(),
                    pipeline: "assets/resource/base/pipeline/common.json".to_string(),
                    node: "Again".to_string(),
                    roi: Some([5, 6, 7, 8]),
                    replacement_path: None,
                    replacement_source_space: None,
                },
                TemplateRef {
                    id: "c".to_string(),
                    template: "beibao/item.png".to_string(),
                    pipeline: "assets/resource/base/pipeline/common.json".to_string(),
                    node: "Bag".to_string(),
                    roi: None,
                    replacement_path: Some(
                        "assets/resource/ShiKong/image/beibao/item.png".to_string(),
                    ),
                    replacement_source_space: Some("client".to_string()),
                },
            ],
            option_definitions: BTreeMap::new(),
            presets: Vec::new(),
        };

        let report = build_template_coverage_report(&inventory);
        assert_eq!(report.total_refs, 3);
        assert_eq!(report.unique_templates, 2);
        assert_eq!(report.replaced_refs, 1);
        assert_eq!(report.unreplaced_templates, 1);
        assert_eq!(report.source_space_counts.get("unreplaced"), Some(&2));
        assert_eq!(report.source_space_counts.get("client"), Some(&1));
        assert_eq!(report.domains[0].name, "zonghe");
        assert_eq!(report.templates[0].template, "zonghe/home.png");
        assert!(!report.templates[0].replaced);
        assert_eq!(report.templates[0].rois.len(), 2);
    }

    #[test]
    fn compatibility_report_tracks_real_maa_resource_surface() {
        let manifest = Path::new(env!("CARGO_MANIFEST_DIR"));
        let Some(common_root) = manifest.parent().and_then(Path::parent) else {
            return;
        };
        let maa_root = common_root.join("Maa_MHXY_MG");
        if !maa_root.join("assets").join("interface.json").exists() {
            eprintln!(
                "skipping real Maa compatibility test: {}",
                maa_root.display()
            );
            return;
        }

        let report = build_pipeline_compat_report(&maa_root).expect("compat report");
        assert_eq!(report.interface_tasks, 34);
        assert_eq!(report.task_entries_found, report.interface_tasks);
        assert!(
            report.task_entries_missing.is_empty(),
            "missing task entries: {:?}",
            report.task_entries_missing
        );
        assert_eq!(report.presets, 4);
        assert_eq!(report.preset_task_refs, 62);
        assert!(
            report.preset_task_refs_missing.is_empty(),
            "missing preset refs: {:?}",
            report.preset_task_refs_missing
        );
        assert!(
            report.missing_node_refs.is_empty(),
            "missing node refs: {:?}",
            report.missing_node_refs
        );
        assert!(
            report
                .issues
                .iter()
                .all(|issue| issue.status != "unsupported"),
            "unsupported runtime hooks: {:?}",
            report.issues
        );
        assert!(
            report
                .action_types
                .iter()
                .any(|item| item.name == "StartApp" && item.status == "supported"),
            "StartApp should confirm a bound PC client window or use the configured launcher"
        );
        assert!(
            report
                .action_types
                .iter()
                .any(|item| item.name == "StopApp" && item.status == "supported"),
            "StopApp should close only the bound hwnd instead of killing processes"
        );
    }

    #[test]
    fn mapping_first_string_reads_variant_entries() {
        let mapping = json!({
            "variants": [
                {
                    "replacementPath": "assets/resource/ShiKong/image_variants/a.png",
                    "sourceSpace": "imageVariant"
                }
            ]
        });
        assert_eq!(
            mapping_first_string(&mapping, "replacementPath").as_deref(),
            Some("assets/resource/ShiKong/image_variants/a.png")
        );
        assert_eq!(
            mapping_first_string(&mapping, "sourceSpace").as_deref(),
            Some("imageVariant")
        );
    }
}
