const { createHash } = require("node:crypto");

const SUBMISSION_FILTER = {
  urls: ["https://chatgpt.com/backend-api/conversation", "https://chatgpt.com/backend-api/f/conversation"],
};
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;

// Inspect only an outgoing new user message, never history, cookies, headers or files.
// Unknown transports, encodings and content shapes deliberately require manual Sent.
function matchesManualPrompt(details, promptDigest) {
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
    const matches = value => createHash("sha256").update(value, "utf8").digest("hex") === promptDigest;
    if (matches(text[0])) return true;
    // ChatGPT serializes its selected Zero Risk connector chip as this leading mention.
    // Remove only that exact transport prefix; never trim or normalize prompt text.
    const mention = "@Codex Zero Risk ";
    return text[0].startsWith(mention) && matches(text[0].slice(mention.length));
  } catch {
    return false;
  }
}

function successfulSubmissionResponse(details) {
  const type = Object.entries(details.responseHeaders || {})
    .find(([name]) => name.toLowerCase() === "content-type")?.[1];
  return details.statusCode === 200 && details.fromCache === false
    && Array.isArray(type) && type.length === 1 && typeof type[0] === "string"
    && type[0].split(";", 1)[0].trim().toLowerCase() === "text/event-stream";
}

module.exports = { SUBMISSION_FILTER, matchesManualPrompt, successfulSubmissionResponse };
