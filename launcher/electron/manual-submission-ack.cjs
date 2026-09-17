const { createHash } = require("node:crypto");
const { StringDecoder } = require("node:string_decoder");
const { SUBMISSION_FILTER } = require("./manual-submission.cjs");

const MAX_ACK_BYTES = 64 * 1024;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const opaqueId = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

// Only the initial server handoff is needed. Never retain tokens or response content.
class SubmissionAckParser {
  constructor() {
    this.decoder = new StringDecoder("utf8");
    this.buffer = "";
    this.bytes = 0;
    this.conversationId = null;
    this.result = null;
  }

  push(bytes) {
    if (this.result !== null) return this.result;
    this.bytes += bytes.length;
    if (this.bytes > MAX_ACK_BYTES) return this.finish(false);
    this.buffer += this.decoder.write(bytes);
    let boundary;
    while ((boundary = /\r?\n\r?\n/.exec(this.buffer))) {
      const event = this.buffer.slice(0, boundary.index);
      this.buffer = this.buffer.slice(boundary.index + boundary[0].length);
      if (/^event:\s*error\s*$/m.test(event)) return this.finish(false);
      const data = event.split(/\r?\n/).filter(line => line.startsWith("data:"))
        .map(line => line.slice(5).trimStart()).join("\n");
      if (!data) continue;
      if (data === "[DONE]") return this.finish(false);
      let value;
      try { value = JSON.parse(data); } catch { return this.finish(false); }
      if (value === "v1") continue;
      if (!value || typeof value !== "object" || Array.isArray(value)) return this.finish(false);
      if (value.error || value.type === "error") return this.finish(false);
      if (value.type === "resume_conversation_token") {
        if (this.conversationId || !opaqueId(value.conversation_id)
          || typeof value.token !== "string" || !value.token) return this.finish(false);
        this.conversationId = value.conversation_id;
      } else if (value.type === "stream_handoff") {
        return this.finish(!!this.conversationId && value.conversation_id === this.conversationId
          && opaqueId(value.turn_exchange_id));
      } else {
        // Unknown transports use the existing connector/manual fallback.
        return this.finish(false);
      }
    }
    return null;
  }

  finish(result) {
    this.result = result;
    this.buffer = "";
    this.conversationId = null;
    this.decoder = null;
    return result;
  }
}

// A read-only, short-lived native Network observer. No page scripts, input, Fetch
// interception, request rewriting or response buffering after acknowledgement.
function observeSubmissionAck(contents, { eligible, evidence, acknowledged }) {
  const dbg = contents?.debugger;
  let attached = false, disposed = false, request = null;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    request = null;
    dbg?.removeListener("message", onMessage);
    dbg?.removeListener("detach", onDetach);
    if (attached) {
      attached = false;
      try { dbg.detach(); } catch { /* The renderer may already be gone. */ }
    }
  };
  const onDetach = () => { attached = false; dispose(); };
  const current = record => !disposed && eligible() && request === record
    && evidence() === record.evidence && contents.mainFrame === record.evidence.frame;
  const feed = (record, encoded) => {
    if (!current(record)) return dispose();
    if (typeof encoded !== "string" || encoded.length > MAX_ACK_BYTES * 2) return dispose();
    const result = record.parser.push(Buffer.from(encoded, "base64"));
    if (result !== null) {
      const owned = record.evidence;
      dispose();
      if (result) acknowledged(owned);
    }
  };
  const stream = async record => {
    try {
      const tree = await dbg.sendCommand("Page.getFrameTree");
      if (!current(record) || tree?.frameTree?.frame?.id !== record.frameId) return dispose();
      record.pending = true;
      const result = await dbg.sendCommand("Network.streamResourceContent", { requestId: record.id });
      if (!current(record)) return dispose();
      feed(record, result.bufferedData || "");
      record.pending = false;
      for (const chunk of record.queued) {
        if (disposed) break;
        feed(record, chunk);
      }
      record.queued = [];
      if (record.finished) dispose();
    } catch { dispose(); }
  };
  const onMessage = (_event, method, params, sessionId) => {
    try {
      if (sessionId) return; // Never inspect a child target.
      if (!eligible()) return dispose();
      if (method === "Network.requestWillBeSent" && SUBMISSION_FILTER.urls.includes(params.request?.url)) {
        // A retry or replacement invalidates an already-open response stream.
        if (request?.parser) return dispose();
        request = null;
        const body = params.request.postData;
        if (params.redirectResponse || params.request.method !== "POST"
          || !["Fetch", "XHR"].includes(params.type) || typeof body !== "string"
          || typeof params.frameId !== "string" || !params.frameId
          || typeof params.requestId !== "string" || !params.requestId
          || Buffer.byteLength(body) > MAX_REQUEST_BYTES) return;
        request = { id: params.requestId, frameId: params.frameId,
          digest: createHash("sha256").update(body).digest("hex") };
      }
      const record = request;
      if (!record || params.requestId !== record.id) return;
      if (method === "Network.responseReceived") {
        if (record.parser) return;
        const owned = evidence();
        const response = params.response;
        if (!owned || record.digest !== owned.requestDigest || response?.status !== 200
          || response.mimeType !== "text/event-stream" || response.fromDiskCache
          || response.fromServiceWorker || response.fromPrefetchCache) return dispose();
        record.evidence = owned;
        record.parser = new SubmissionAckParser();
        record.queued = [];
        record.queuedBytes = 0;
        record.pending = true;
        void stream(record);
      } else if (method === "Network.dataReceived" && record.parser && params.data) {
        if (record.pending) {
          record.queuedBytes += params.data.length;
          if (record.queuedBytes > MAX_ACK_BYTES * 2) return dispose();
          record.queued.push(params.data);
        } else feed(record, params.data);
      } else if (method === "Network.loadingFailed") {
        dispose();
      } else if (method === "Network.loadingFinished") {
        if (record.pending) record.finished = true;
        else dispose();
      }
    } catch { dispose(); } // Optional detection must not affect the request or manual Sent.
  };
  try {
    if (!dbg || dbg.isAttached()) return { dispose() {} }; // Never take another debugger's ownership.
    dbg.attach("1.3");
    attached = true;
    dbg.on("message", onMessage);
    dbg.on("detach", onDetach);
    void dbg.sendCommand("Network.enable", { maxPostDataSize: MAX_REQUEST_BYTES,
      maxResourceBufferSize: MAX_ACK_BYTES, maxTotalBufferSize: MAX_ACK_BYTES }).catch(dispose);
  } catch { dispose(); }
  return { dispose };
}

module.exports = { SubmissionAckParser, observeSubmissionAck };
