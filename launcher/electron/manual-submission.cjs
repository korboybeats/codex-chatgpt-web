const { createHash } = require("node:crypto");

const SUBMISSION_FILTER = {
  urls: ["https://chatgpt.com/backend-api/conversation", "https://chatgpt.com/backend-api/f/conversation"],
};
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const OBSERVATION_FILTER = { urls: [...SUBMISSION_FILTER.urls, "https://*.oaiusercontent.com/*"] };
const UUID_SEGMENT = /^(?:file[-_])?([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|[a-f0-9]{32})$/;

// This is the storage representation of the same file_<32 hex> attachment ID.
// Unknown origins and ambiguous paths cannot establish file identity.
function uploadedFileId(value) {
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== "https:" || url.port || url.username || url.password
    || !(url.hostname === "files.oaiusercontent.com" || /^sdmntpr[a-z0-9]+\.oaiusercontent\.com$/.test(url.hostname))) return null;
  const ids = url.pathname.split("/").map(part => part.match(UUID_SEGMENT)).filter(Boolean);
  if (ids.length !== 1) return null;
  return `file_${ids[0][1].replaceAll("-", "")}`;
}

function promptUpload(details) {
  if (details.method !== "PUT" || details.resourceType !== "xhr"
    || !Array.isArray(details.uploadData) || details.uploadData.length !== 1) return null;
  const fileId = uploadedFileId(details.url);
  if (!fileId) return null;
  // Electron supplies an opaque blob handle; its spelling is not proof of identity.
  const part = details.uploadData[0];
  if (part.file || typeof part.blobUUID !== "string"
    || part.blobUUID.length === 0) return null;
  return { fileId, blobUUID: part.blobUUID };
}

// Inspect only an outgoing new user message, never history, cookies, headers or files.
// Unknown transports, encodings and content shapes deliberately require manual Sent.
function submissionMessage(details) {
  if (details.method !== "POST" || !SUBMISSION_FILTER.urls.includes(details.url)
    || details.resourceType !== "xhr" || !Array.isArray(details.uploadData)
    || details.uploadData.length === 0) return false;
  let size = 0;
  for (const part of details.uploadData) {
    if (!Buffer.isBuffer(part.bytes) || part.file || part.blobUUID) return false;
    size += part.bytes.length;
    if (size > MAX_REQUEST_BYTES) return false;
  }
  try {
    const body = JSON.parse(Buffer.concat(details.uploadData.map(part => part.bytes)).toString("utf8"));
    if (body.action !== "next" || !Array.isArray(body.messages) || body.messages.length !== 1) return false;
    const message = body.messages[0];
    if (message?.author?.role !== "user" || typeof message.id !== "string" || !message.id) return false;
    const content = message.content;
    if (!["text", "multimodal_text"].includes(content?.content_type) || !Array.isArray(content.parts)) return false;
    const text = content.parts.filter(part => typeof part === "string");
    if (text.length !== 1) return false;
    if (content.parts.some(part => typeof part !== "string"
      && !(content.content_type === "multimodal_text" && part?.content_type === "image_asset_pointer"
        && typeof part.asset_pointer === "string" && part.asset_pointer.startsWith("file-service://")))) return false;
    return { text: text[0], metadata: message.metadata };
  } catch {
    return null;
  }
}

function matchesManualPrompt(details, promptDigest) {
  const message = submissionMessage(details);
  if (!message) return false;
  const matches = value => createHash("sha256").update(value, "utf8").digest("hex") === promptDigest;
  if (matches(message.text)) return true;
  // ChatGPT serializes its selected Zero Risk connector chip as this leading mention.
  // Remove only that exact transport prefix; never trim or normalize prompt text.
  const mention = "@Codex Zero Risk ";
  return message.text.startsWith(mention) && matches(message.text.slice(mention.length));
}

// Only an actual submitted big-paste attachment can use previously verified upload
// evidence, and its claimed size must equal the prepared prompt size.
function pastedPromptFile(details, expectedBytes) {
  const message = submissionMessage(details);
  if (!message || !/^(?:\s*|\s*@Codex Zero Risk\s*)$/.test(message.text)
    || !Number.isSafeInteger(expectedBytes) || expectedBytes < 1 || expectedBytes > MAX_REQUEST_BYTES
    || !Array.isArray(message.metadata?.attachments)) return null;
  const pastes = message.metadata.attachments.filter(file => file?.is_big_paste === true);
  if (pastes.length !== 1) return null;
  const file = pastes[0];
  return /^file_[a-f0-9]{32}$/.test(file.id) && file.mime_type === "text/plain"
    && file.size === expectedBytes && message.metadata.attachments.filter(other => other?.id === file.id).length === 1
    ? file.id : null;
}

function successfulSubmissionResponse(details) {
  const type = Object.entries(details.responseHeaders || {})
    .find(([name]) => name.toLowerCase() === "content-type")?.[1];
  return details.statusCode === 200 && details.fromCache === false
    && Array.isArray(type) && type.length === 1 && typeof type[0] === "string"
    && type[0].split(";", 1)[0].trim().toLowerCase() === "text/event-stream";
}

module.exports = { SUBMISSION_FILTER, OBSERVATION_FILTER, uploadedFileId, promptUpload, pastedPromptFile, matchesManualPrompt, successfulSubmissionResponse };
