import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apply } from './plugin.js';

test('session link: discovery, queued delivery, reply, cold resume and boundaries', async () => {
  const tools = new Map();
  const agents = new Map();
  const states = new Map();
  const archived = [];
  let fold;
  let resolved = 0;
  let onResolve = () => {};
  const makeAgent = (id, cwd) => {
    const session = { header: { id, cwd }, seq: 10 };
    const agent = { id, session, status: 'idle', ctx: {}, mode: 'danger-full-access', messages: [],
      followup(message) { this.messages.push(message); this.session.seq++; } };
    agents.set(id, agent);
    return agent;
  };
  const a = makeAgent('a', '/workspace-a');
  const b = makeAgent('b', '/workspace-b');
  const stored = new Map(agents);
  const ctx = {
    agents: { get: id => agents.get(id) },
    sandboxPolicy: { resolve: ({ session }) => ({ mode: agents.get(session.header.id).mode }) },
    workspaceRegistry: { archivedSessionIds: archived, list: () => [] },
    sessionProjections: { async register(def) { fold = def; return { stateOf(session) { return states.get(session) ?? def.init(); } }; } },
    tools: { register: tool => tools.set(tool.name, tool) },
    systemPrompt: { section() {} },
    sessionController: {
      async list() { return { items: [...stored.values()].map(agent => ({ sessionId: agent.id, cwd: agent.session.header.cwd, running: false, projections: { values: { title: `title-${agent.id}` } } })) }; },
      async resolveAgent(id) { resolved++; onResolve(); const agent = stored.get(id); agents.set(id, agent); return { agent }; },
      async wait(req) { return { reason: 'idle', state: { cursor: 12, running: false, pendingInput: [] }, output: { truncated: false, records: [{ type: 'event', event: { type: 'assistant/message', seq: 12, data: { message: { content: [{ type: 'reasoning', text: 'private' }, { type: 'text', text: 'PONG' }] } } } }] } }; },
    },
  };
  await apply(ctx);
  const call = (name, args, agent = a) => tools.get(name).execute(args, { agent, signal: new AbortController().signal });
  assert.equal(tools.size, 3);
  assert.equal(tools.get('session_send').parameters.type, 'object');
  assert.deepEqual(tools.get('session_send').parameters.required, ['sessionId', 'message']);
  const listed = await call('sessions_list', {});
  assert.equal(listed.sessions.length, 2);
  assert.equal(resolved, 0, 'listing must not wake sessions');
  agents.delete('b');
  const receipt = await call('session_send', { sessionId: 'b', message: 'PING' });
  assert.equal(agents.get('b'), b, 'cold target must go through native resume');
  assert.equal(receipt.accepted, true);
  assert.equal(receipt.afterSeq, 9);
  assert.equal(b.messages.length, 1);
  assert.equal(b.messages[0].source.kind, 'agent-message');
  assert.equal(b.messages[0].source.senderSessionId, 'a');
  assert.equal(b.messages[0].source.sessionLink.depth, 1);
  assert.match(b.messages[0].content[0].text, /a/);
  assert.equal(b.session.header.cwd, '/workspace-b');
  assert.equal(b.mode, 'danger-full-access');
  states.set(b.session, fold.apply(fold.init(), { type: 'user/message', data: b.messages[0] }));
  await call('session_send', { sessionId: 'a', message: 'PONG' }, b);
  assert.equal(a.messages[0].source.sessionLink.depth, 2);
  const result = await call('session_result', { sessionId: 'b', afterSeq: receipt.afterSeq });
  assert.equal(result.messages[0].text, 'PONG');
  assert.ok(!JSON.stringify(result).includes('private'));
  await assert.rejects(call('session_send', { sessionId: 'a', message: 'self' }), /self/i);
  await assert.rejects(call('session_send', { sessionId: 'b', message: ' ' }), /message/i);
  await assert.rejects(call('session_send', { sessionId: 'missing', message: 'x' }), /session/i);
  a.mode = 'read-only';
  for (const [name, args] of [['sessions_list', {}], ['session_send', { sessionId: 'b', message: 'x' }], ['session_result', { sessionId: 'b' }]]) {
    await assert.rejects(call(name, args), /full.access/i);
  }
  a.mode = 'danger-full-access';
  a.session.header.origin = 'subagent';
  await assert.rejects(call('sessions_list', {}), /subagent/i);
  delete a.session.header.origin;
  archived.push('b');
  await assert.rejects(call('session_send', { sessionId: 'b', message: 'x' }), /archiv/i);
  archived.pop();
  onResolve = () => archived.push('b');
  await assert.rejects(call('session_send', { sessionId: 'b', message: 'x' }), /archiv/i);
  onResolve = () => {};
  archived.pop();
  states.set(a.session, { depth: 6, sent: 0 });
  await assert.rejects(call('session_send', { sessionId: 'b', message: 'loop' }), /limit/i);
  states.set(a.session, { depth: 0, sent: 9 });
  await assert.rejects(call('session_send', { sessionId: 'b', message: 'flood' }), /limit/i);
  const capped = fold.apply({ depth: 6, sent: 9 }, { type: 'user/message', data: { source: { kind: 'system-prompt' } } });
  assert.deepEqual(capped, { depth: 6, sent: 9 });
  assert.deepEqual(fold.apply(capped, { type: 'user/message', data: { source: { kind: 'user' } } }), { depth: 0, sent: 0 });
  assert.throws(() => fold.stateSchema.parse({ depth: -1, sent: 0 }));
  const compacted = fold.apply({ depth: 6, sent: 9 }, { type: 'user/message', surfaceOp: { op: 'replace' }, data: { source: { kind: 'user' } } });
  assert.deepEqual(compacted, { depth: 6, sent: 9 }, 'compaction must not reset a relay budget');
  const events = [
    { type: 'user/message', data: { source: { kind: 'agent-message', sessionLink: { depth: 5 } } } },
    ...Array.from({ length: 9 }, () => ({ type: 'tool/call', data: { name: 'session_send' } })),
  ];
  const checkpoint = fold.stateSchema.parse(JSON.parse(JSON.stringify(events.slice(0, 4).reduce(fold.apply, fold.init()))));
  const replayed = events.slice(4).reduce(fold.apply, checkpoint);
  assert.deepEqual(replayed, events.reduce(fold.apply, fold.init()));
  assert.deepEqual(replayed, { depth: 5, sent: 9 });
});
