# Thought Sorter

Talk into your phone and get your thoughts back, sorted.

**Open it:** [thought-sorter.vercel.app](https://thought-sorter.vercel.app). On your phone, use "Add to Home Screen" to install it as an app.

Thought Sorter turns voice notes into text, splits each note into the separate thoughts it contains, and files every thought by what kind of thought it is:

| Kind | What lands there |
| --- | --- |
| **Ideas** | Sparks, what-ifs, things you could make |
| **To-dos** | Tasks, errands, reminders (with due dates like "Tomorrow" or "Friday") |
| **Goals** | Plans and what you want for yourself |
| **Feelings** | How you feel and why |
| **Questions** | Things you're wondering about |
| **Worries** | What's weighing on you |
| **Gratitude** | What went right and who helped |
| **Observations** | Things you noticed, learned or did |

Each thought also gets topic tags (Work, Money, Health, People, Creative, Learning, Home, Travel) and each note gets an overall mood.

One rambling 90-second voice memo like *"I need to call the dentist tomorrow… what if we turned the garage into a studio… I'm worried about Friday's deadline… grateful Sam covered my shift"* becomes four thoughts filed under To-dos, Ideas, Worries and Gratitude.

## Ways to capture

- **Record**: tap the red button and talk. You see a live transcript as you speak, using your browser's speech recognition. Each pause starts a new line.
- **Private recording**: set *Speech to text → Private transcript after you stop* in Settings. The audio is transcribed on your device with [Whisper](https://github.com/openai/whisper) via [Transformers.js](https://github.com/huggingface/transformers.js). Nothing leaves the device.
- **Import voice memos**: pick or drop `.m4a`, `.mp3`, `.wav`, `.ogg`, `.webm` and similar files (you can select several at once). They're transcribed on-device with Whisper and dated by when the file was recorded.
- **Type, paste or dictate**: use your keyboard's microphone, or paste a transcript from your phone's recorder app. `.txt`, `.vtt` and `.srt` transcripts can be imported too.
- **Share to the app**: install it to your home screen, then on Android share text from another app straight into Thought Sorter.

## Sorting

- **On-device (default)**: a fast rule-based engine (`src/engine.js`) that handles punctuated text and the unpunctuated run-on text browser dictation produces. It needs no network.
- **It learns from you**: tap **Move** on any thought to re-file it. The words in that thought then lean toward the category you picked, so similar thoughts land there next time.
- **Claude (optional)**: for more nuanced splitting and labeling, turn on *Sort with Claude* in Settings and add an Anthropic API key. Your corrections are passed along so Claude follows your preferences. The on-device sort shows instantly, then Claude's version replaces it a moment later.

## Patterns

The **Patterns** tab shows what you think about most over 7 days, 30 days or all time: thoughts by kind, recurring topics, open to-dos and mood. With Claude turned on, **Write my reflection** gives you a short read-back covering what keeps coming up, ideas worth chasing, open loops and one small next step.

## Privacy

- Notes, settings and your API key are stored in your browser (`localStorage`). Audio is stored on your device in IndexedDB.
- On-device Whisper downloads its model once (about 40 MB for the fast English model) and caches it.
- Live transcripts use your browser's built-in speech service. Some browsers send audio to their provider for this. Pick the private Whisper mode in Settings if you want everything to stay on the device.
- With Claude turned on, note text goes directly from your browser to the Anthropic API using your key.
- **Export backup** and **Restore backup** in Settings move your notes between devices. **Export Markdown** gives you a readable copy grouped by kind.

## Run it

It's a static site with no build step:

```bash
npm start            # serves on http://localhost:8080
```

Recording needs a secure page, so use `localhost` or any `https://` host. The live site is deployed on Vercel from this repo's default branch, and every push redeploys it. Any static host works too (GitHub Pages, Netlify, Cloudflare Pages). "Add to Home Screen" installs it as an app that works offline.

## Claude.ai version

`npm run build:artifact` writes `dist/thought-sorter.html`, a single self-contained page for publishing as a claude.ai Artifact. When it runs there, it adapts:

- Sorting and reflections use the viewer's own Claude account, so no API key is needed.
- Notes are saved privately to the viewer's Claude account and sync across their devices.
- The claude.ai frame blocks the microphone, so capture is keyboard dictation, pasted text, or imported transcripts.

## Develop

```bash
npm test             # engine unit tests (node:test, no dependencies)
```

```
index.html                 app shell (the build markers delimit the Artifact page)
src/engine.js              thought splitting, classification, topics, due dates, mood, learning
src/app.js                 recording, speech-to-text, storage, Claude, UI
src/styles.css             design tokens (light/dark) and layout
sw.js, manifest.webmanifest  offline support and install
scripts/build-artifact.mjs single-file build for claude.ai
tests/engine.test.mjs      engine tests
```

The eight category colors are a categorical palette checked for color-vision deficiency in both light and dark mode. Their order matters, so keep `KINDS` in `src/engine.js` and the `--k-*` tokens in `src/styles.css` in the same order.
