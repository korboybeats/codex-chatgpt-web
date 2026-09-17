const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createHash } = require('node:crypto');
const { SubmissionAckParser, observeSubmissionAck } = require('../electron/manual-submission-ack.cjs');

const event = value => `data: ${JSON.stringify(value)}\n\n`;
const token = { type: 'resume_conversation_token', conversation_id: 'conversation-1', token: 'PRIVATE_TOKEN' };
const handoff = { type: 'stream_handoff', conversation_id: 'conversation-1', turn_exchange_id: 'exchange-1' };
const ack = event('v1') + event(token) + event(handoff);
const encoded = value => Buffer.from(value).toString('base64');
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test('ack parser accepts the server handoff across every byte boundary and clears private data', () => {
  for (let split = 0; split <= Buffer.byteLength(ack); split++) {
    const parser = new SubmissionAckParser();
    const bytes = Buffer.from(ack);
    parser.push(bytes.subarray(0, split));
    assert.equal(parser.push(bytes.subarray(split)), true);
    assert.equal(parser.buffer, '');
    assert.equal(parser.conversationId, null);
    assert.ok(!JSON.stringify(parser).includes('PRIVATE_TOKEN'));
  }
  assert.equal(new SubmissionAckParser().push(Buffer.from(ack.replaceAll('\n', '\r\n'))), true);
});

for (const [name, data] of Object.entries({
  'handoff without token': event(handoff),
  'different conversation': event(token) + event({ ...handoff, conversation_id: 'other' }),
  'missing exchange': event(token) + event({ ...handoff, turn_exchange_id: null }),
  'empty token': event({ ...token, token: '' }) + event(handoff),
  'application error': event(token) + event({ error: 'PRIVATE_ERROR' }) + event(handoff),
  'error event': 'event: error\ndata: {}\n\n' + ack,
  'invalid JSON': 'data: {invalid}\n\n' + ack,
  'completed without handoff': event(token) + 'data: [DONE]\n\n',
  'unknown schema': event({ type: 'future_handoff' }) + ack,
  'oversized response': 'x'.repeat(65537) + ack,
})) test(`ack parser fails closed: ${name}`, () => {
  const parser = new SubmissionAckParser();
  assert.equal(parser.push(Buffer.from(data)), false);
  assert.equal(parser.buffer, '');
});

function fixture(t, options = {}) {
  const dbg = new EventEmitter();
  const commands = [];
  let attached = options.alreadyAttached || false, detaches = 0, callbacks = 0, enabled = true;
  const frame = {};
  const body = JSON.stringify({ messages: [{ id: "user-message-1" }], private: "exact request bytes" });
  const owned = { requestDigest: createHash('sha256').update(body).digest('hex'), frame };
  let evidence = owned;
  const contents = { debugger: dbg, mainFrame: frame };
  dbg.isAttached = () => attached;
  dbg.attach = () => { if (options.attachError) throw Error('PRIVATE_ERROR'); attached = true; };
  dbg.detach = () => { attached = false; detaches++; dbg.emit('detach'); };
  let resolveStream;
  dbg.sendCommand = async (method, params) => {
    commands.push(method);
    assert.ok(['Network.enable', 'Page.getFrameTree', 'Network.streamResourceContent'].includes(method));
    if (options.commandError === method) throw Error('PRIVATE_ERROR');
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: options.rootFrame || 'root' } } };
    if (method === 'Network.streamResourceContent') {
      assert.equal(params.requestId, 'request-1');
      if (options.deferred) return await new Promise(resolve => { resolveStream = resolve; });
      return { bufferedData: encoded(options.data ?? ack) };
    }
    return {};
  };
  const observer = observeSubmissionAck(contents, {
    eligible: () => enabled,
    evidence: () => evidence,
    acknowledged: value => { assert.equal(value, owned); callbacks++; },
  });
  t.after(() => observer.dispose());
  const emit = (method, params, session) => dbg.emit('message', {}, method, params, session);
  const request = overrides => emit('Network.requestWillBeSent', {
    requestId: 'request-1', frameId: 'root', type: 'Fetch',
    request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation', postData: body }, ...overrides,
  });
  const response = overrides => emit('Network.responseReceived', {
    requestId: 'request-1', response: { status: 200, mimeType: 'text/event-stream', ...overrides },
  });
  return { dbg, contents, owned, commands, observer, emit, request, response,
    callbacks: () => callbacks, detaches: () => detaches, resolve: data => resolveStream({ bufferedData: encoded(data) }),
    replace: () => { evidence = { ...owned }; }, disable: () => { enabled = false; } };
}

test('exact main-frame response acknowledges once without waiting for connector or model', async t => {
  const f = fixture(t);
  f.request(); f.response(); await tick();
  assert.equal(f.callbacks(), 1);
  assert.equal(f.detaches(), 1);
  assert.equal(f.dbg.listenerCount('message'), 0);
  f.response(); await tick();
  assert.equal(f.callbacks(), 1);
});

test('buffered and concurrent data chunks retain order', async t => {
  const f = fixture(t, { deferred: true });
  f.request(); f.response(); await tick();
  f.emit('Network.dataReceived', { requestId: 'request-1', data: encoded(event(handoff)) });
  f.resolve(event('v1') + event(token)); await tick();
  assert.equal(f.callbacks(), 1);
});

for (const scenario of ['wrong-body', 'child-frame', 'other-request', 'http-error', 'cached', 'service-worker', 'wrong-mime', 'stale-evidence', 'deadline', 'navigation', 'network-error', 'superseding-request', 'queue-limit', 'disposed']) {
  test(`native ack observer fails closed: ${scenario}`, async t => {
    const f = fixture(t, { deferred: true, rootFrame: scenario === 'child-frame' ? 'different' : 'root' });
    if (scenario === 'wrong-body') f.owned.requestDigest = 'mismatch';
    f.request();
    if (scenario === 'other-request') f.emit('Network.responseReceived', { requestId: 'other', response: { status: 200, mimeType: 'text/event-stream' } });
    else f.response(scenario === 'http-error' ? { status: 400 } : scenario === 'cached' ? { fromDiskCache: true }
      : scenario === 'service-worker' ? { fromServiceWorker: true } : scenario === 'wrong-mime' ? { mimeType: 'application/json' } : {});
    await tick();
    if (f.commands.includes('Network.streamResourceContent')) {
      if (scenario === 'stale-evidence') f.replace();
      if (scenario === 'deadline') f.disable();
      if (scenario === 'navigation') f.contents.mainFrame = {};
      if (scenario === 'network-error') f.emit('Network.loadingFailed', { requestId: 'request-1' });
      if (scenario === 'superseding-request') f.request({ requestId: 'request-2' });
      if (scenario === 'queue-limit') f.emit('Network.dataReceived', { requestId: 'request-1', data: 'a'.repeat(131073) });
      if (scenario === 'disposed') f.observer.dispose();
      f.resolve(ack); await tick();
    }
    assert.equal(f.callbacks(), 0);
  });
}

for (const options of [{ alreadyAttached: true }, { attachError: true }, { commandError: 'Network.enable' },
  { commandError: 'Page.getFrameTree' }, { commandError: 'Network.streamResourceContent' }]) {
  test(`observer failure preserves fallback and never takes other debugger ownership: ${JSON.stringify(options)}`, async t => {
    const f = fixture(t, options);
    await tick(); f.request(); f.response(); await tick();
    assert.equal(f.callbacks(), 0);
    if (options.alreadyAttached || options.attachError) assert.equal(f.detaches(), 0);
  });
}


test('missing frame identity and child targets never open response bodies', async t => {
  const f = fixture(t);
  f.request({ frameId: undefined }); f.response(); await tick();
  f.emit('Network.requestWillBeSent', { requestId: 'request-1', frameId: 'root', type: 'Fetch',
    request: { method: 'POST', url: 'https://chatgpt.com/backend-api/f/conversation', postData: '{}' } }, 'child');
  f.response(); await tick();
  assert.ok(!f.commands.includes('Network.streamResourceContent'));
  assert.equal(f.callbacks(), 0);
});

test('response finish during streaming still processes buffered acknowledgement', async t => {
  const f = fixture(t, { deferred: true });
  f.request(); f.response(); await tick();
  f.emit('Network.loadingFinished', { requestId: 'request-1' });
  f.resolve(ack); await tick();
  assert.equal(f.callbacks(), 1);
});


const proSnapshot = { p: '', o: 'add', v: {
  conversation_id: token.conversation_id, error: null, error_code: null,
  message: { id: 'system-message', author: { role: 'system' }, status: 'finished_successfully',
    metadata: { parent_id: 'user-message-1' }, content: { parts: ['PRIVATE_SYSTEM_CONTENT'] } },
} };
const proAck = event(token) + event(proSnapshot);

test('Pro accepted snapshot confirms only the exact submitted message across chunk boundaries', () => {
  for (let split = 0; split <= Buffer.byteLength(proAck); split++) {
    const parser = new SubmissionAckParser('user-message-1');
    const bytes = Buffer.from(proAck);
    parser.push(bytes.subarray(0, split));
    assert.equal(parser.push(bytes.subarray(split)), true);
    assert.equal(parser.messageId, null);
    assert.ok(!JSON.stringify(parser).includes('PRIVATE_SYSTEM_CONTENT'));
  }
});

for (const scenario of ['wrong-parent', 'missing-parent', 'wrong-conversation', 'error', 'error-code', 'failed-status', 'wrong-role', 'nested-patch', 'wrong-operation', 'no-request-id', 'no-token']) {
  test(`Pro acknowledgement fails closed: ${scenario}`, () => {
    const snapshot = structuredClone(proSnapshot);
    const m = snapshot.v.message;
    if (scenario === 'wrong-parent') m.metadata.parent_id = 'previous-turn';
    if (scenario === 'missing-parent') delete m.metadata.parent_id;
    if (scenario === 'wrong-conversation') snapshot.v.conversation_id = 'other';
    if (scenario === 'error') snapshot.v.error = 'PRIVATE_ERROR';
    if (scenario === 'error-code') snapshot.v.error_code = 429;
    if (scenario === 'failed-status') m.status = 'failed';
    if (scenario === 'wrong-role') m.author.role = 'assistant';
    if (scenario === 'nested-patch') snapshot.p = '/message';
    if (scenario === 'wrong-operation') snapshot.o = 'replace';
    const parser = new SubmissionAckParser(scenario === 'no-request-id' ? undefined : 'user-message-1');
    assert.equal(parser.push(Buffer.from((scenario === 'no-token' ? '' : event(token)) + event(snapshot))), false);
  });
}

test('native Pro observer correlates snapshot parent to the hashed outgoing request', async t => {
  const f = fixture(t, { data: proAck });
  f.request(); f.response(); await tick();
  assert.equal(f.callbacks(), 1);
  assert.equal(f.detaches(), 1);
});

test('unavailable observation reports fixed reasons without private exception contents', async t => {
  const dbg = new EventEmitter();
  dbg.isAttached = () => false;
  dbg.attach = () => { throw Error('PRIVATE_EXCEPTION'); };
  const reasons = [];
  const observer = observeSubmissionAck({ debugger: dbg }, {
    eligible: () => true, evidence: () => null, acknowledged: () => assert.fail('unexpected acknowledgement'),
    unavailable: reason => reasons.push(reason),
  });
  t.after(() => observer.dispose());
  assert.deepEqual(reasons, ['observer-error']);
});
