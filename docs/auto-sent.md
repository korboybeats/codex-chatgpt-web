# Zero Risk Auto Sent

The launcher setting **Automatically confirm Sent after manual ChatGPT submission** defaults off
and applies to new turns. The user still pastes, selects the model/effort and connector, attaches
images, and submits in ChatGPT. The existing Sent button and deadline remain unchanged.

## Evidence and ownership

Auto Sent requires all of these facts, in either event order:

1. Electron `session.webRequest.onBeforeRequest` observes a POST to an exact supported ChatGPT
   conversation endpoint from the main frame of the manual turn's owned WebContents. Its JSON has
   `action: next`, one user message and exactly one text part whose SHA-256 equals the already
   prepared prompt digest. ChatGPT's exact leading `@Codex Zero Risk ` connector-chip prefix is
   allowed; the remaining prompt must match without trimming or other normalization. Multimodal
   messages may also contain uploaded image references.
   For ChatGPT's large-paste text-file format, the message must instead reference exactly one
   `is_big_paste` text attachment with the expected UTF-8 byte count, with no other message text
   except the connector mention. Its file ID must match a native upload observed in this same turn.
   Electron's native `session.getBlobData` fingerprints the upload in memory while its temporary
   handle is valid. Both its actual byte count and SHA-256 must match the prepared prompt; only
   an exact-match boolean and native identity are retained. The upload must also receive
   an uncached HTTP 200/201. Attachment metadata alone cannot confirm anything.
2. `onResponseStarted` for that exact native request reports an uncached HTTP 200 event stream.
   This is transport evidence only; a successful HTTP status is insufficient on its own.
3. The server acknowledges that exact request with a `resume_conversation_token` followed by a
   `stream_handoff`, with the same conversation ID and a nonempty turn-exchange ID. A short-lived,
   read-only Electron debugger Network observer matches the entire request-body SHA-256 to the
   native request and checks the root frame before reading at most 64 KiB of the initial response.
   It detaches as soon as acknowledgement is established; token and response content are discarded.
   This confirms Sent without waiting for the model to invoke the connector. If this protocol is
   unavailable, the existing nonce-authenticated `codex_turn_start` observer remains a fallback.
   Neither path activates the broker or authorizes tools: the broker still requires its separate
   connector start after Sent.
4. At confirmation, the same tab, trace, helper PID, live helper, main frame and unexpired
   `awaiting-user` state still own the evidence. Confirmation calls the existing `confirmManualSent`.
   The normal adapter then confirms Sent using its private nonce, and existing start, tool,
   completion and compaction gates continue unchanged.

Electron's native request ID is distinct from the broker request ID. Exact matching of the entire
prepared text also matches the embedded broker request ID. Retained tabs use the selected incremental
prompt digest and a fresh trace; previous evidence is cleared before reuse.

There is no DOM observer, preload on ChatGPT, synthetic input, model selection, request modification,
Fetch interception, or polling. The early acknowledgement observer uses only native debugger
`Network.enable`, `Page.getFrameTree`, and `Network.streamResourceContent`. It never takes ownership
of an already-attached debugger; unavailable/detached observation uses the original fallback.
The observer clears on Sent, terminal state, reuse, removal, setting changes and shutdown. Native
navigation invalidates submission evidence; every asynchronous result rechecks that same evidence
object and main frame. Only the exact matched response body is opened, and no response content or
headers are logged. Network event metadata and request post data arrive transiently through the
native debugger, but only matching request digests and bounded acknowledgement state are retained. The request callback always passes an
empty response object to Electron, including on detection failure. Only known submission URLs are
observed, plus PUTs to `files.oaiusercontent.com` or OpenAI's regional
`sdmntpr<region>.oaiusercontent.com` storage hosts over HTTPS. Other upload origins are rejected.
JSON parsing is bounded to 8 MiB;
no disk-backed upload files are opened. At most four upload candidates are retained per turn.
The blob API returns a whole buffer and its handle expires before submission. For a supported
single-blob upload from the active manual turn, the native bytes are therefore read transiently at
upload time, compared to the prepared prompt's byte count and digest, and discarded. This may inspect
an unrelated upload in that same owned tab; no content is retained, logged or transmitted. Uploads
from other tabs and disk-backed uploads are never opened. No upload can confirm Sent without the
later matching big-paste message and all other signals. Stored evidence contains native identity,
opaque upload identifiers and acceptance/match metadata, never uploaded bytes,
request bodies or headers. Logs contain event names, local tab/trace IDs and fixed failure reasons.

## Failure behavior

- Copying, typing, pasting, editing, newlines, clearing the composer and upload activity are not
  evidence. Only an actual outgoing exact message can become a candidate.
- Different text, another tab/frame, a previous prompt, regeneration, unsupported payloads,
  redirects, HTTP failures, cached responses and network errors cannot confirm the turn.
- HTTP 200 containing an application error does not trigger the early path. It requires the explicit
  server handoff, not status alone. A later model/connector failure does not undo a real submission.
- An upload still in progress supplies no submission evidence. After ChatGPT submits the message
  with uploaded image references, the same exact-text and connector checks apply. The detector
  does not inspect or validate the user's chosen images or infer intended attachment completeness.
- Upload URLs encode the file ID as one complete UUID path segment; attachment metadata uses the
  same 32 hexadecimal digits prefixed by `file_`. Ambiguous paths, unknown IDs, failed uploads,
  unavailable blobs, replaced files and edited pasted text fail closed. No filename, timestamp or
  sequence-only correlation is used. Async blob results recheck the same live turn, frame and upload identity.
- Main-document navigation clears evidence. Existing retained-conversation navigation rules remain
  authoritative. Renderer failure, cancellation, timeout, completion and tab removal clear evidence.
  Launcher/browser restart never restores evidence from disk.
- Duplicate events and manual/automatic confirmation races use the existing idempotent Sent path.
  Auto Sent rechecks the deadline synchronously, including when a timeout callback is delayed.
- Changing the setting disarms current turns; enabling applies only to subsequently prepared turns.
- Missing detection or observer errors leave manual Sent usable. No timer is extended. The early
  server handoff avoids waiting for model reasoning; network latency still applies. If that early
  signal is unavailable, slow connector startup can delay the fallback beyond the human handoff
  deadline, so manual Sent remains available. No fixed latency is guaranteed.

## Why this signal

Native navigation and input events cannot identify an accepted message. A DOM bubble may be an
optimistic render or remounted history. HTTP success can carry an application error. Connector start
alone identifies a request but not its originating tab or exact text. Combining narrow native
submission evidence with an explicit server stream handoff (or the existing connector event)
avoids all four ambiguities without operating the page. ChatGPT's private submission protocol can change; unknown formats fail closed.

Electron supports only one listener per WebRequest event. The new hooks are installed once by the
BrowserHost. The existing automatic-mode `onCompleted` recovery hook is preserved.

References: [Electron debugger](https://www.electronjs.org/docs/latest/api/debugger),
[Electron WebRequest](https://www.electronjs.org/docs/latest/api/web-request),
[Electron session blobs](https://www.electronjs.org/docs/latest/api/session#sesgetblobdataidentifier),
[retained navigation issue #377](https://github.com/miuuyy/codex-chatgpt-web/issues/377),
[post-Sent timeout issue #325](https://github.com/miuuyy/codex-chatgpt-web/issues/325),
[compaction ownership issue #318](https://github.com/miuuyy/codex-chatgpt-web/issues/318).

## Tests and account validation

Automated coverage lives in the launcher browser-host, manual-submission, control-server and state
suites, plus the Zero Risk MCP lifecycle and adapter suites. Adapter tests exercise real broker and
launcher control channels through ordinary and v1/v2 compaction flows; only browser and model events
are simulated. These tests do not establish that a live account uses a supported transport.

For account validation, enable the setting before starting a fresh Zero Risk turn. Paste the prompt
and verify the launcher still offers Sent. Select the connector and desired model yourself, then send
in ChatGPT. The server handoff should produce `browser.manual_prompt_auto_confirmed` exactly once,
before connector start, followed by normal completion. Unsupported handoffs use connector fallback. Repeat with manual Sent, an edited prompt, and retained and
compaction turns. Never use automation to submit the live ChatGPT prompt for this test.
