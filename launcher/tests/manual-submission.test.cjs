const test = require('node:test');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { matchesManualPrompt, successfulSubmissionResponse } = require('../electron/manual-submission.cjs');

const prompt = 'exact\nmultiline prompt';
const digest = createHash('sha256').update(prompt).digest('hex');
const body = () => ({ action: 'next', messages: [{ id: 'new-message', author: { role: 'user' }, content: { content_type: 'text', parts: [prompt] } }] });
const request = value => ({ method: 'POST', resourceType: 'xhr', url: 'https://chatgpt.com/backend-api/f/conversation', uploadData: [{ bytes: Buffer.from(JSON.stringify(value)) }] });

test('the selected Zero Risk connector mention preserves exact prompt matching', () => {
  const check = text => {
    const value = body(); value.messages[0].content.parts = [text];
    return matchesManualPrompt(request(value), digest);
  };
  assert.equal(check('@Codex Zero Risk ' + prompt), true);
  for (const text of [
    '@Other connector ' + prompt,
    '@Codex Zero Risk  ' + prompt,
    '@Codex Zero Risk\n' + prompt,
    '@Codex Zero Risk @Codex Zero Risk ' + prompt,
    '@Codex Zero Risk ' + prompt + '\n',
    '@Codex Zero Risk ' + prompt + ' unrelated text',
    'unrelated text @Codex Zero Risk ' + prompt,
    prompt + ' @Codex Zero Risk ',
  ]) assert.equal(check(text), false);
});

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

const { uploadedFileId, promptUpload, pastedPromptFile } = require('../electron/manual-submission.cjs');
test('upload identity accepts only an unambiguous native file UUID on the upload origin', () => {
  const base = 'https://files.oaiusercontent.com/00000000-1234-5678-9abc-def012345678/raw';
  assert.equal(uploadedFileId(base + '?private=ignored'), 'file_00000000123456789abcdef012345678');
  assert.equal(uploadedFileId(base.replace('files.oaiusercontent.com', 'sdmntprjapaneast.oaiusercontent.com')), 'file_00000000123456789abcdef012345678');
  for (const url of ['invalid', base.replace('https:', 'http:'), base.replace('files.oaiusercontent.com', 'evil.test'),
    base.replace('files.oaiusercontent.com', 'other.oaiusercontent.com'),
    base.replace('files.oaiusercontent.com', 'sdmntprjapaneast.oaiusercontent.com.evil.test'),
    base.replace('files.oaiusercontent.com', 'files.oaiusercontent.com:444'),
    base.replace('/raw', '/ffffffff-1234-5678-9abc-def012345678'), base.replace('/raw', 'extra/raw')]) {
    assert.equal(uploadedFileId(url), null);
  }
  const req = { url: base, method: 'PUT', resourceType: 'xhr', uploadData: [{ blobUUID: '11111111-2222-3333-4444-555555555555' }] };
  assert.ok(promptUpload(req));
  assert.ok(promptUpload({ ...req, uploadData: [{ blobUUID: "opaque-native-blob-handle" }] }));
  for (const extra of [{ method: 'POST' }, { resourceType: 'other' }, { uploadData: [{ file: '/private/file' }] }, { uploadData: [{ blobUUID: '' }] }, { uploadData: [{ blobUUID: 42 }] }]) {
    assert.equal(promptUpload({ ...req, ...extra }), null);
  }
});

test('pasted attachment metadata never substitutes for exact byte verification', () => {
  const value = body(); value.messages[0].content.parts = ['@Codex Zero Risk '];
  const file = { id: 'file_00000000123456789abcdef012345678', size: 42, mime_type: 'text/plain', is_big_paste: true };
  value.messages[0].metadata = { attachments: [file] };
  assert.equal(pastedPromptFile(request(value), 42), file.id);
  assert.equal(matchesManualPrompt(request(value), digest), false);
  assert.equal(pastedPromptFile(request(value), 43), null);
  value.messages[0].metadata.attachments.push({ ...file, is_big_paste: false });
  assert.equal(pastedPromptFile(request(value), 42), null);
});
