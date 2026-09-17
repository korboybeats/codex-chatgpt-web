const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { matchesManualPrompt, successfulSubmissionResponse } = require('../electron/manual-submission.cjs');

const prompt = 'exact\nmultiline prompt';
const digest = createHash('sha256').update(prompt).digest('hex');
const body = () => ({ action: 'next', messages: [{ id: 'new-message', author: { role: 'user' }, content: { content_type: 'text', parts: [prompt] } }] });
const request = value => ({ method: 'POST', resourceType: 'xhr', url: 'https://chatgpt.com/backend-api/f/conversation', uploadData: [{ bytes: Buffer.from(JSON.stringify(value)) }] });

test('strict exact-text matching accepts chunked UTF-8 without changing whitespace', () => {
  const req = request(body());
  const bytes = req.uploadData[0].bytes;
  req.uploadData = [{ bytes: bytes.subarray(0, 23) }, { bytes: bytes.subarray(23) }];
  assert.equal(matchesManualPrompt(req, digest), true);
  assert.equal(matchesManualPrompt(request({ ...body(), messages: [{ ...body().messages[0], content: { content_type: 'text', parts: [prompt + '\n'] } }] }), digest), false);
});

for (const change of [
  value => { value.action = 'variant'; },
  value => { value.messages.push(value.messages[0]); },
  value => { value.messages[0].author.role = 'assistant'; },
  value => { delete value.messages[0].id; },
  value => { value.messages[0].content.parts = [prompt, 'extra text']; },
  value => { value.messages[0].content.parts.push({ content_type: 'unknown_attachment' }); },
  value => { value.messages[0].content.content_type = 'unknown'; },
]) test(`unknown or ambiguous message fails closed: ${change}`, () => {
  const value = body(); change(value);
  assert.equal(matchesManualPrompt(request(value), digest), false);
});

test('malformed, oversized, file-backed and opaque requests are ignored', () => {
  for (const data of [[], [{ file: '/private/upload' }], [{ blobUUID: 'private-blob' }], [{ bytes: Buffer.from('{bad') }], [{ bytes: Buffer.alloc(8 * 1024 * 1024 + 1) }]]) {
    assert.equal(matchesManualPrompt({ ...request(body()), uploadData: data }, digest), false);
  }
  for (const url of ['https://chatgpt.com/backend-api/f/conversation/prepare', 'https://chatgpt.com.evil.test/backend-api/f/conversation', 'https://chatgpt.com/backend-api/f/conversation?unknown=1']) {
    assert.equal(matchesManualPrompt({ ...request(body()), url }, digest), false);
  }
});

test('unknown response headers never establish acceptance', () => {
  for (const value of [undefined, [], [42], ['application/json'], ['text/event-stream', 'application/json']]) {
    assert.equal(successfulSubmissionResponse({ statusCode: 200, fromCache: false, responseHeaders: { 'content-type': value } }), false);
  }
});
