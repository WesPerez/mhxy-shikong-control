/** Content-addressed asset fileization helpers for workspace targets. */

const DATA_URL_RE = /^data:([^;,]+)?((?:;[^,]*)*);base64,([A-Za-z0-9+/=\s]+)$/i;

export function parseDataUrl(dataUrl) {
  const raw = String(dataUrl || "").trim();
  if (!raw) return null;
  const match = raw.match(DATA_URL_RE);
  if (!match) return null;
  const mime = String(match[1] || "application/octet-stream").trim().toLowerCase() || "application/octet-stream";
  const base64 = String(match[3] || "").replace(/\s+/g, "");
  if (!base64) return null;
  let bytes;
  try {
    if (typeof Buffer !== "undefined") {
      bytes = Uint8Array.from(Buffer.from(base64, "base64"));
    } else if (typeof atob === "function") {
      const binary = atob(base64);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    } else {
      return null;
    }
  } catch {
    return null;
  }
  if (!bytes.length) return null;
  return { mime, bytes, base64 };
}

export function extensionForMime(mime) {
  const value = String(mime || "").toLowerCase();
  if (value === "image/png") return "png";
  if (value === "image/jpeg" || value === "image/jpg") return "jpg";
  if (value === "image/webp") return "webp";
  if (value === "image/gif") return "gif";
  if (value === "image/bmp") return "bmp";
  return "bin";
}

export function buildAssetRelativePath(contentHash, mime, root = "assets/by-hash") {
  const hash = String(contentHash || "").trim().toLowerCase();
  if (!/^[a-f0-9]{16,}$/.test(hash)) {
    throw new Error("contentHash must be a hex digest");
  }
  const ext = extensionForMime(mime);
  const prefix = String(root || "assets/by-hash").replace(/\\+/g, "/").replace(/\/+$/, "");
  return `${prefix}/${hash.slice(0, 2)}/${hash}.${ext}`;
}

export async function defaultHashBytes(bytes) {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  if (typeof globalThis.crypto?.subtle?.digest === "function") {
    const digest = await globalThis.crypto.subtle.digest("SHA-256", view);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(view).digest("hex");
}

export function bytesToDataUrl(bytes, mime = "application/octet-stream") {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
  let base64;
  if (typeof Buffer !== "undefined") {
    base64 = Buffer.from(view).toString("base64");
  } else if (typeof btoa === "function") {
    let binary = "";
    for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
    base64 = btoa(binary);
  } else {
    throw new Error("no base64 encoder available");
  }
  return `data:${mime || "application/octet-stream"};base64,${base64}`;
}

export async function fileizeTargetAsset(target, options = {}) {
  const hashBytes = options.hashBytes || defaultHashBytes;
  const assetRoot = options.assetRoot || "assets/by-hash";
  const source = target && typeof target === "object" ? target : {};
  const existingHash = String(source.contentHash || source.sha256 || "").trim().toLowerCase();
  const existingPath = String(source.assetPath || source.filePath || "").trim().replace(/\\/g, "/");
  const parsed = parseDataUrl(source.dataUrl);

  if (!parsed) {
    if (existingHash && existingPath) {
      return {
        target: {
          ...source,
          contentHash: existingHash,
          assetPath: existingPath,
          assetMime: source.assetMime || source.mime || "",
          assetByteLength: Number(source.assetByteLength) || 0,
        },
        asset: {
          contentHash: existingHash,
          relativePath: existingPath,
          mime: source.assetMime || source.mime || "",
          byteLength: Number(source.assetByteLength) || 0,
          bytes: null,
          reused: true,
        },
        wroteInline: false,
      };
    }
    return { target: { ...source }, asset: null, wroteInline: false };
  }

  const contentHash = await hashBytes(parsed.bytes);
  const relativePath =
    existingHash === contentHash && existingPath
      ? existingPath
      : buildAssetRelativePath(contentHash, parsed.mime, assetRoot);

  const next = {
    ...source,
    contentHash,
    assetPath: relativePath,
    assetMime: parsed.mime,
    assetByteLength: parsed.bytes.length,
  };

  return {
    target: next,
    asset: {
      contentHash,
      relativePath,
      mime: parsed.mime,
      byteLength: parsed.bytes.length,
      bytes: parsed.bytes,
      reused: false,
    },
    wroteInline: true,
  };
}

export async function fileizeWorkspaceAssets(workspace, options = {}) {
  const source = workspace && typeof workspace === "object" ? workspace : {};
  const targets = Array.isArray(source.targets) ? source.targets : [];
  const assetIndex = new Map();
  const nextTargets = [];
  let extracted = 0;
  let reused = 0;

  for (const target of targets) {
    const result = await fileizeTargetAsset(target, options);
    nextTargets.push(result.target);
    if (!result.asset) continue;
    if (result.wroteInline) extracted += 1;
    else reused += 1;
    const key = result.asset.contentHash;
    const prev = assetIndex.get(key);
    if (!prev) {
      assetIndex.set(key, {
        contentHash: result.asset.contentHash,
        relativePath: result.asset.relativePath,
        mime: result.asset.mime,
        byteLength: result.asset.byteLength,
        bytes: result.asset.bytes,
        targetIds: [String(result.target.id || "")].filter(Boolean),
      });
    } else {
      const id = String(result.target.id || "");
      if (id && !prev.targetIds.includes(id)) prev.targetIds.push(id);
      if (!prev.bytes && result.asset.bytes) prev.bytes = result.asset.bytes;
      if (!prev.mime && result.asset.mime) prev.mime = result.asset.mime;
      if (!prev.byteLength && result.asset.byteLength) prev.byteLength = result.asset.byteLength;
    }
  }

  const assets = [...assetIndex.values()];
  return {
    workspace: {
      ...source,
      targets: nextTargets,
      assetIndex: assets.map(({ contentHash, relativePath, mime, byteLength, targetIds }) => ({
        contentHash,
        relativePath,
        mime,
        byteLength,
        targetIds,
      })),
    },
    assetsToWrite: assets.filter((item) => item.bytes && item.bytes.length),
    stats: {
      targetCount: targets.length,
      extracted,
      reused,
      uniqueAssets: assetIndex.size,
      duplicateRefs: Math.max(0, extracted + reused - assetIndex.size),
    },
  };
}

export function prepareWorkspaceForPersistence(workspace, options = {}) {
  const keepDataUrl = options.keepDataUrl === true;
  const source = workspace && typeof workspace === "object" ? workspace : {};
  const targets = Array.isArray(source.targets) ? source.targets : [];
  let stripped = 0;
  const nextTargets = targets.map((target) => {
    if (!target || typeof target !== "object") return target;
    const contentHash = String(target.contentHash || "").trim();
    const assetPath = String(target.assetPath || "").trim();
    if (!keepDataUrl && target.dataUrl && contentHash && assetPath) {
      stripped += 1;
      const clone = { ...target };
      delete clone.dataUrl;
      return clone;
    }
    return { ...target };
  });
  return {
    workspace: {
      ...source,
      targets: nextTargets,
    },
    stats: { stripped, targetCount: targets.length },
  };
}

export async function rehydrateTargetAssets(targets, loader) {
  if (typeof loader !== "function") throw new Error("loader is required");
  const list = Array.isArray(targets) ? targets : [];
  const next = [];
  let restored = 0;
  for (const target of list) {
    if (!target || typeof target !== "object") {
      next.push(target);
      continue;
    }
    if (target.dataUrl) {
      next.push({ ...target });
      continue;
    }
    const key = target.contentHash || target.assetPath;
    if (!key) {
      next.push({ ...target });
      continue;
    }
    const loaded = await loader({
      contentHash: target.contentHash || "",
      assetPath: target.assetPath || "",
      mime: target.assetMime || "",
    });
    if (!loaded) {
      next.push({ ...target });
      continue;
    }
    let dataUrl = "";
    if (typeof loaded === "string") dataUrl = loaded;
    else if (loaded instanceof Uint8Array) dataUrl = bytesToDataUrl(loaded, target.assetMime || "application/octet-stream");
    else if (loaded && typeof loaded === "object") {
      if (loaded.dataUrl) dataUrl = String(loaded.dataUrl);
      else if (loaded.bytes) dataUrl = bytesToDataUrl(loaded.bytes, loaded.mime || target.assetMime || "application/octet-stream");
    }
    if (!dataUrl) {
      next.push({ ...target });
      continue;
    }
    restored += 1;
    next.push({ ...target, dataUrl, loaded: true });
  }
  return { targets: next, stats: { restored, targetCount: list.length } };
}
