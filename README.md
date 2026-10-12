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

- **Record**: tap the red button and talk. Pick how it's transcribed in Settings:
  - *Show my words as I talk* uses your browser's speech recognition for a live transcript. Each pause starts a new line.
  - *Transcribe when I stop* sends the recording to Deepgram (or Whisper on your device) after you finish. Use this for long recordings.
- **Import voice memos**: pick or drop `.m4a`, `.mp3`, `.wav`, `.ogg`, `.webm` and similar files (you can select several at once). They're dated by when the file was recorded.
- **Type, paste or dictate**: use your keyboard's microphone, or paste a transcript from your phone's recorder app. `.txt`, `.vtt` and `.srt` transcripts can be imported too.
- **Share to the app**: install it to your home screen, then on Android share text from another app straight into Thought Sorter.

## Transcription

- **Deepgram (recommended for long audio)**: add your Deepgram API key under *Settings → Speech to text*. Files up to 2 GB go straight from your device to Deepgram's Nova-3 model, so hours of audio take about a minute and your phone does none of the heavy work. You see upload progress, and you get punctuation, paragraph breaks and automatic language detection (or set a language). Create a key in the [Deepgram console](https://console.deepgram.com) under API Keys.
- **Whisper on your device**: used when no Deepgram key is set. Private and offline after a one-time model download, best for clips under about 20 minutes.

### Tap a thought to hear it

Deepgram returns the time of every word, so each thought gets a time stamp like `▶ 12:34`. Tap it and the mini player at the bottom of the screen plays your recording from that moment. Recordings over 20 minutes are also split into 15-minute sections in the Notes view. Audio and timings stay on the device that transcribed them.

## Sorting

Choose how thoughts are sorted under *Settings → Sorting*:

- **This device (free, the default)**: a fast rule-based engine (`src/engine.js`) that handles punctuated text and the unpunctuated run-on text browser dictation produces. No account, no network.
- **Gemini (free)**: get a free API key at [aistudio.google.com](https://aistudio.google.com) (sign in with Google, choose *Get API key*, no card needed) and paste it in. Gemini 3.8 Flash (or the faster 3.5 Flash-Lite) takes a second pass at each note. When the free tier's per-minute limit is hit, the app waits and retries on its own. On Google's free tier, what you send may be used to improve Google's models.
- **Claude**: paste an Anthropic API key and pick a model. Claude Haiku 5.5 costs under a penny per hour of talking.
- **Your Claude account, no key**: open the [claude.ai version](#claudeai-version) and sorting runs on your own Claude plan.

The on-device sort shows instantly, and an AI's version replaces it a moment later. Long transcripts are sorted in sections of about 20 minutes each, so nothing is cut off.

**It learns from you:** tap **Move** on any thought to re-file it. The words in that thought then lean toward the category you picked, so similar thoughts land there next time. Your corrections are also passed to Gemini or Claude so they follow your preferences.

## Patterns

The **Patterns** tab shows what you think about most over 7 days, 30 days or all time: thoughts by kind, recurring topics, open to-dos and mood. With Claude turned on, **Write my reflection** gives you a short read-back covering what keeps coming up, ideas worth chasing, open loops and one small next step.

## Privacy

- Notes and timings are stored on your device in IndexedDB, which has room for many hours of transcripts. Audio is stored on your device too. Settings and API keys stay in this browser's local storage.
- With Deepgram set up, audio you transcribe goes directly from your browser to Deepgram using your key.
- On-device Whisper downloads its model once (about 40 MB for the fast English model) and caches it. Nothing leaves the device.
- Live transcripts use your browser's built-in speech service. Some browsers send audio to their provider for this.
- With Gemini or Claude turned on, note text goes directly from your browser to Google or Anthropic using your key. On Google's free tier, Google may use it to improve its models.
- In the claude.ai version, sorting runs through your Claude account and notes are stored in your account's private space for that page.
- **Export backup** and **Restore backup** in Settings move your notes between devices. **Export Markdown** gives you a readable copy grouped by kind.

## Run it

It's a static site with no build step:

```bash
npm start            # serves on http://localhost:8080
```

Recording needs a secure page, so use `localhost` or any `https://` host. The live site is deployed on Vercel from this repo's default branch, and every push redeploys it. Any static host works too (GitHub Pages, Netlify, Cloudflare Pages). "Add to Home Screen" installs it as an app that works offline.

## Claude.ai version

The same app runs inside claude.ai, where it uses your Claude login instead of an API key: https://claude.ai/artifact/EyvAQDxYNQtP6mpwxHQVae

- Sorting and reflections use your own Claude account at no extra cost.
- Notes are saved privately to your Claude account and sync across your devices. Very long transcripts are stored in pieces, so hours of text fit.
- claude.ai pages can't use the microphone or reach Deepgram. Capture there is keyboard dictation, pasted text, or imported transcripts. To get long recordings in, transcribe them in the web app, tap **Copy transcript** on the note, and paste it into the claude.ai version.

`npm run build:artifact` writes `dist/thought-sorter.html`, the single self-contained page published there.

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
