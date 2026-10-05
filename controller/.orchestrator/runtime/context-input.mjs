import path from "node:path";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";

const INLINE_BINARY_DATA_URI = /data:(?:image|audio|video)\/[a-z0-9.+-]+(?:;[^,\s]*)?,/i;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const DEFAULT_LIMITS = Object.freeze({
  maxTextBytes: 256 * 1024,
  maxMediaItems: 16,
  maxMediaItemBytes: 32 * 1024 * 1024,
  maxMediaBytes: 64 * 1024 * 1024,
});

const IMAGE_MIME_TYPES = new Map([
  [".bmp", "image/bmp"],
  [".gif", "image/gif"],
  [".jpeg", "image/jpeg"],
  [".jpg", "image/jpeg"],
  [".png", "image/png"],
  [".tif", "image/tiff"],
  [".tiff", "image/tiff"],
  [".webp", "image/webp"],
]);

function contextError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function pathInside(rootPath, candidatePath) {
  const relative = path.relative(rootPath, candidatePath);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function portableRelativePath(value) {
  if (typeof value !== "string" || !value.trim()) {
    throw contextError("MEDIA_PATH_REQUIRED", "Every media reference requires a non-empty project-relative path");
  }
  if (value.includes("\0") || path.isAbsolute(value) || /^[a-z][a-z0-9+.-]*:/i.test(value)) {
    throw contextError("MEDIA_PATH_NOT_PORTABLE", `Media paths must be project-relative, not absolute paths or URIs: ${value}`);
  }
  const normalized = path.normalize(value.replaceAll("/", path.sep).replaceAll("\\", path.sep));
  if (normalized === ".." || normalized.startsWith(`..${path.sep}`)) {
    throw contextError("MEDIA_PATH_OUTSIDE_WORKSPACE", `Media path escapes the worker workspace: ${value}`);
  }
  return normalized;
}

async function sha256File(filePath) {
  const hash = createHash("sha256");
  await new Promise((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", resolve);
  });
  return hash.digest("hex");
}

export function assertSafeContextText(text, { maxTextBytes = DEFAULT_LIMITS.maxTextBytes } = {}) {
  if (typeof text !== "string" || !text.trim()) {
    throw contextError("CONTEXT_TEXT_REQUIRED", "Worker message cannot be empty");
  }
  const textBytes = Buffer.byteLength(text, "utf8");
  if (textBytes > maxTextBytes) {
    throw contextError("CONTEXT_TEXT_TOO_LARGE", `Worker message is ${textBytes} bytes; limit is ${maxTextBytes} bytes`);
  }
  if (INLINE_BINARY_DATA_URI.test(text)) {
    throw contextError(
      "INLINE_MEDIA_FORBIDDEN",
      "Inline media data URIs are forbidden in agent context. Store the file in the workspace and pass a media reference instead.",
    );
  }
  return {
    text,
    textBytes,
    textSha256: createHash("sha256").update(text, "utf8").digest("hex"),
  };
}

export function normalizeAppServerInput(input) {
  const items = typeof input === "string" ? [{ type: "text", text: input }] : input;
  if (!Array.isArray(items) || items.length === 0) {
    throw contextError("CONTEXT_INPUT_REQUIRED", "Codex turn input must contain at least one item");
  }
  return items.map((item) => {
    if (!item || typeof item !== "object") {
      throw contextError("CONTEXT_INPUT_INVALID", "Codex turn input items must be objects");
    }
    if (item.type === "text") {
      assertSafeContextText(item.text);
      return { type: "text", text: item.text };
    }
    if (item.type === "localImage") {
      if (typeof item.path !== "string" || !path.isAbsolute(item.path)) {
        throw contextError("LOCAL_IMAGE_PATH_INVALID", "App Server localImage input requires an absolute resolved path");
      }
      return { type: "localImage", path: item.path };
    }
    if (item.type === "image") {
      throw contextError(
        "REMOTE_IMAGE_INPUT_FORBIDDEN",
        "The orchestrator accepts localImage references only; remote URLs and data URIs are not persisted safely.",
      );
    }
    throw contextError("CONTEXT_INPUT_UNSUPPORTED", `Unsupported Codex turn input type: ${item.type ?? "missing"}`);
  });
}

export async function prepareTurnContext({
  text,
  media = [],
  workspaceRoot,
  limits = {},
} = {}) {
  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };
  const textDetails = assertSafeContextText(text, effectiveLimits);
  if (!Array.isArray(media)) throw contextError("MEDIA_REFERENCES_INVALID", "media must be an array of references");
  if (media.length > effectiveLimits.maxMediaItems) {
    throw contextError(
      "MEDIA_ITEM_LIMIT_EXCEEDED",
      `Turn contains ${media.length} media references; limit is ${effectiveLimits.maxMediaItems}`,
    );
  }

  const workspaceRealPath = await realpath(path.resolve(workspaceRoot));
  const resolvedMedia = [];
  const resolvedPaths = new Set();
  const contentHashes = new Set();
  let mediaBytes = 0;
  for (const reference of media) {
    if (!reference || typeof reference !== "object" || Array.isArray(reference)) {
      throw contextError("MEDIA_REFERENCE_INVALID", "Each media reference must be an object");
    }
    const unsupportedProperties = Object.keys(reference).filter((key) => !["kind", "path", "sha256", "label"].includes(key));
    if (unsupportedProperties.length > 0) {
      throw contextError(
        "MEDIA_REFERENCE_PROPERTY_UNSUPPORTED",
        `Unsupported media reference properties: ${unsupportedProperties.join(", ")}`,
      );
    }
    if (typeof reference.kind !== "string" || !reference.kind) {
      throw contextError("MEDIA_KIND_REQUIRED", "Every media reference requires an explicit kind");
    }
    if (reference.sha256 !== undefined && typeof reference.sha256 !== "string") {
      throw contextError("MEDIA_HASH_INVALID", `Media sha256 must be a string: ${reference.path ?? "unknown"}`);
    }
    if (reference.label !== undefined && typeof reference.label !== "string") {
      throw contextError("MEDIA_LABEL_INVALID", `Media label must be a string: ${reference.path ?? "unknown"}`);
    }
    const kind = reference.kind;
    if (kind !== "image") {
      throw contextError(
        "MEDIA_KIND_UNSUPPORTED",
        `Unsupported media kind '${kind}'. Extract an image, transcript, or text artifact and reference that instead.`,
      );
    }
    const relativePath = portableRelativePath(reference.path);
    const candidatePath = path.resolve(workspaceRealPath, relativePath);
    let resolvedPath;
    try {
      resolvedPath = await realpath(candidatePath);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw contextError("MEDIA_FILE_NOT_FOUND", `Media file does not exist: ${reference.path}`);
      }
      throw error;
    }
    if (!pathInside(workspaceRealPath, resolvedPath)) {
      throw contextError("MEDIA_PATH_OUTSIDE_WORKSPACE", `Media path resolves outside the worker workspace: ${reference.path}`);
    }
    const identityPath = process.platform === "win32" ? resolvedPath.toLowerCase() : resolvedPath;
    if (resolvedPaths.has(identityPath)) {
      throw contextError("MEDIA_REFERENCE_DUPLICATE", `Media file is referenced more than once in the same turn: ${reference.path}`);
    }
    resolvedPaths.add(identityPath);
    const details = await stat(resolvedPath);
    if (!details.isFile()) throw contextError("MEDIA_PATH_NOT_FILE", `Media path is not a file: ${reference.path}`);
    if (details.size > effectiveLimits.maxMediaItemBytes) {
      throw contextError(
        "MEDIA_FILE_TOO_LARGE",
        `Media file '${reference.path}' is ${details.size} bytes; per-file limit is ${effectiveLimits.maxMediaItemBytes}`,
      );
    }
    mediaBytes += details.size;
    if (mediaBytes > effectiveLimits.maxMediaBytes) {
      throw contextError(
        "MEDIA_TOTAL_LIMIT_EXCEEDED",
        `Turn references ${mediaBytes} media bytes; aggregate limit is ${effectiveLimits.maxMediaBytes}`,
      );
    }
    const extension = path.extname(resolvedPath).toLowerCase();
    const mimeType = IMAGE_MIME_TYPES.get(extension);
    if (!mimeType) {
      throw contextError("MEDIA_TYPE_UNSUPPORTED", `Unsupported image extension '${extension || "none"}': ${reference.path}`);
    }
    const expectedSha256 = reference.sha256 ? String(reference.sha256).toLowerCase() : null;
    if (expectedSha256 && !SHA256_PATTERN.test(expectedSha256)) {
      throw contextError("MEDIA_HASH_INVALID", `Media sha256 must contain 64 hexadecimal characters: ${reference.path}`);
    }
    const actualSha256 = await sha256File(resolvedPath);
    if (expectedSha256 && actualSha256 !== expectedSha256) {
      throw contextError("MEDIA_HASH_MISMATCH", `Media sha256 does not match the referenced file: ${reference.path}`);
    }
    if (contentHashes.has(actualSha256)) {
      throw contextError("MEDIA_CONTENT_DUPLICATE", `Identical media content is referenced more than once in the same turn: ${reference.path}`);
    }
    contentHashes.add(actualSha256);
    resolvedMedia.push({
      kind,
      path: relativePath.split(path.sep).join("/"),
      resolvedPath,
      mimeType,
      bytes: details.size,
      sha256: actualSha256,
      label: typeof reference.label === "string" ? reference.label.slice(0, 256) : null,
    });
  }

  return {
    input: normalizeAppServerInput([
      { type: "text", text },
      ...resolvedMedia.map((item) => ({ type: "localImage", path: item.resolvedPath })),
    ]),
    media: resolvedMedia.map(({ resolvedPath: _resolvedPath, ...metadata }) => metadata),
    totals: {
      textBytes: textDetails.textBytes,
      textSha256: textDetails.textSha256,
      mediaItems: resolvedMedia.length,
      mediaBytes,
    },
  };
}

export const contextInputLimits = DEFAULT_LIMITS;
