export const STEP_PARAM_KEYS = [
  "mode",
  "button",
  "threshold",
  "point",
  "offsetX",
  "offsetY",
  "preDelayMs",
  "postDelayMs",
  "reason",
  "guard",
  "intervalMs",
  "roi",
  "lang",
  "clickX",
  "clickY",
  "hotkey",
  "text",
  "imageTarget",
  "delayMs",
  "conditionLabel",
  "retryTarget",
  "ocrText",
];

export function commandParts(command) {
  return String(command || "")
    .split(/[;,]/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const splitAt = part.indexOf("=");
      if (splitAt < 0) return { raw: part };
      const key = part.slice(0, splitAt).trim();
      const value = part.slice(splitAt + 1).trim();
      return key ? { key, value } : { raw: part };
    });
}

export function commandValue(command, key) {
  const expected = String(key || "").toLowerCase();
  for (const part of commandParts(command)) {
    if (part.key?.toLowerCase() === expected && part.value) return part.value;
  }
  return "";
}

export function commandWithValues(command, updates) {
  const updateKeys = new Set(Object.keys(updates || {}).map((key) => key.toLowerCase()));
  const parts = commandParts(command).filter((part) => !part.key || !updateKeys.has(part.key.toLowerCase()));
  for (const [key, value] of Object.entries(updates || {})) {
    const text = String(value ?? "").trim();
    if (text) parts.push({ key, value: text });
  }
  return parts.map((part) => (part.key ? `${part.key}=${part.value}` : part.raw)).join("; ");
}

export function durationMsFromText(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  let match = text.match(/^(\d+)ms$/);
  if (match) return Number(match[1]);
  match = text.match(/^(\d+(?:\.\d+)?)s$/);
  if (match) return Math.round(Number(match[1]) * 1000);
  match = text.match(/^\d+$/);
  if (match) return Number(text);
  return null;
}

export function commandDurationMs(command, key) {
  const raw = commandValue(command, key);
  return raw ? durationMsFromText(raw) : null;
}

export function parsePointText(value) {
  let x = null;
  let y = null;
  for (const part of String(value || "")
    .split(/[,\s;]+/)
    .map((item) => item.trim())
    .filter(Boolean)) {
    const [rawKey, rawValue] = part.split("=");
    if (!rawKey || !/^-?\d+$/.test(rawValue || "")) continue;
    if (rawKey.toLowerCase() === "x") x = Number(rawValue);
    if (rawKey.toLowerCase() === "y") y = Number(rawValue);
  }
  return x != null && y != null ? { x, y } : null;
}

export function normalizeStepParams(input = {}, options = {}) {
  const type = String(input.type || "");
  const target = String(input.target || "");
  const command = String(input.command || "");
  const expect = String(input.expect || "");
  const timeoutMs = finiteNonNegativeInteger(input.timeoutMs);
  const params = normalizeParamsObject(input.params);
  if (options.preferLegacy) {
    for (const key of STEP_PARAM_KEYS) delete params[key];
  }
  const setMissing = (key, value) => {
    if (!hasParam(params, key) && value !== null && value !== undefined && value !== "") {
      params[key] = value;
    }
  };

  setMissing("mode", commandValue(command, "mode"));
  setMissing("button", commandValue(command, "button"));
  setMissing("threshold", finiteNumber(commandValue(command, "threshold")));
  setMissing("point", commandValue(command, "point"));
  setMissing("offsetX", finiteInteger(commandValue(command, "offsetX")));
  setMissing("offsetY", finiteInteger(commandValue(command, "offsetY")));
  setMissing("preDelayMs", commandDurationMs(command, "preDelay"));
  setMissing("postDelayMs", commandDurationMs(command, "postDelay"));
  setMissing("reason", commandValue(command, "reason"));
  setMissing("guard", commandValue(command, "guard"));
  setMissing("intervalMs", commandDurationMs(command, "interval"));
  setMissing("roi", commandValue(command, "roi"));
  setMissing("lang", commandValue(command, "lang") || commandValue(command, "language"));

  const commandPoint = parsePointText(command);
  const targetPoint = parsePointText(target);
  const point = targetPoint || commandPoint;
  if (point) {
    setMissing("clickX", point.x);
    setMissing("clickY", point.y);
  }

  if (type === "hotkey") {
    setMissing("hotkey", target);
    setMissing("mode", "hwnd-key");
  }
  if (type === "text_input") {
    setMissing("text", commandValue(command, "text") || commandValue(command, "value") || target);
    setMissing("mode", "hwnd-char");
  }
  const hasClickPointParams = hasParam(params, "clickX") && hasParam(params, "clickY");
  if (
    ["image_click", "wait_image", "detect_page"].includes(type) ||
    (type === "double_click" && !point && !hasClickPointParams)
  ) {
    setMissing("imageTarget", target);
  }
  if (type === "delay") {
    setMissing("delayMs", durationMsFromText(target) ?? timeoutMs);
  }
  if (type === "condition") {
    setMissing("conditionLabel", target);
  }
  if (type === "retry_until") {
    setMissing("retryTarget", target);
  }
  if (type === "ocr_assert") {
    const commandText = commandValue(command, "text") || commandValue(command, "contains") || commandValue(command, "expect");
    const expectedText = isGenericOcrExpectation(expect) ? "" : expect;
    setMissing("ocrText", commandText || target || expectedText);
  }

  return params;
}

export function projectStepParamsToLegacy(step = {}) {
  const type = String(step.type || "");
  const params = normalizeParamsObject(step.params);
  let target = String(step.target || "");
  let command = String(step.command || "");
  let expect = String(step.expect || "");
  let timeoutMs = finiteNonNegativeInteger(step.timeoutMs) ?? 0;
  const updates = {};

  putDurationUpdate(updates, "preDelay", params, "preDelayMs");
  putDurationUpdate(updates, "postDelay", params, "postDelayMs");
  putValueUpdate(updates, "mode", params, "mode");
  putValueUpdate(updates, "button", params, "button");
  putValueUpdate(updates, "threshold", params, "threshold");
  putValueUpdate(updates, "point", params, "point");
  putValueUpdate(updates, "offsetX", params, "offsetX");
  putValueUpdate(updates, "offsetY", params, "offsetY");
  putValueUpdate(updates, "reason", params, "reason");
  putValueUpdate(updates, "guard", params, "guard");
  putDurationUpdate(updates, "interval", params, "intervalMs");
  putValueUpdate(updates, "roi", params, "roi");
  putValueUpdate(updates, "lang", params, "lang");

  if (type === "hotkey") {
    if (hasParam(params, "hotkey")) target = textParam(params.hotkey);
    updates.mode = updates.mode || "hwnd-key";
  }
  if (type === "text_input") {
    if (hasParam(params, "text")) target = textParam(params.text);
    updates.mode = updates.mode || "hwnd-char";
    if (commandValue(command, "text")) updates.text = target;
    if (commandValue(command, "value")) updates.value = target;
  }
  if (["click", "double_click"].includes(type) && hasParam(params, "clickX") && hasParam(params, "clickY")) {
    const x = finiteNonNegativeInteger(params.clickX);
    const y = finiteNonNegativeInteger(params.clickY);
    if (x != null && y != null) target = `x=${x},y=${y}`;
    updates.mode = updates.mode || "hwnd-message";
  }
  if (["image_click", "double_click", "wait_image", "detect_page"].includes(type) && hasParam(params, "imageTarget")) {
    target = textParam(params.imageTarget);
  }
  if (type === "delay" && hasParam(params, "delayMs")) {
    const ms = finiteNonNegativeInteger(params.delayMs);
    if (ms != null) {
      target = `${ms}ms`;
      timeoutMs = ms;
    }
  }
  if (type === "condition" && hasParam(params, "conditionLabel")) {
    target = textParam(params.conditionLabel);
  }
  if (type === "retry_until" && hasParam(params, "retryTarget")) {
    target = textParam(params.retryTarget);
  }
  if (type === "ocr_assert" && hasParam(params, "ocrText")) {
    expect = textParam(params.ocrText);
  }

  command = commandWithValues(command, updates);
  return { target, command, expect, timeoutMs, params };
}

export function syncStepParamsToLegacy(step = {}) {
  const params = normalizeStepParams(step);
  const projected = projectStepParamsToLegacy({ ...step, params });
  return { ...step, ...projected };
}

export function syncStepParamsFromLegacy(step = {}) {
  const params = normalizeParamsObject(step.params);
  for (const key of STEP_PARAM_KEYS) {
    delete params[key];
  }
  Object.assign(params, normalizeStepParams(step, { preferLegacy: true }));
  const projected = projectStepParamsToLegacy({ ...step, params });
  return { ...step, ...projected };
}

export function stepParamValue(step, key, fallback = "") {
  const params = normalizeStepParams(step);
  return hasParam(params, key) ? params[key] : fallback;
}

function normalizeParamsObject(value) {
  const result = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return result;
  for (const [key, raw] of Object.entries(value)) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(key)) continue;
    if (raw === undefined || raw === null || raw === "") continue;
    if (["string", "number", "boolean"].includes(typeof raw)) result[key] = raw;
  }
  return result;
}

function hasParam(params, key) {
  return Object.prototype.hasOwnProperty.call(params || {}, key) && params[key] !== undefined && params[key] !== null && params[key] !== "";
}

function putValueUpdate(updates, commandKey, params, paramKey) {
  if (hasParam(params, paramKey)) updates[commandKey] = textParam(params[paramKey]);
}

function putDurationUpdate(updates, commandKey, params, paramKey) {
  if (!hasParam(params, paramKey)) return;
  const ms = finiteNonNegativeInteger(params[paramKey]);
  updates[commandKey] = ms == null ? "" : `${ms}ms`;
}

function textParam(value) {
  return String(value ?? "").trim();
}

function finiteNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function finiteInteger(value) {
  const number = finiteNumber(value);
  return number == null ? null : Math.trunc(number);
}

function finiteNonNegativeInteger(value) {
  const number = finiteInteger(value);
  return number != null && number >= 0 ? number : null;
}

function isGenericOcrExpectation(value) {
  return new Set(["text_found", "matched", "visible", "ok", "success", "ready=true"]).has(
    String(value || "")
      .trim()
      .toLowerCase(),
  );
}
