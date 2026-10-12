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

test('chunkText splits long transcripts on paragraph and sentence breaks', () => {
  const para = (n) => Array.from({ length: n }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const text = [para(40), para(40), para(40)].join('\n\n');
  const chunks = E.chunkText(text, 2000);
  assert.ok(chunks.length > 1);
  assert.ok(chunks.every((c) => c.length <= 2000));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), text.replace(/\s+/g, ' '));
  assert.ok(chunks.every((c) => /\.$/.test(c)), 'every chunk ends on a sentence');
  // Unpunctuated speech still gets cut on spaces.
  const run = Array.from({ length: 900 }, (_, i) => 'word' + i).join(' ');
  const hard = E.chunkText(run, 1000);
  assert.ok(hard.every((c) => c.length <= 1000 && !/^\s|\s$/.test(c)));
  assert.deepEqual(E.chunkText('short note', 1000), ['short note']);
});

test('normWords drops punctuation and filler', () => {
  assert.deepEqual(E.normWords("Um, I'm going to the store. Uh, okay!"), ['im', 'going', 'to', 'the', 'store', 'okay']);
});

test('alignThoughts finds when each thought was said, even after small rewrites', () => {
  const said = 'um so I need to call the dentist tomorrow and uh what if we turned the garage into a studio I am worried about Friday';
  const words = said.split(' ').map((w, i) => ({ word: w, start: i * 0.5 }));
  const timing = E.buildTiming(words);
  const thoughts = [
    { text: 'I need to call the dentist tomorrow.' },
    { text: 'What if we turned the garage into a studio?' },
    { text: "I'm worried about Friday." }, // rewritten contraction
    { text: 'Something never said.' },
  ];
  const starts = E.alignThoughts(thoughts, timing);
  assert.equal(starts[0], 1); // "I" is the 3rd spoken word
  assert.equal(starts[1], 5.5); // "what" is the 12th
  assert.equal(starts[2], 11); // "I'm" isn't in the audio, so it anchors on "worried" (23rd)
  assert.equal(starts[3], 11); // unmatched thoughts inherit the previous time
  assert.deepEqual(E.alignThoughts([{ text: 'x' }], { words: [], starts: [] }), [null]);
});
