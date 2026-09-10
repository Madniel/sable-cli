import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test, { describe } from 'node:test';

import { Agent } from '../src/agent/loop.js';
import { Session } from '../src/agent/session.js';
import { ApprovalPolicy } from '../src/approval/policy.js';
import type {
  CompletionRequest,
  CompletionResult,
  Provider,
  StreamEvent,
} from '../src/providers/types.js';
import { ToolRegistry } from '../src/tools/registry.js';
import { tempWorkspace, testConfig } from './helpers.js';

/** A provider that replays a script, so the loop can be tested without a network. */
class ScriptedProvider implements Provider {
  readonly id = 'scripted';
  readonly label = 'Scripted';
  readonly knownModels = ['test-model'] as const;
  readonly requests: CompletionRequest[] = [];

  constructor(private readonly script: CompletionResult[]) {}

  async complete(
    request: CompletionRequest,
    onEvent: (event: StreamEvent) => void,
  ): Promise<CompletionResult> {
    this.requests.push(structuredClone(request));
    const next = this.script.shift();
    if (!next) throw new Error('ScriptedProvider ran out of scripted responses');
    for (const block of next.message.content) {
      if (block.type === 'text') onEvent({ type: 'text_delta', text: block.text });
    }
    return next;
  }
}

const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };

function reply(text: string): CompletionResult {
  return {
    message: { role: 'assistant', content: [{ type: 'text', text }] },
    stopReason: 'end_turn',
    usage,
  };
}

function callTool(id: string, name: string, input: unknown): CompletionResult {
  return {
    message: { role: 'assistant', content: [{ type: 'tool_use', id, name, input }] },
    stopReason: 'tool_use',
    usage,
  };
}

function buildAgent(
  root: string,
  script: CompletionResult[],
  approval: ApprovalPolicy = new ApprovalPolicy('yolo'),
) {
  const config = testConfig(root, { approval: approval.getMode() });
  const provider = new ScriptedProvider(script);
  const session = new Session('test-model');
  const agent = new Agent({ config, provider, tools: new ToolRegistry(), approval, session });
  return { agent, provider, session };
}

describe('Agent.run', () => {
  test('returns the model text when no tools are requested', async () => {
    const root = tempWorkspace({});
    const { agent, session } = buildAgent(root, [reply('All done.')]);

    const result = await agent.run('hello');

    assert.equal(result.text, 'All done.');
    assert.equal(result.steps, 1);
    assert.equal(result.exhausted, false);
    assert.equal(session.history().length, 2);
  });

  test('executes a tool call and feeds the result back', async () => {
    const root = tempWorkspace({ 'a.txt': 'contents here' });
    const { agent, provider } = buildAgent(root, [
      callTool('t1', 'read_file', { path: 'a.txt' }),
      reply('The file says "contents here".'),
    ]);

    const started: string[] = [];
    const ended: boolean[] = [];
    const result = await agent.run('read a.txt', {
      onToolStart: ({ name }) => started.push(name),
      onToolEnd: ({ ok }) => ended.push(ok),
    });

    assert.deepEqual(started, ['read_file']);
    assert.deepEqual(ended, [true]);
    assert.equal(result.steps, 2);

    const secondRequest = provider.requests[1];
    const lastMessage = secondRequest?.messages.at(-1);
    assert.equal(lastMessage?.role, 'user');
    const block = lastMessage?.content[0];
    assert.equal(block?.type, 'tool_result');
    assert.match(block?.type === 'tool_result' ? block.content : '', /contents here/);
  });

  test('hands a validation error back to the model instead of throwing', async () => {
    const root = tempWorkspace({});
    const { agent, provider } = buildAgent(root, [
      callTool('t1', 'read_file', { wrong: 'argument' }),
      reply('Sorry, retrying.'),
    ]);

    await agent.run('go');

    const block = provider.requests[1]?.messages.at(-1)?.content[0];
    assert.equal(block?.type, 'tool_result');
    assert.equal(block?.type === 'tool_result' ? block.isError : false, true);
    assert.match(block?.type === 'tool_result' ? block.content : '', /unknown argument/);
  });

  test('an unknown tool name comes back as a recoverable error', async () => {
    const root = tempWorkspace({});
    const { agent, provider } = buildAgent(root, [
      callTool('t1', 'launch_missiles', {}),
      reply('Understood.'),
    ]);

    await agent.run('go');

    const block = provider.requests[1]?.messages.at(-1)?.content[0];
    assert.match(
      block?.type === 'tool_result' ? block.content : '',
      /Unknown tool "launch_missiles"/,
    );
  });

  test('readonly mode refuses writes and explains why', async () => {
    const root = tempWorkspace({});
    const { agent, provider } = buildAgent(
      root,
      [callTool('t1', 'write_file', { path: 'x.txt', content: 'nope' }), reply('Understood.')],
      new ApprovalPolicy('readonly'),
    );

    await agent.run('write a file');

    assert.equal(fs.existsSync(path.join(root, 'x.txt')), false);
    const block = provider.requests[1]?.messages.at(-1)?.content[0];
    assert.match(block?.type === 'tool_result' ? block.content : '', /read-only mode/);
  });

  test('stops at maxSteps rather than looping forever', async () => {
    const root = tempWorkspace({ 'a.txt': 'x' });
    const script = Array.from({ length: 10 }, (_, i) =>
      callTool(`t${i}`, 'read_file', { path: 'a.txt' }),
    );
    const config = testConfig(root, { maxSteps: 3 });
    const provider = new ScriptedProvider(script);
    const session = new Session('test-model');
    const agent = new Agent({
      config,
      provider,
      tools: new ToolRegistry(),
      approval: new ApprovalPolicy('yolo'),
      session,
    });

    const notices: string[] = [];
    const result = await agent.run('loop', { onNotice: (m) => notices.push(m) });

    assert.equal(result.steps, 3);
    assert.equal(result.exhausted, true);
    assert.match(notices.join(' '), /Stopped after 3 steps/);
  });

  test('accumulates usage across steps', async () => {
    const root = tempWorkspace({ 'a.txt': 'x' });
    const { agent, session } = buildAgent(root, [
      callTool('t1', 'read_file', { path: 'a.txt' }),
      reply('done'),
    ]);

    await agent.run('go');

    assert.equal(session.totals().usage.inputTokens, 20);
    assert.equal(session.totals().usage.outputTokens, 10);
    assert.equal(session.totals().turns, 1);
  });

  test('an abort signal stops the turn', async () => {
    const root = tempWorkspace({});
    const { agent } = buildAgent(root, [reply('never reached')]);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(() => agent.run('go', {}, controller.signal), /cancelled/i);
  });
});

describe('ApprovalPolicy', () => {
  test('read tools never prompt', async () => {
    const policy = new ApprovalPolicy('prompt');
    const outcome = await policy.confirm({ toolName: 'read_file', kind: 'read', summary: 'read' });
    assert.equal(outcome, 'once');
  });

  test('auto-edit lets writes through but still asks about commands', async () => {
    let asked = 0;
    const policy = new ApprovalPolicy('auto-edit', {
      async ask() {
        asked++;
        return 'once';
      },
    });

    assert.equal(
      await policy.confirm({ toolName: 'write_file', kind: 'write', summary: 'w' }),
      'once',
    );
    assert.equal(asked, 0);

    assert.equal(
      await policy.confirm({ toolName: 'shell', kind: 'execute', summary: 's' }),
      'once',
    );
    assert.equal(asked, 1);
  });

  test('"always" is remembered for the rest of the session', async () => {
    let asked = 0;
    const policy = new ApprovalPolicy('prompt', {
      async ask() {
        asked++;
        return 'always';
      },
    });

    await policy.confirm({ toolName: 'shell', kind: 'execute', summary: 's' });
    await policy.confirm({ toolName: 'shell', kind: 'execute', summary: 's' });

    assert.equal(asked, 1);
    assert.deepEqual(policy.allowlist(), ['shell']);
  });

  test('with nobody to ask, the answer is no', async () => {
    const policy = new ApprovalPolicy('prompt', null);
    assert.equal(
      await policy.confirm({ toolName: 'shell', kind: 'execute', summary: 's' }),
      'reject',
    );
  });
});
