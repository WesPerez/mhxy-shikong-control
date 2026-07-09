#!/usr/bin/env python3
"""Audit workflow examples, builtin templates, and readiness regressions."""

from __future__ import annotations

import argparse
import json
import re
import struct
import sys
from pathlib import Path


REQUIRED_FILES = [
    "src/main.js",
    "assets/resource/ShiKong/template_mapping.json",
    "assets/resource/ShiKong/template_text_fallbacks.json",
    "assets/resource/ShiKong/app_launch.example.json",
    "assets/resource/ShiKong/headless_options.example.json",
    "assets/resource/ShiKong/capture_playbooks/main-panels.json",
]
MIN_BLUEPRINTS = 10
MIN_SAMPLE_WORKFLOWS = 10
MIN_EXERCISE_BLUEPRINTS = 10
MIN_STEPS_PER_WORKFLOW = 10
REQUIRED_STEP_TYPES = {
    "detect_page",
    "wait_image",
    "image_click",
    "double_click",
    "ocr_assert",
    "click",
    "hotkey",
    "text_input",
    "delay",
    "condition",
    "loop",
    "retry_until",
    "snapshot",
    "task_jump",
    "restore",
}
REPORT_ONLY_TARGETS = {
    "button.sign_in",
    "entry.home",
    "tab.daily_activity",
    "button.apply_join",
    "button.use_item",
    "page.mail.ready",
    "icon.mail_attachment",
    "button.claim_attachment",
    "page.pet.ready",
    "button.pet_feed",
    "item.pet_food",
    "input.stall_search",
    "button.search",
    "button.auto_path",
    "list.row.1",
    "list.search_result.ready",
}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--project-root",
        type=Path,
        default=Path(__file__).resolve().parents[1],
        help="Repository root to audit.",
    )
    parser.add_argument("--json", action="store_true", help="Emit machine-readable JSON.")
    parser.add_argument(
        "--strict-placeholder-targets",
        action="store_true",
        help="Fail when target-backed steps lack builtin template bindings.",
    )
    return parser.parse_args()


def read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def extract_array(source: str, name: str) -> str:
    marker = re.search(rf"\b(?:const|let|var)\s+{re.escape(name)}\s*=\s*", source)
    if not marker:
        raise ValueError(f"missing {name}")
    start = source.find("[", marker.end())
    if start < 0:
        raise ValueError(f"{name} is not an array")
    return source[start : find_matching(source, start, "[", "]") + 1]


def extract_object(source: str, name: str) -> str:
    marker = re.search(rf"\b(?:const|let|var)\s+{re.escape(name)}\s*=\s*", source)
    if not marker:
        raise ValueError(f"missing {name}")
    start = source.find("{", marker.end())
    if start < 0:
        raise ValueError(f"{name} is not an object")
    return source[start : find_matching(source, start, "{", "}") + 1]


def extract_function_body(source: str, name: str) -> str:
    marker = re.search(rf"\bfunction\s+{re.escape(name)}\s*\([^)]*\)\s*\{{", source)
    if not marker:
        raise ValueError(f"missing function {name}")
    start = source.find("{", marker.start())
    return source[start + 1 : find_matching(source, start, "{", "}")]


def find_matching(source: str, start: int, open_char: str, close_char: str) -> int:
    depth = 0
    quote = ""
    escaped = False
    line_comment = False
    block_comment = False
    for index in range(start, len(source)):
        ch = source[index]
        nxt = source[index + 1] if index + 1 < len(source) else ""
        if line_comment:
            if ch in "\r\n":
                line_comment = False
            continue
        if block_comment:
            if ch == "*" and nxt == "/":
                block_comment = False
            continue
        if quote:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                quote = ""
            continue
        if ch == "/" and nxt == "/":
            line_comment = True
            continue
        if ch == "/" and nxt == "*":
            block_comment = True
            continue
        if ch in "\"'`":
            quote = ch
            continue
        if ch == open_char:
            depth += 1
        elif ch == close_char:
            depth -= 1
            if depth == 0:
                return index
    raise ValueError(f"unclosed {open_char}")


def split_top_level_objects(array_text: str) -> list[str]:
    objects: list[str] = []
    index = 0
    while index < len(array_text):
        if array_text[index] == "{":
            end = find_matching(array_text, index, "{", "}")
            objects.append(array_text[index : end + 1])
            index = end + 1
        else:
            index += 1
    return objects


def js_unquote(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] in "\"'" and value[-1] == value[0]:
        return bytes(value[1:-1], "utf-8").decode("unicode_escape")
    return value


def object_fields(text: str) -> dict[str, str]:
    fields: dict[str, str] = {}
    pattern = re.compile(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(\"(?:\\.|[^\"])*\"|'(?:\\.|[^'])*'|[0-9.]+)")
    for key, value in pattern.findall(text):
        fields[key] = js_unquote(value)
    return fields


def int_field(fields: dict[str, object], key: str) -> int:
    try:
        return int(float(str(fields.get(key, 0) or 0)))
    except ValueError:
        return 0


def string_literals(text: str) -> list[str]:
    return [js_unquote(item) for item in re.findall(r"\"(?:\\.|[^\"])*\"|'(?:\\.|[^'])*'", text)]


def split_js_args(text: str) -> list[str]:
    args: list[str] = []
    start = 0
    depth = 0
    quote = ""
    escaped = False
    for index, ch in enumerate(text):
        if quote:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == quote:
                quote = ""
            continue
        if ch in "\"'`":
            quote = ch
            continue
        if ch in "([{":
            depth += 1
        elif ch in ")]}":
            depth -= 1
        elif ch == "," and depth == 0:
            args.append(text[start:index].strip())
            start = index + 1
    tail = text[start:].strip()
    if tail:
        args.append(tail)
    return args


def extract_set_values(source: str, name: str) -> set[str]:
    match = re.search(rf"\b{name}\s*=\s*new\s+Set\s*\(\s*\[([^\]]*)\]", source, re.S)
    if not match:
        raise ValueError(f"missing set {name}")
    return set(string_literals(match.group(1)))


def parse_bindings(source: str) -> list[dict[str, str]]:
    array_text = extract_array(source, "builtinTargetTemplateBindings")
    return [object_fields(item) for item in split_top_level_objects(array_text)]


def parse_step_types(source: str) -> set[str]:
    array_text = extract_array(source, "stepTypes")
    return set(re.findall(r"\[\s*\"([^\"]+)\"", array_text))


def parse_step_defaults(source: str) -> dict[str, dict[str, str]]:
    defaults: dict[str, dict[str, str]] = {}
    object_text = extract_object(source, "stepDefaults")
    index = 0
    while index < len(object_text):
        match = re.search(r"\b([A-Za-z_][A-Za-z0-9_]*)\s*:\s*\{", object_text[index:])
        if not match:
            break
        key = match.group(1)
        open_index = index + match.end() - 1
        close_index = find_matching(object_text, open_index, "{", "}")
        defaults[key] = object_fields(object_text[open_index : close_index + 1])
        index = close_index + 1
    return defaults


def parse_blueprints(source: str) -> list[dict[str, object]]:
    blueprints = []
    for chunk in split_top_level_objects(extract_array(source, "workflowBlueprints")):
        fields = object_fields(chunk)
        steps = []
        for step_match in re.finditer(r"\{\s*type:\s*\"([^\"]+)\"(?P<body>.*?)\}", chunk, re.S):
            body = step_match.group(0)
            step_fields = object_fields(body)
            if "type" in step_fields and "target" in step_fields:
                steps.append(step_fields)
        blueprints.append({"id": fields.get("id", ""), "label": fields.get("label", ""), "steps": steps})
    return blueprints


def parse_sample_workflows(source: str, step_defaults: dict[str, dict[str, str]]) -> list[dict[str, object]]:
    body = extract_function_body(source, "createSampleWorkflows")
    workflows: list[dict[str, object]] = []
    current: dict[str, object] | None = None
    index = 0
    call_pattern = re.compile(r"\b(workflow|step)\s*\(")
    while True:
        match = call_pattern.search(body, index)
        if not match:
            break
        open_index = body.find("(", match.start())
        close_index = find_matching(body, open_index, "(", ")")
        args = split_js_args(body[open_index + 1 : close_index])
        if match.group(1) == "workflow" and args:
            current = {"id": js_unquote(args[0]), "steps": []}
            workflows.append(current)
            index = open_index + 1
            continue
        if match.group(1) == "step" and current is not None and len(args) >= 6:
            step_data = {
                "id": js_unquote(args[0]),
                "type": js_unquote(args[1]),
                "target": js_unquote(args[3]),
                "command": js_unquote(args[4]),
                "expect": js_unquote(args[5]),
            }
            if len(args) >= 9:
                step_data["onFail"] = js_unquote(args[8])
            else:
                step_data["onFail"] = step_defaults.get(step_data["type"], {}).get("onFail", "stop")
            if len(args) >= 10:
                step_data.update(object_fields(args[9]))
            current["steps"].append(step_data)
        index = close_index + 1
    return workflows


def png_size(path: Path) -> tuple[int, int]:
    with path.open("rb") as handle:
        header = handle.read(24)
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    return struct.unpack(">II", header[16:24])


def is_project_relative(path_text: str) -> bool:
    path = Path(path_text)
    return not path.is_absolute() and ".." not in path.parts


def logical_target(target: str) -> bool:
    if not target or "=" in target:
        return False
    if re.fullmatch(r"[A-Z]+(?:\+[A-Z0-9]+)+", target, re.I):
        return False
    if re.fullmatch(r"\d+(?:ms|s)?", target, re.I):
        return False
    return bool(re.match(r"^[\w\u4e00-\u9fff][\w\u4e00-\u9fff_.:-]*$", target))


def audit(project_root: Path, strict_placeholder_targets: bool = False) -> dict[str, object]:
    failures: list[str] = []
    warnings: list[str] = []
    reports: list[str] = []
    counts: dict[str, int] = {}

    for relative in REQUIRED_FILES:
        if not (project_root / relative).is_file():
            failures.append(f"missing required file: {relative}")
    if failures:
        return {"passed": False, "failures": failures, "warnings": warnings, "reports": reports, "counts": counts}

    source = read_text(project_root / "src/main.js")
    mapping = json.loads(read_text(project_root / "assets/resource/ShiKong/template_mapping.json"))
    templates = mapping.get("templates", mapping)
    if not isinstance(templates, dict):
        failures.append("template_mapping.json does not contain an object template map")
        templates = {}

    target_backed_step_types = extract_set_values(source, "targetBackedStepTypes")
    step_types = parse_step_types(source)
    step_defaults = parse_step_defaults(source)
    bindings = parse_bindings(source)
    blueprints = parse_blueprints(source)
    sample_workflows = parse_sample_workflows(source, step_defaults)
    exercise_ids = string_literals(extract_array(source, "exerciseSuiteBlueprintIds"))

    counts.update(
        {
            "stepTypes": len(step_types),
            "targetBackedStepTypes": len(target_backed_step_types),
            "builtinBindings": len(bindings),
            "mappingTemplates": len(templates),
            "blueprints": len(blueprints),
            "sampleWorkflows": len(sample_workflows),
            "exerciseBlueprints": len(exercise_ids),
        },
    )

    if len(blueprints) < MIN_BLUEPRINTS:
        failures.append(f"expected at least {MIN_BLUEPRINTS} workflow blueprints, found {len(blueprints)}")
    if len(sample_workflows) < MIN_SAMPLE_WORKFLOWS:
        failures.append(f"expected at least {MIN_SAMPLE_WORKFLOWS} sample workflows, found {len(sample_workflows)}")
    if len(exercise_ids) < MIN_EXERCISE_BLUEPRINTS:
        failures.append(f"expected at least {MIN_EXERCISE_BLUEPRINTS} exercise blueprints, found {len(exercise_ids)}")
    missing_step_types = sorted(REQUIRED_STEP_TYPES - step_types)
    if missing_step_types:
        failures.append(f"missing required step types: {', '.join(missing_step_types)}")

    binding_targets: set[str] = set()
    binding_keys: set[str] = set()
    for binding in bindings:
        target = binding.get("target", "")
        key = binding.get("key", "")
        if not target or not key:
            failures.append(f"builtin binding missing target/key: {binding}")
            continue
        if target in binding_targets:
            failures.append(f"duplicate builtin binding target: {target}")
        binding_targets.add(target)
        binding_keys.add(key)
        template = templates.get(key)
        if not template:
            failures.append(f"binding key not found in template_mapping.json: {key}")
            continue
        replacement = str(template.get("replacementPath", ""))
        if not replacement:
            failures.append(f"mapping entry missing replacementPath: {key}")
            continue
        if not is_project_relative(replacement):
            failures.append(f"mapping replacementPath must be project-relative: {key} -> {replacement}")
            continue
        asset_path = project_root / replacement
        if not asset_path.is_file():
            failures.append(f"binding replacement file missing: {key} -> {replacement}")
            continue
        try:
            width, height = png_size(asset_path)
            if width <= 0 or height <= 0:
                failures.append(f"binding PNG has invalid size: {key} -> {width}x{height}")
        except ValueError as error:
            failures.append(f"binding replacement is not a valid PNG: {key} ({error})")

    for key, template in templates.items():
        replacement = str(template.get("replacementPath", ""))
        if not replacement:
            failures.append(f"mapping entry missing replacementPath: {key}")
            continue
        if not is_project_relative(replacement):
            failures.append(f"mapping replacementPath must be project-relative: {key} -> {replacement}")
            continue
        if not (project_root / replacement).is_file():
            failures.append(f"mapping replacement file missing: {key} -> {replacement}")

    blueprint_ids = [str(item["id"]) for item in blueprints]
    duplicate_blueprints = sorted({item for item in blueprint_ids if blueprint_ids.count(item) > 1})
    if duplicate_blueprints:
        failures.append(f"duplicate blueprint ids: {', '.join(duplicate_blueprints)}")
    missing_exercise_ids = sorted(set(exercise_ids) - set(blueprint_ids))
    if missing_exercise_ids:
        failures.append(f"exercise suite references missing blueprints: {', '.join(missing_exercise_ids)}")

    sample_ids = [str(item["id"]) for item in sample_workflows]
    duplicate_samples = sorted({item for item in sample_ids if sample_ids.count(item) > 1})
    if duplicate_samples:
        failures.append(f"duplicate sample workflow ids: {', '.join(duplicate_samples)}")

    sample_task_jumps = 0
    sample_recovery_sources = 0
    sample_condition_branches = 0
    sample_success_jumps = 0
    sample_backward_limited_jumps = 0
    sample_loop_steps = 0
    sample_bounded_loops = 0
    for workflow in sample_workflows:
        workflow_id = str(workflow.get("id", ""))
        steps = list(workflow.get("steps", []))
        step_ids = [str(step.get("id", "")) for step in steps]
        step_id_set = set(step_ids)
        step_index = {step_id: index for index, step_id in enumerate(step_ids)}
        has_restore_step = any(step.get("type") == "restore" for step in steps)
        for index, step in enumerate(steps):
            step_type = str(step.get("type", ""))
            target_step_id = str(step.get("targetStepId", "") or "")
            else_step_id = str(step.get("elseTargetStepId", "") or "")
            jump_workflow_id = str(step.get("jumpWorkflowId", "") or "")
            max_iterations = int_field(step, "maxIterations")
            if step_type == "task_jump" and jump_workflow_id in sample_ids:
                sample_task_jumps += 1
            if step.get("onFail") == "restore" and (
                str(step.get("recoveryStepId", "") or "") in step_id_set or has_restore_step
            ):
                sample_recovery_sources += 1
            if step_type == "condition" and target_step_id in step_id_set and else_step_id in step_id_set:
                sample_condition_branches += 1
            if step_type == "loop":
                sample_loop_steps += 1
                if target_step_id in step_index and step_index[target_step_id] < index and max_iterations > 0:
                    sample_bounded_loops += 1
            if step_type != "condition" and target_step_id in step_id_set:
                sample_success_jumps += 1
            if target_step_id in step_index and step_index[target_step_id] <= index and max_iterations > 0:
                sample_backward_limited_jumps += 1
            if jump_workflow_id == workflow_id and max_iterations > 0:
                sample_backward_limited_jumps += 1

    counts.update(
        {
            "sampleTaskJumps": sample_task_jumps,
            "sampleRecoverySources": sample_recovery_sources,
            "sampleConditionBranches": sample_condition_branches,
            "sampleSuccessJumps": sample_success_jumps,
            "sampleBackwardLimitedJumps": sample_backward_limited_jumps,
            "sampleLoopSteps": sample_loop_steps,
            "sampleBoundedLoops": sample_bounded_loops,
        },
    )
    if sample_task_jumps < 1:
        failures.append("sample workflows must include at least one task_jump with a valid target workflow")
    if sample_recovery_sources < 1:
        failures.append("sample workflows must include at least one onFail=restore source with a recovery entry")
    if sample_condition_branches < 1:
        failures.append("sample workflows must include at least one condition with valid true and false branches")
    if sample_success_jumps < 1:
        failures.append("sample workflows must include at least one non-condition success targetStepId jump")
    if sample_backward_limited_jumps < 1:
        failures.append("sample workflows must include at least one backward jump protected by maxIterations")
    if sample_loop_steps < 1:
        failures.append("sample workflows must include at least one explicit loop step")
    if sample_bounded_loops < 1:
        failures.append("sample workflows must include at least one loop step pointing backward with maxIterations")

    all_target_references: list[str] = []
    all_step_types: set[str] = set()
    for collection_name, workflows in [("blueprint", blueprints), ("sample", sample_workflows)]:
        for workflow in workflows:
            steps = list(workflow.get("steps", []))
            workflow_id = str(workflow.get("id", ""))
            if len(steps) < MIN_STEPS_PER_WORKFLOW:
                failures.append(f"{collection_name} workflow has fewer than {MIN_STEPS_PER_WORKFLOW} steps: {workflow_id}")
            for step in steps:
                step_type = str(step.get("type", ""))
                target = str(step.get("target", ""))
                all_step_types.add(step_type)
                if step_type not in step_types:
                    failures.append(f"{collection_name} {workflow_id} uses unknown step type: {step_type}")
                if step_type in target_backed_step_types and not target:
                    failures.append(f"{collection_name} {workflow_id} has target-backed step without target")
                if step_type in target_backed_step_types and logical_target(target):
                    all_target_references.append(target)

    missing_required_coverage = sorted(REQUIRED_STEP_TYPES - all_step_types)
    if missing_required_coverage:
        failures.append(f"blueprints/samples do not cover step types: {', '.join(missing_required_coverage)}")

    unbound_targets = sorted(
        target for target in set(all_target_references) if target not in binding_targets and target not in REPORT_ONLY_TARGETS
    )
    report_only_targets = sorted(target for target in set(all_target_references) if target in REPORT_ONLY_TARGETS and target not in binding_targets)
    counts["targetReferences"] = len(all_target_references)
    counts["unboundTargets"] = len(unbound_targets)
    counts["reportOnlyTargets"] = len(report_only_targets)
    if unbound_targets:
        message = f"target-backed logical targets without builtin binding: {', '.join(unbound_targets[:40])}"
        if strict_placeholder_targets:
            failures.append(message)
        else:
            reports.append(message)
    if report_only_targets:
        reports.append(f"intentionally unbound targets needing live capture: {', '.join(report_only_targets)}")

    orphan_bindings = sorted(binding_targets - set(all_target_references))
    counts["orphanBindings"] = len(orphan_bindings)
    if orphan_bindings:
        reports.append(f"builtin bindings not used by current blueprints/samples: {', '.join(orphan_bindings)}")

    return {
        "passed": not failures,
        "failures": failures,
        "warnings": warnings,
        "reports": reports,
        "counts": counts,
    }


def main() -> int:
    args = parse_args()
    result = audit(args.project_root.resolve(), strict_placeholder_targets=args.strict_placeholder_targets)
    if args.json:
        print(json.dumps(result, ensure_ascii=False, indent=2))
    else:
        for key, value in result["counts"].items():
            print(f"{key}={value}")
        for message in result["failures"]:
            print(f"FAIL {message}")
        for message in result["warnings"]:
            print(f"WARN {message}")
        for message in result["reports"]:
            print(f"REPORT {message}")
    return 0 if result["passed"] else 2


if __name__ == "__main__":
    sys.exit(main())
