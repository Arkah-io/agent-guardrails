import { AIMessage, ToolMessage, createAgent, tool, type BaseMessage } from 'langchain';
import { z } from 'zod';
import { admitTurn, createDocumentGuardrails, InMemoryGuardrailStore } from '../src/index.js';
import { ScriptedModel } from './scripted-model.js';

const document = { title: 'Untitled', revision: 0 };
const notes: string[] = [];
const store = new InMemoryGuardrailStore();
const input = {
  scopeId: 'demo-user/document-1',
  turnId: 'turn-1',
  policyVersion: 'demo-v1',
  segments: [
    { label: 'user', content: 'Rename the document to Field notes and remember my preference.' },
  ],
};
let moderationCalls = 0;
let writes = 0;
await admitTurn({
  store,
  input,
  // Demo stub, not a moderation service. Replace with your server's real provider.
  moderate: async () => {
    moderationCalls += 1;
    return true;
  },
});

const read = tool(() => JSON.stringify(document), {
  name: 'read_document',
  description: 'Read the title and revision.',
  schema: z.object({}),
});
const rename = tool(
  ({ title, expectedRevision }) => {
    if (document.revision !== expectedRevision)
      throw new Error('Document changed; review before editing');
    document.title = title;
    document.revision += 1;
    writes += 1;
    return JSON.stringify({ title, revision: document.revision });
  },
  {
    name: 'rename_document',
    description: 'Rename at the revision you read.',
    schema: z.object({ title: z.string(), expectedRevision: z.number().int() }),
  },
);
const remember = tool(
  ({ note }) => {
    notes.push(note);
    return 'Preference saved';
  },
  {
    name: 'remember',
    description: 'Remember a preference.',
    schema: z.object({ note: z.string() }),
  },
);

const middleware = createDocumentGuardrails({
  input,
  store,
  userMessageLabel: 'user',
  // This demo has one local document. Production code reauthorizes the concrete resource here.
  authorize: async () => true,
  tools: {
    read_document: { kind: 'document-read' },
    rename_document: { kind: 'mutation' },
    remember: { kind: 'auxiliary' },
  },
});
const write = {
  id: 'write-1',
  name: 'rename_document',
  args: { title: 'Field notes', expectedRevision: 0 },
};
const model = new ScriptedModel([
  new AIMessage({
    content: '',
    tool_calls: [
      { id: 'read-1', name: 'read_document', args: {} },
      { ...write, id: 'premature-write' },
      { id: 'memory-1', name: 'remember', args: { note: 'Prefer concise titles.' } },
    ],
  }),
  new AIMessage({
    content: '',
    tool_calls: [
      write,
      {
        id: 'write-2',
        name: 'rename_document',
        args: { title: 'Another title', expectedRevision: 1 },
      },
    ],
  }),
  new AIMessage({
    content: '',
    tool_calls: [
      {
        id: 'write-3',
        name: 'rename_document',
        args: { title: 'One more title', expectedRevision: 1 },
      },
    ],
  }),
  new AIMessage('Renamed once to Field notes. Saved the preference.'),
]);
const agent = createAgent({ model, tools: [read, rename, remember], middleware: [middleware] });
const result = await agent.invoke({
  messages: [{ role: 'user', content: input.segments[0]!.content }],
});
/** Print each tool result, showing only the machine-readable code for guardrail refusals. */
function trace(messages: BaseMessage[]): ToolMessage[] {
  const results = messages.filter((message) => ToolMessage.isInstance(message));
  for (const message of results) {
    const text = String(message.content);
    const code = message.status === 'error' ? JSON.parse(text).guardrail : undefined;
    console.log(`${message.name} [${message.status ?? 'success'}]: ${code ?? text}`);
  }
  return results;
}
trace(result.messages);

// Simulate a completed transport retry with the same trusted admission and mutation identity.
await admitTurn({
  store,
  input,
  moderate: async () => {
    moderationCalls += 1;
    return true;
  },
});
const replay = createAgent({
  model: new ScriptedModel([
    new AIMessage({
      content: '',
      tool_calls: [{ id: 'read-replay', name: 'read_document', args: {} }],
    }),
    new AIMessage({ content: '', tool_calls: [write] }),
    new AIMessage('Returned the saved mutation result.'),
  ]),
  tools: [read, rename, remember],
  middleware: [middleware],
});
console.log('--- transport retry ---');
const replayed = trace(
  (await replay.invoke({ messages: [{ role: 'user', content: input.segments[0]!.content }] }))
    .messages,
).find((message) => message.tool_call_id === write.id);
console.log(JSON.stringify({ document, notes, writes, moderationCalls }, null, 2));
if (
  writes !== 1 ||
  moderationCalls !== 1 ||
  document.title !== 'Field notes' ||
  notes.length !== 1 ||
  replayed?.status === 'error' ||
  replayed?.content !== JSON.stringify({ title: 'Field notes', revision: 1 })
) {
  throw new Error('Demo invariant failed');
}
