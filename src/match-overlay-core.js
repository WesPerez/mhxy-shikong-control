/** Pure helpers for vision match-box overlay geometry (no DOM, no live claims). */

export function normalizeMatchBox(input) {
  if (!input || typeof input !== "object") return null;
  const x = toFiniteNumber(input.matchX ?? input.match_x ?? input.x);
  const y = toFiniteNumber(input.matchY ?? input.match_y ?? input.y);
  const width = toFiniteNumber(input.matchWidth ?? input.match_width ?? input.width ?? input.w);
  const height = toFiniteNumber(input.matchHeight ?? input.match_height ?? input.height ?? input.h);
  if (x === null || y === null || width === null || height === null) return null;
  if (width < 1 || height < 1) return null;
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
  };
}

export function projectMatchBoxToStage(box, preview, imageRect, stageRect) {
  const normalized = normalizeMatchBox(box);
  if (!normalized || !preview || !imageRect || !stageRect) return null;
  const previewWidth = toFiniteNumber(preview.width);
  const previewHeight = toFiniteNumber(preview.height);
  if (!previewWidth || !previewHeight || previewWidth < 1 || previewHeight < 1) return null;
  const imageWidth = toFiniteNumber(imageRect.width);
  const imageHeight = toFiniteNumber(imageRect.height);
  if (!imageWidth || !imageHeight || imageWidth <= 0 || imageHeight <= 0) return null;
  const scaleX = imageWidth / previewWidth;
  const scaleY = imageHeight / previewHeight;
  const left = (toFiniteNumber(imageRect.left) || 0) - (toFiniteNumber(stageRect.left) || 0) + normalized.x * scaleX;
  const top = (toFiniteNumber(imageRect.top) || 0) - (toFiniteNumber(stageRect.top) || 0) + normalized.y * scaleY;
  return {
    left,
    top,
    width: normalized.width * scaleX,
    height: normalized.height * scaleY,
    label: `match: ${normalized.x},${normalized.y} ${normalized.width}x${normalized.height}`,
  };
}

export function matchBoxMetaText(box) {
  const normalized = normalizeMatchBox(box);
  if (!normalized) return "Match: none";
  return `Match: ${normalized.x},${normalized.y} ${normalized.width}x${normalized.height}`;
}

export function pickMatchFieldsFromResult(result) {
  if (!result || typeof result !== "object") {
    return {
      matchX: null,
      matchY: null,
      matchWidth: null,
      matchHeight: null,
    };
  }
  const box = normalizeMatchBox(result);
  if (!box) {
    return {
      matchX: result.matchX ?? result.match_x ?? null,
      matchY: result.matchY ?? result.match_y ?? null,
      matchWidth: result.matchWidth ?? result.match_width ?? null,
      matchHeight: result.matchHeight ?? result.match_height ?? null,
    };
  }
  return {
    matchX: box.x,
    matchY: box.y,
    matchWidth: box.width,
    matchHeight: box.height,
  };
}

function toFiniteNumber(value) {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
