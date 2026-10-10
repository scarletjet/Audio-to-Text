import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const E = require('../src/engine.js');

const kindsOf = (text, opts) => E.analyze(text, opts).thoughts.map((t) => t.kind);

test('splits a punctuated note into separate, correctly sorted thoughts', () => {
  const r = E.analyze(
    "Okay so, um, I need to call the dentist tomorrow. Also what if we turned the garage into a studio? That would be so fun. I'm feeling drained today. I'm worried we won't hit the deadline on Friday. Really grateful that Sam covered my shift. I wonder if I should take that pottery class. I want to run a half marathon by next spring. I noticed the coffee place on 5th closed down."
  );
  assert.deepEqual(
    r.thoughts.map((t) => t.kind),
    ['todo', 'idea', 'feeling', 'worry', 'gratitude', 'question', 'goal', 'observation']
  );
  // The follow-up sentence stays with its idea.
  assert.match(r.thoughts[1].text, /studio\? That would be so fun\.$/);
  // Filler and lead-in words are removed.
  assert.equal(r.thoughts[0].text, 'I need to call the dentist tomorrow.');
});

test('splits unpunctuated live speech on spoken cues', () => {
  const r = E.analyze(
    "so I was walking the dog and I realized I haven't called my mom in two weeks I need to call her this weekend also I have to pay the electric bill before Friday what if I started a podcast about local history"
  );
  assert.deepEqual(r.thoughts.map((t) => t.kind), ['observation', 'todo', 'todo', 'idea']);
  assert.equal(r.thoughts[0].text, "I was walking the dog and I realized I haven't called my mom in two weeks");
  assert.equal(r.thoughts[1].due.label, 'This weekend');
  assert.equal(r.thoughts[2].due.label, 'Friday');
});

test('treats each line of a live transcript as its own phrase', () => {
  assert.deepEqual(kindsOf('remember to buy milk\nwhy does my back hurt every morning\nthank you mom for dinner'), ['todo', 'question', 'gratitude']);
});

test('a fearful what-if is a worry, a hopeful one is an idea', () => {
  assert.equal(E.classify('What if I fail the exam and lose the scholarship').kind, 'worry');
  assert.equal(E.classify('What if we made a board game about our neighborhood').kind, 'idea');
});

test('detects topics and due dates', () => {
  assert.deepEqual(E.detectTopics('Need to email my boss about the client meeting'), ['work']);
  const now = new Date('2026-10-07T12:00:00'); // a Wednesday
  assert.deepEqual(E.detectDue('call the bank tomorrow', now), { label: 'Tomorrow', date: '2026-10-08' });
  assert.equal(E.detectDue('send it by Friday', now).date, '2026-10-09');
  assert.equal(E.detectDue('no date here', now), null);
});

test('learns from corrections', () => {
  const text = 'Pottery class on Thursdays';
  assert.notEqual(E.classify(text).kind, 'goal');
  let lex = {};
  lex = E.learn(lex, 'Pottery class with Jen', 'goal', 'observation');
  lex = E.learn(lex, 'Sign up for the pottery class', 'goal', 'todo');
  assert.equal(E.classify(text, lex).kind, 'goal');
});

test('mood reads the overall tone', () => {
  assert.equal(E.moodOf('So happy and grateful today, great run').label, 'Upbeat');
  assert.equal(E.moodOf('Exhausted and worried, everything is behind').label, 'Heavy');
  assert.equal(E.moodOf('Went to the store').label, 'Neutral');
});

test('normalizes a Claude reply and rejects bad shapes', () => {
  const r = E.normalizeClaudeResult(
    {
      title: 'Dentist and studio plans',
      mood: 'Mixed',
      thoughts: [
        { text: 'Call the dentist tomorrow.', kind: 'todo', topics: ['health', 'bogus'], due: 'Tomorrow' },
        { text: 'Turn the garage into a studio.', kind: 'not-a-kind', topics: [], due: '' },
        { text: '   ', kind: 'idea', topics: [], due: '' },
      ],
    },
    'transcript'
  );
  assert.equal(r.thoughts.length, 2);
  assert.deepEqual(r.thoughts[0].topics, ['health']);
  assert.equal(r.thoughts[0].due.label, 'Tomorrow');
  assert.ok(E.KIND_IDS.includes(r.thoughts[1].kind));
  assert.equal(r.mood.label, 'Mixed');
  assert.throws(() => E.normalizeClaudeResult({ nope: true }));
});

test('the Claude schema only allows known kinds', () => {
  const kinds = E.CLAUDE_SCHEMA.properties.thoughts.items.properties.kind.enum;
  assert.deepEqual(kinds, E.KIND_IDS);
  assert.match(E.buildClaudePrompt('hello'), /<transcript>\nhello\n<\/transcript>/);
});

test('summarize counts recent thoughts and open to-dos', () => {
  const now = Date.now();
  const notes = [
    { id: 'a', createdAt: now - 3600e3, mood: { label: 'Upbeat' }, thoughts: [{ kind: 'todo', text: 'x', topics: ['work'], done: false }, { kind: 'idea', text: 'y', topics: ['work'] }] },
    { id: 'b', createdAt: now - 40 * 86400e3, mood: { label: 'Heavy' }, thoughts: [{ kind: 'worry', text: 'z', topics: [] }] },
  ];
  const s = E.summarize(notes, 7, now);
  assert.equal(s.notes, 1);
  assert.equal(s.thoughts, 2);
  assert.equal(s.byKind.todo, 1);
  assert.equal(s.openTodos.length, 1);
  assert.deepEqual(s.topics[0], { id: 'work', count: 2, label: 'Work' });
});
