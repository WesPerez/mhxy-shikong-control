#!/usr/bin/env python3
"""Validate headless acceptance Maa option values.

The validator is read-only. It checks an option-values JSON file against the
original Maa interface definitions before a long administrator acceptance run.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


DEFAULT_OPTION_VALUES = Path("assets/resource/ShiKong/headless_options.example.json")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--project-root", type=Path, default=Path.cwd())
    parser.add_argument("--maa-root", type=Path, default=None)
    parser.add_argument("--option-values", type=Path, default=DEFAULT_OPTION_VALUES)
    args = parser.parse_args()

    project_root = args.project_root.resolve()
    maa_root = (args.maa_root or (project_root.parent / "Maa_MHXY_MG")).resolve()
    option_path = resolve(project_root, args.option_values)
    interface_path = maa_root / "assets/interface.json"

    errors: list[str] = []
    warnings: list[str] = []
    if not interface_path.is_file():
        errors.append(f"Maa interface not found: {interface_path}")
        return finish(option_path, errors, warnings, {})
    if not option_path.is_file():
        errors.append(f"option values file not found: {option_path}")
        return finish(option_path, errors, warnings, {})

    interface = read_json(interface_path)
    option_values = read_json(option_path)
    tasks = collect_tasks(interface)
    option_definitions = interface.get("option") or {}
    if not isinstance(option_definitions, dict):
        errors.append("interface option section must be an object")
        return finish(option_path, errors, warnings, {})

    global_values, per_task_values = split_option_values(option_values, errors)
    validate_option_map("global", global_values, option_definitions, errors)

    task_index = build_task_index(tasks)
    for task_key, values in per_task_values.items():
        matched = task_index.get(task_key)
        if not matched:
            errors.append(
                f"tasks.{task_key}: unknown task key; use task name, entry, or id such as 1|创建队伍|chuangjianduiwu"
            )
            continue
        validate_option_map(f"tasks.{task_key}", values, option_definitions, errors)
        merged = dict(global_values)
        merged.update(values)
        reachable = set().union(
            *(reachable_options(task, merged, option_definitions) for task in matched)
        )
        for option_name in values:
            if option_name not in reachable:
                warnings.append(
                    f"tasks.{task_key}.{option_name}: option is not reachable from the selected/default branch for this task"
                )

    all_reachable = set().union(
        *(reachable_options(task, global_values, option_definitions) for task in tasks)
    )
    for option_name in global_values:
        if option_name not in all_reachable:
            warnings.append(
                f"global.{option_name}: option is not reachable from any interface task with current global selections"
            )

    summary = {
        "tasks": len(tasks),
        "options": len(option_definitions),
        "globalOptions": len(global_values),
        "taskOverrides": len(per_task_values),
    }
    return finish(option_path, errors, warnings, summary)


def split_option_values(
    data: Any,
    errors: list[str],
) -> tuple[dict[str, Any], dict[str, dict[str, Any]]]:
    if not isinstance(data, dict):
        errors.append("option values JSON must be an object")
        return {}, {}
    global_values: dict[str, Any] = {}
    per_task: dict[str, dict[str, Any]] = {}

    raw_global = data.get("global")
    if raw_global is not None:
        if isinstance(raw_global, dict):
            global_values.update(raw_global)
        else:
            errors.append("global must be an object")

    raw_tasks = data.get("tasks")
    if raw_tasks is not None:
        if isinstance(raw_tasks, dict):
            for key, value in raw_tasks.items():
                if isinstance(value, dict):
                    per_task[str(key)] = value
                else:
                    errors.append(f"tasks.{key} must be an object")
        else:
            errors.append("tasks must be an object")

    for key, value in data.items():
        if key not in {"global", "tasks"}:
            global_values[str(key)] = value
    return global_values, per_task


def validate_option_map(
    label: str,
    values: dict[str, Any],
    option_definitions: dict[str, Any],
    errors: list[str],
) -> None:
    for option_name, value in values.items():
        definition = option_definitions.get(option_name)
        if not isinstance(definition, dict):
            errors.append(f"{label}.{option_name}: unknown Maa option")
            continue
        validate_option_value(f"{label}.{option_name}", value, definition, errors)


def validate_option_value(
    label: str,
    value: Any,
    definition: dict[str, Any],
    errors: list[str],
) -> None:
    option_type = definition.get("type")
    if option_type in {"select", "switch"}:
        if not isinstance(value, str):
            errors.append(f"{label}: {option_type} value must be a string case name")
            return
        case_names = {str(item.get("name")) for item in definition.get("cases") or [] if isinstance(item, dict)}
        if value not in case_names:
            errors.append(f"{label}: unknown case {value!r}; expected one of {sorted(case_names)}")
        return

    if option_type == "checkbox":
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            errors.append(f"{label}: checkbox value must be a list of string case names")
            return
        case_names = {str(item.get("name")) for item in definition.get("cases") or [] if isinstance(item, dict)}
        for item in value:
            if item not in case_names:
                errors.append(f"{label}: unknown checkbox case {item!r}; expected one of {sorted(case_names)}")
        return

    if option_type == "input":
        inputs = [item for item in definition.get("inputs") or [] if isinstance(item, dict)]
        input_names = {str(item.get("name")) for item in inputs if item.get("name")}
        if isinstance(value, dict):
            for key, item in value.items():
                if key not in input_names:
                    errors.append(f"{label}.{key}: unknown input field; expected one of {sorted(input_names)}")
                    continue
                validate_input_scalar(f"{label}.{key}", item, input_by_name(inputs, key), errors)
        elif len(inputs) == 1:
            validate_input_scalar(label, value, inputs[0], errors)
        else:
            errors.append(f"{label}: input value must be an object with fields {sorted(input_names)}")
        return

    errors.append(f"{label}: unsupported option type {option_type!r}")


def validate_input_scalar(
    label: str,
    value: Any,
    definition: dict[str, Any] | None,
    errors: list[str],
) -> None:
    pipeline_type = (definition or {}).get("pipeline_type")
    if pipeline_type == "int":
        try:
            int(value)
        except (TypeError, ValueError):
            errors.append(f"{label}: expected integer-compatible value")
    elif isinstance(value, (dict, list)):
        errors.append(f"{label}: expected scalar string value")


def input_by_name(inputs: list[dict[str, Any]], name: str) -> dict[str, Any] | None:
    for item in inputs:
        if item.get("name") == name:
            return item
    return None


def reachable_options(
    task: dict[str, Any],
    values: dict[str, Any],
    option_definitions: dict[str, Any],
) -> set[str]:
    reachable: set[str] = set()

    def visit(option_name: str) -> None:
        if option_name in reachable:
            return
        definition = option_definitions.get(option_name)
        if not isinstance(definition, dict):
            return
        reachable.add(option_name)
        for nested in selected_nested_options(option_name, definition, values):
            visit(nested)

    for option_name in task.get("option") or []:
        visit(str(option_name))
    return reachable


def selected_nested_options(
    option_name: str,
    definition: dict[str, Any],
    values: dict[str, Any],
) -> list[str]:
    option_type = definition.get("type")
    value = values.get(option_name, default_option_value(definition))
    cases = [item for item in definition.get("cases") or [] if isinstance(item, dict)]
    selected_cases: list[dict[str, Any]] = []
    if option_type == "checkbox":
        selected = set(value if isinstance(value, list) else [])
        selected_cases = [item for item in cases if item.get("name") in selected]
    elif option_type in {"select", "switch"}:
        selected_cases = [item for item in cases if item.get("name") == value]
    nested: list[str] = []
    for item in selected_cases:
        nested.extend(str(name) for name in item.get("option") or [])
    return nested


def default_option_value(definition: dict[str, Any]) -> Any:
    option_type = definition.get("type")
    if option_type == "checkbox":
        return list(definition.get("default_case") or [])
    if option_type == "input":
        return {
            str(item.get("name")): item.get("default", "")
            for item in definition.get("inputs") or []
            if isinstance(item, dict) and item.get("name")
        }
    if definition.get("default_case") is not None:
        return definition.get("default_case")
    cases = [item for item in definition.get("cases") or [] if isinstance(item, dict)]
    return cases[0].get("name") if cases else ""


def collect_tasks(interface: dict[str, Any]) -> list[dict[str, Any]]:
    tasks = []
    for index, item in enumerate(interface.get("task") or [], start=1):
        if not isinstance(item, dict):
            continue
        task = dict(item)
        task["id"] = f"{index}|{item.get('name') or item.get('entry') or ''}|{item.get('entry') or ''}"
        tasks.append(task)
    return tasks


def build_task_index(tasks: list[dict[str, Any]]) -> dict[str, list[dict[str, Any]]]:
    index: dict[str, list[dict[str, Any]]] = {}
    for task in tasks:
        for key in (task.get("id"), task.get("name"), task.get("entry")):
            if key:
                index.setdefault(str(key), []).append(task)
    return index


def finish(
    option_path: Path,
    errors: list[str],
    warnings: list[str],
    summary: dict[str, Any],
) -> int:
    output = {
        "optionValues": str(option_path),
        "valid": not errors,
        "summary": summary,
        "errors": errors,
        "warnings": warnings,
    }
    print(json.dumps(output, ensure_ascii=False, indent=2))
    return 2 if errors else 0


def resolve(project_root: Path, path: Path) -> Path:
    return path if path.is_absolute() else project_root / path


def read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8-sig"))


if __name__ == "__main__":
    raise SystemExit(main())
