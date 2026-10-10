/* Thought Sorter app: capture voice notes, transcribe them, sort the thoughts. */
(function () {
  'use strict';

  const E = window.ThoughtEngine;
  const $ = (id) => document.getElementById(id);
  // Inside a claude.ai viewer the page gets `window.claude.use`; anywhere else
  // it runs as a normal web app with the microphone and local storage.
  const IN_VIEWER = !!(window.claude && typeof window.claude.use === 'function');
  const IS_ANDROID = /Android/i.test(navigator.userAgent);
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const KIND = Object.fromEntries(E.KINDS.map((k) => [k.id, k]));
  const TOPIC = Object.fromEntries(E.TOPICS.map((t) => [t.id, t]));
  const ANTHROPIC_SDK = 'https://cdn.jsdelivr.net/npm/@anthropic-ai/sdk@0.128.0/+esm';
  const TRANSFORMERS = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';

  // ---------------------------------------------------------------------
  // Small helpers
  // ---------------------------------------------------------------------
  function readJSON(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v ? JSON.parse(v) : fallback;
    } catch (_) {
      return fallback;
    }
  }
  function writeJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }
  function newId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function h(tag, attrs, ...children) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      el.append(c.nodeType ? c : document.createTextNode(String(c)));
    }
    return el;
  }
  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many || one + 's');
  }
  function clock(sec) {
    sec = Math.max(0, Math.round(sec || 0));
    const m = Math.floor(sec / 60);
    const s = String(sec % 60).padStart(2, '0');
    return m >= 60 ? Math.floor(m / 60) + ':' + String(m % 60).padStart(2, '0') + ':' + s : m + ':' + s;
  }
  function when(ts) {
    const d = new Date(ts);
    const now = new Date();
    const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const startOfDay = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (days === 0) return 'Today ' + time;
    if (days === 1) return 'Yesterday ' + time;
    if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: 'short' }) + ' ' + time;
    return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === now.getFullYear() ? undefined : 'numeric' });
  }
  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  let toastTimer = null;
  function toast(text, action) {
    const el = $('toast');
    $('toastText').textContent = text;
    const btn = $('toastAction');
    btn.hidden = !action;
    btn.onclick = null;
    if (action) {
      btn.textContent = action.label || 'Undo';
      btn.onclick = () => {
        el.hidden = true;
        action.run();
      };
    }
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
      if (action && action.expire) action.expire();
    }, action ? 6000 : 3800);
  }

  // ---------------------------------------------------------------------
  // Settings (per device, never synced)
  // ---------------------------------------------------------------------
  const SETTINGS_KEY = 'thought-sorter.settings.v1';
  const DEFAULTS = {
    useClaude: true,
    apiKey: '',
    claudeModel: 'claude-opus-5-5',
    tidy: true,
    speechMode: 'live',
    whisperModel: 'Xenova/whisper-tiny.en',
    lang: '',
    keepAudio: true,
  };
  const settings = Object.assign({}, DEFAULTS, readJSON(SETTINGS_KEY, {}));
  const saveSettings = () => writeJSON(SETTINGS_KEY, settings);

  // ---------------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------------
  const state = {
    notes: [],
    meta: { lexicon: {}, corrections: [] },
    showingExamples: false,
    filterKind: 'all',
    filterTopic: null,
    query: '',
    tab: 'thoughts',
    days: 7,
    moving: null,
    claudeBusy: new Set(),
    reflection: '',
  };
  const caps = { sample: null, downloads: null, claudeDenied: false };

  // ---------------------------------------------------------------------
  // Storage: claude.ai account storage when available, else this browser
  // ---------------------------------------------------------------------
  const NOTES_KEY = 'thought-sorter.notes.v1';
  const META_KEY = 'thought-sorter.meta.v1';

  const LocalBackend = {
    kind: 'local',
    async loadAll() {
      return { notes: readJSON(NOTES_KEY, []), meta: readJSON(META_KEY, { lexicon: {}, corrections: [] }) };
    },
    async saveNote() {
      if (!writeJSON(NOTES_KEY, state.notes)) throw new Error('This browser is out of space for notes. Export a backup and delete old notes.');
    },
    async deleteNote() {
      writeJSON(NOTES_KEY, state.notes);
    },
    async saveMeta() {
      writeJSON(META_KEY, state.meta);
    },
    async clear() {
      writeJSON(NOTES_KEY, []);
      writeJSON(META_KEY, { lexicon: {}, corrections: [] });
    },
    subscribe() {
      window.addEventListener('storage', (e) => {
        if (e.key === NOTES_KEY || e.key === META_KEY) {
          state.notes = readJSON(NOTES_KEY, []);
          state.meta = readJSON(META_KEY, state.meta);
          renderAll();
        }
      });
    },
  };

  async function makeDbBackend() {
    const [db, user] = await Promise.all([window.claude.use('db'), window.claude.use('user')]);
    if (!db || !user) return null;
    const uid = await user.id();
    if (!uid) return null;
    // Each person's notes live in their own private subtree.
    const col = db.collection('data/users/' + uid);
    // One write at a time per document; a newer payload replaces a queued one.
    const queues = new Map();
    function write(docId, op) {
      let q = queues.get(docId);
      if (!q) {
        q = { running: false, next: null };
        queues.set(docId, q);
      }
      return new Promise((resolve, reject) => {
        q.next = { op, resolve, reject };
        const pump = async () => {
          if (q.running || !q.next) return;
          const job = q.next;
          q.next = null;
          q.running = true;
          try {
            job.resolve(await job.op());
          } catch (err) {
            job.reject(err);
          } finally {
            q.running = false;
            pump();
          }
        };
        pump();
      });
    }
    const parse = (snap) => {
      const notes = [];
      let meta = null;
      for (const d of snap.docs) {
        const v = d.data() || {};
        if (v.type === 'note') notes.push(v);
        else if (v.type === 'meta') meta = v;
      }
      return { notes, meta };
    };
    const strip = (o) => JSON.parse(JSON.stringify(o));
    return {
      kind: 'db',
      async loadAll() {
        const r = parse(await col.get());
        return { notes: r.notes, meta: r.meta || { lexicon: {}, corrections: [] } };
      },
      saveNote(note) {
        return write('n_' + note.id, () => col.doc('n_' + note.id).set(strip(Object.assign({}, note, { type: 'note' }))));
      },
      deleteNote(id) {
        return write('n_' + id, () => col.doc('n_' + id).delete());
      },
      saveMeta() {
        return write('meta', () => col.doc('meta').set(strip({ type: 'meta', lexicon: state.meta.lexicon, corrections: state.meta.corrections })));
      },
      async clear() {
        const snap = await col.get();
        for (const d of snap.docs) await col.doc(d.id).delete();
      },
      subscribe() {
        col.onSnapshot(
          (snap) => {
            const r = parse(snap);
            state.notes = r.notes;
            if (r.meta) state.meta = { lexicon: r.meta.lexicon || {}, corrections: r.meta.corrections || [] };
            renderAll();
          },
          () => toast('Live sync stopped. Reload the page to reconnect.')
        );
      },
    };
  }

  let backend = LocalBackend;

  function persistNote(note) {
    return backend.saveNote(note).catch((err) => {
      const code = err && err.code;
      if (code === 'quota_exceeded') toast('Your note storage is full. Delete some old notes to save new ones.');
      else if (code === 'invalid_argument') toast("This view can't save notes. Ask the owner for Contributor access.");
      else toast((err && err.message) || "Couldn't save that change.");
    });
  }
  function persistMeta() {
    return backend.saveMeta().catch(() => {});
  }

  // Audio blobs stay on this device (IndexedDB), keyed by note id.
  const AudioStore = {
    dbp: null,
    open() {
      if (this.dbp) return this.dbp;
      this.dbp = new Promise((resolve, reject) => {
        if (!window.indexedDB) return reject(new Error('no indexedDB'));
        const req = indexedDB.open('thought-sorter-audio', 1);
        req.onupgradeneeded = () => req.result.createObjectStore('audio');
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return this.dbp;
    },
    async tx(mode, fn) {
      const db = await this.open();
      return new Promise((resolve, reject) => {
        const t = db.transaction('audio', mode);
        const req = fn(t.objectStore('audio'));
        t.oncomplete = () => resolve(req && req.result);
        t.onerror = () => reject(t.error);
      });
    },
    put(id, blob) {
      return this.tx('readwrite', (s) => s.put(blob, id));
    },
    get(id) {
      return this.tx('readonly', (s) => s.get(id));
    },
    del(id) {
      return this.tx('readwrite', (s) => s.delete(id)).catch(() => {});
    },
    clear() {
      return this.tx('readwrite', (s) => s.clear()).catch(() => {});
    },
  };

  // ---------------------------------------------------------------------
  // Examples shown until the first real note exists (never saved)
  // ---------------------------------------------------------------------
  const EXAMPLES = [
    {
      ago: 0.2,
      source: 'voice',
      duration: 74,
      text: "Okay so, um, I need to call the dentist tomorrow and move my appointment. Also, what if we turned the garage into a little recording studio? That would be so fun. I'm feeling kind of drained today because work has been nonstop. I'm worried we won't hit the launch deadline on Friday. Really grateful that Sam covered my shift though.",
    },
    {
      ago: 26,
      source: 'voice',
      duration: 48,
      text: "I want to run a half marathon by next spring. I wonder if I should join that Saturday running club. Remember to pay the electric bill before Friday. I noticed I sleep way better when I leave my phone in the kitchen.",
    },
    {
      ago: 75,
      source: 'import',
      duration: 61,
      text: "What if I started a podcast about weird local history? I'd interview the old shop owners downtown. Should I ask my sister to co-host? I'm thankful my mom called tonight, it was the best part of my day.",
    },
  ];
  function exampleNotes() {
    return EXAMPLES.map((ex, i) => {
      const a = E.analyze(ex.text, { tidy: true });
      return {
        id: 'example-' + i,
        example: true,
        createdAt: Date.now() - ex.ago * 3600000,
        source: ex.source,
        duration: ex.duration,
        transcript: a.text,
        title: a.title,
        mood: a.mood,
        engine: 'device',
        thoughts: a.thoughts.map((t, j) => Object.assign({ id: 'ex' + i + '-' + j, done: false }, t)),
      };
    });
  }
  function visibleNotes() {
    return state.notes.length ? state.notes : exampleNotes();
  }

  // ---------------------------------------------------------------------
  // Claude
  // ---------------------------------------------------------------------
  function claudeReady() {
    if (!settings.useClaude || caps.claudeDenied) return false;
    if (IN_VIEWER) return !!caps.sample;
    return !!settings.apiKey;
  }

  let anthropicClient = null;
  async function apiClient() {
    if (anthropicClient && anthropicClient._key === settings.apiKey) return anthropicClient;
    const mod = await import(ANTHROPIC_SDK);
    const Anthropic = mod.default || mod.Anthropic;
    anthropicClient = new Anthropic({ apiKey: settings.apiKey, dangerouslyAllowBrowser: true });
    anthropicClient._key = settings.apiKey;
    return anthropicClient;
  }

  async function apiMessage(prompt, format) {
    const client = await apiClient();
    const model = settings.claudeModel || 'claude-opus-5-5';
    const params = {
      model,
      max_tokens: 16000,
      output_config: Object.assign({ effort: 'low' }, format ? { format } : {}),
      messages: [{ role: 'user', content: prompt }],
    };
    let res;
    if (model === 'claude-haiku-5-5') {
      res = await client.messages.create(params);
    } else {
      // If a safety classifier declines, the API retries on a suitable model.
      res = await client.beta.messages.create(Object.assign(params, { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }));
    }
    if (res.stop_reason === 'refusal') throw Object.assign(new Error('Claude declined to sort this note.'), { code: 'refused' });
    return res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  }

  function parseJSONLoose(text) {
    try {
      return JSON.parse(text);
    } catch (_) {
      const m = String(text).match(/\{[\s\S]*\}/);
      if (m) return JSON.parse(m[0]);
      throw new Error('Claude replied with something that is not JSON.');
    }
  }

  async function claudeSort(transcript) {
    const prompt = E.buildClaudePrompt(transcript, state.meta.corrections);
    let data;
    if (IN_VIEWER) {
      data = await caps.sample.json(prompt, { modelTier: 'quick' });
    } else {
      data = parseJSONLoose(await apiMessage(prompt, { type: 'json_schema', schema: E.CLAUDE_SCHEMA }));
    }
    return E.normalizeClaudeResult(data, transcript);
  }

  async function claudeText(prompt, onText) {
    if (IN_VIEWER) {
      const r = await caps.sample(prompt, { onText: (u) => onText(u.text), cache: false });
      return r.text;
    }
    const text = await apiMessage(prompt);
    onText(text);
    return text;
  }

  function claudeErrorMessage(err) {
    const code = err && err.code;
    if (['not_granted', 'sampling_disabled', 'not_declared', 'capability_disabled', 'capability_removed'].includes(code)) {
      caps.claudeDenied = true;
      updateEngineUI();
      return "Claude isn't available here, so notes are sorted on this device.";
    }
    if (code === 'rate_limited') return 'Claude is busy right now. The on-device sort is kept; try Claude again later.';
    if (code === 'session_expired') return 'Sign in to Claude again to use Claude sorting.';
    if (code === 'refused') return 'Claude declined this note. The on-device sort is kept.';
    const status = err && err.status;
    if (status === 401) return 'Your Anthropic API key was rejected. Check it in Settings.';
    if (status === 429) return 'Your API key hit a rate limit. The on-device sort is kept.';
    if (err && /fetch|network|Failed to/i.test(err.message || '')) return "Couldn't reach Claude. The on-device sort is kept.";
    return (err && err.message) || 'Claude sorting failed. The on-device sort is kept.';
  }

  async function refineWithClaude(note, quiet) {
    if (!claudeReady() || note.example) return;
    state.claudeBusy.add(note.id);
    renderAll();
    try {
      const result = await claudeSort(note.transcript);
      const current = state.notes.find((n) => n.id === note.id);
      if (!current) return;
      const doneTexts = new Set(current.thoughts.filter((t) => t.done).map((t) => t.text.toLowerCase()));
      current.thoughts = result.thoughts.map((t) => Object.assign({ id: newId(), done: doneTexts.has(t.text.toLowerCase()) }, t));
      current.title = result.title;
      current.mood = result.mood;
      current.engine = 'claude';
      await persistNote(current);
      if (!quiet) toast('Claude sorted this note into ' + plural(current.thoughts.length, 'thought') + '.');
    } catch (err) {
      if (!(err && err.code === 'cancelled')) toast(claudeErrorMessage(err));
    } finally {
      state.claudeBusy.delete(note.id);
      renderAll();
    }
  }

  // ---------------------------------------------------------------------
  // Notes
  // ---------------------------------------------------------------------
  function sortThoughts(text) {
    return E.analyze(text, { lexicon: state.meta.lexicon, tidy: settings.tidy });
  }

  async function createNote(opts) {
    const a = sortThoughts(opts.text);
    if (!a.thoughts.length) {
      toast('There was nothing to sort in that note.');
      return null;
    }
    const note = {
      id: newId(),
      createdAt: opts.createdAt || Date.now(),
      source: opts.source || 'typed',
      duration: opts.duration ? Math.round(opts.duration) : null,
      fileName: opts.fileName || null,
      transcript: a.text,
      title: a.title,
      mood: a.mood,
      engine: 'device',
      thoughts: a.thoughts.map((t) => Object.assign({ id: newId(), done: false }, t)),
    };
    if (opts.audio && settings.keepAudio && !IN_VIEWER) {
      try {
        await AudioStore.put(note.id, opts.audio);
        note.audio = { type: opts.audio.type || 'audio/webm', size: opts.audio.size };
      } catch (_) {
        /* audio is optional */
      }
    }
    const wasEmpty = !state.notes.length;
    state.notes.unshift(note);
    persistNote(note);
    if (wasEmpty) {
      state.filterKind = 'all';
      state.filterTopic = null;
    }
    renderAll();
    bumpKinds(note.thoughts.map((t) => t.kind));
    if (claudeReady()) {
      toast('Sorted ' + plural(note.thoughts.length, 'thought') + '. Claude is taking a closer look.');
      refineWithClaude(note, false);
    } else {
      toast('Sorted ' + plural(note.thoughts.length, 'thought') + ' from your note.');
    }
    return note;
  }

  function findThought(id) {
    for (const n of state.notes) {
      const t = n.thoughts.find((x) => x.id === id);
      if (t) return { note: n, thought: t };
    }
    return null;
  }

  function moveThought(id, kind) {
    const hit = findThought(id);
    if (!hit || hit.thought.kind === kind) return;
    const from = hit.thought.kind;
    hit.thought.kind = kind;
    hit.thought.edited = true;
    if (kind === 'todo' && !hit.thought.due) {
      const due = E.detectDue(hit.thought.text);
      if (due) hit.thought.due = due;
    }
    state.meta.lexicon = E.learn(state.meta.lexicon, hit.thought.text, kind, from);
    state.meta.corrections = (state.meta.corrections || []).concat({ text: hit.thought.text.slice(0, 160), kind }).slice(-30);
    state.moving = null;
    persistNote(hit.note);
    persistMeta();
    renderAll();
    bumpKinds([kind]);
    toast('Moved to ' + KIND[kind].label + '. Similar thoughts will land there next time.');
  }

  function toggleDone(id, done) {
    const hit = findThought(id);
    if (!hit) return;
    hit.thought.done = done;
    persistNote(hit.note);
    renderAll();
  }

  function deleteThought(id) {
    const hit = findThought(id);
    if (!hit) return;
    const idx = hit.note.thoughts.indexOf(hit.thought);
    hit.note.thoughts.splice(idx, 1);
    persistNote(hit.note);
    renderAll();
    toast('Thought deleted.', {
      run: () => {
        const n = state.notes.find((x) => x.id === hit.note.id);
        if (!n) return;
        n.thoughts.splice(Math.min(idx, n.thoughts.length), 0, hit.thought);
        persistNote(n);
        renderAll();
      },
    });
  }

  function deleteNote(id) {
    const idx = state.notes.findIndex((n) => n.id === id);
    if (idx < 0) return;
    const [note] = state.notes.splice(idx, 1);
    backend.deleteNote(id).catch(() => {});
    renderAll();
    toast('Note deleted.', {
      run: () => {
        state.notes.splice(Math.min(idx, state.notes.length), 0, note);
        persistNote(note);
        renderAll();
      },
      expire: () => {
        if (!state.notes.some((n) => n.id === id)) AudioStore.del(id);
      },
    });
  }

  function resortNote(note, text) {
    const a = sortThoughts(text);
    if (!a.thoughts.length) return toast('There was nothing to sort in that note.');
    const doneTexts = new Set(note.thoughts.filter((t) => t.done).map((t) => t.text.toLowerCase()));
    note.transcript = a.text;
    note.title = a.title;
    note.mood = a.mood;
    note.engine = 'device';
    note.thoughts = a.thoughts.map((t) => Object.assign({ id: newId(), done: doneTexts.has(t.text.toLowerCase()) }, t));
    persistNote(note);
    renderAll();
    toast('Re-sorted into ' + plural(note.thoughts.length, 'thought') + '.');
  }

  // ---------------------------------------------------------------------
  // Recording + live speech-to-text (standalone app only)
  // ---------------------------------------------------------------------
  const canRecord = !IN_VIEWER && !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) && window.isSecureContext !== false;
  let rec = null;

  function pickMime() {
    if (!window.MediaRecorder) return '';
    const types = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/aac'];
    return types.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t)) || '';
  }

  async function startRecording() {
    const useLive = settings.speechMode === 'live' && !!SR;
    const needAudio = settings.keepAudio || !useLive;
    rec = {
      active: true,
      useLive,
      committed: [],
      session: [],
      interim: '',
      chunks: [],
      startedAt: Date.now(),
      history: [],
      stream: null,
    };
    setRecordingUI('starting');

    if (needAudio) {
      try {
        rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      } catch (err) {
        if (!useLive) {
          rec = null;
          setRecordingUI('idle');
          toast(err && err.name === 'NotAllowedError' ? 'Microphone access is blocked. Allow it in your browser settings, or type your note below.' : "Couldn't start the microphone. Type your note below instead.");
          return;
        }
      }
    }
    if (rec.stream) setupRecorder();
    if (useLive) startRecognition();
    setRecordingUI('recording');
    rec.timer = setInterval(() => {
      $('recTime').textContent = clock((Date.now() - rec.startedAt) / 1000);
    }, 250);
    drawWave();
  }

  function setupRecorder() {
    const mime = pickMime();
    try {
      rec.recorder = new MediaRecorder(rec.stream, mime ? { mimeType: mime } : undefined);
      rec.recorder.ondataavailable = (e) => e.data && e.data.size && rec.chunks.push(e.data);
      rec.recorder.start(1000);
    } catch (_) {
      rec.recorder = null;
    }
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      rec.ctx = new Ctx();
      const src = rec.ctx.createMediaStreamSource(rec.stream);
      rec.analyser = rec.ctx.createAnalyser();
      rec.analyser.fftSize = 1024;
      src.connect(rec.analyser);
    } catch (_) {
      rec.analyser = null;
    }
  }

  function startRecognition() {
    const R = rec;
    const r = new SR();
    r.lang = settings.lang || navigator.language || 'en-US';
    r.interimResults = true;
    // Android Chrome repeats results in continuous mode, so restart per phrase.
    r.continuous = !IS_ANDROID;
    r.maxAlternatives = 1;
    R.ended = new Promise((resolve) => (R.resolveEnded = resolve));
    r.onresult = (e) => {
      const finals = [];
      let interim = '';
      for (let i = 0; i < e.results.length; i++) {
        const res = e.results[i];
        const t = res[0] ? res[0].transcript : '';
        if (res.isFinal) finals.push(t.trim());
        else interim += t;
      }
      R.session = finals.filter(Boolean);
      R.interim = interim.trim();
      renderLive();
    };
    r.onerror = (e) => {
      if (e.error === 'not-allowed' || e.error === 'service-not-allowed') {
        R.liveBlocked = true;
        toast(R.recorder ? 'Live transcript is blocked here, so your note will be transcribed after you stop.' : 'Speech recognition is blocked. Allow the microphone, or type your note below.');
      } else if (e.error === 'audio-capture' && R.stream) {
        // Some phones can't share the mic between the recorder and speech
        // recognition. Keep the transcript, drop the audio copy.
        teardownAudio();
      } else if (e.error === 'network') {
        R.liveBlocked = true;
        toast("Live transcript needs a connection. Your note will be transcribed on this device after you stop.");
      }
    };
    r.onend = () => {
      R.committed.push(...R.session);
      R.session = [];
      if (R.interim) {
        R.committed.push(R.interim);
        R.interim = '';
      }
      renderLive();
      if (R.active && !R.liveBlocked) {
        try {
          r.start();
          return;
        } catch (_) {
          /* fall through */
        }
      }
      R.resolveEnded();
    };
    R.recognizer = r;
    try {
      r.start();
    } catch (_) {
      R.liveBlocked = true;
      R.resolveEnded();
    }
  }

  function liveText() {
    if (!rec) return '';
    return rec.committed.concat(rec.session).join('\n');
  }

  function renderLive() {
    if (!rec) return;
    $('live').hidden = false;
    const text = liveText();
    $('liveFinal').textContent = text ? text + (rec.interim ? '\n' : '') : '';
    $('liveInterim').textContent = rec.interim || (!text ? 'Listening…' : '');
    const live = $('live');
    live.scrollTop = live.scrollHeight;
  }

  function teardownAudio() {
    if (!rec) return;
    try {
      if (rec.recorder && rec.recorder.state !== 'inactive') rec.recorder.stop();
    } catch (_) {}
    if (rec.stream) rec.stream.getTracks().forEach((t) => t.stop());
    if (rec.ctx) rec.ctx.close().catch(() => {});
    rec.stream = null;
    rec.analyser = null;
    rec.recorder = null;
    rec.chunks = [];
  }

  function stopRecorder() {
    return new Promise((resolve) => {
      const r = rec.recorder;
      if (!r || r.state === 'inactive') return resolve(rec.chunks.length ? new Blob(rec.chunks, { type: (r && r.mimeType) || 'audio/webm' }) : null);
      r.onstop = () => resolve(rec.chunks.length ? new Blob(rec.chunks, { type: r.mimeType || 'audio/webm' }) : null);
      try {
        r.stop();
      } catch (_) {
        resolve(null);
      }
    });
  }

  async function stopRecording(keep) {
    if (!rec || !rec.active) return;
    const current = rec;
    current.active = false;
    clearInterval(current.timer);
    setRecordingUI('finishing');
    if (current.recognizer) {
      try {
        current.recognizer.stop();
      } catch (_) {}
      await Promise.race([current.ended, new Promise((r) => setTimeout(r, 1800))]);
    }
    const blob = current.recorder ? await stopRecorder() : null;
    if (current.stream) current.stream.getTracks().forEach((t) => t.stop());
    if (current.ctx) current.ctx.close().catch(() => {});
    const duration = (Date.now() - current.startedAt) / 1000;
    const text = liveText().trim();
    rec = null;
    setRecordingUI('idle');
    $('live').hidden = true;
    if (!keep) {
      toast('Recording discarded.');
      return;
    }
    if (current.useLive && !current.liveBlocked && text) {
      await createNote({ text, source: 'voice', duration, audio: blob });
    } else if (blob && blob.size > 2000) {
      await transcribeBlob(blob, { name: 'Voice note ' + new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }), source: 'voice', duration, keepAudio: true });
    } else if (text) {
      await createNote({ text, source: 'voice', duration, audio: blob });
    } else {
      toast("I didn't catch any speech. Try again a little closer to the mic.");
    }
  }

  function setRecordingUI(mode) {
    const btn = $('recBtn');
    const capture = $('capture');
    capture.classList.toggle('recording', mode === 'recording');
    btn.disabled = mode === 'starting' || mode === 'finishing';
    btn.setAttribute('aria-label', mode === 'recording' ? 'Stop and sort' : 'Start recording');
    $('recMeter').hidden = mode !== 'recording';
    if (mode === 'recording') {
      $('recTitle').textContent = 'Recording… tap to stop and sort';
      $('recSub').textContent = rec && rec.useLive ? 'Speak naturally. Pauses start new lines.' : "Speak naturally. I'll transcribe on this device when you stop.";
      $('recTime').textContent = '0:00';
      if (rec && rec.useLive) renderLive();
    } else if (mode === 'starting') {
      $('recTitle').textContent = 'Starting the microphone…';
    } else if (mode === 'finishing') {
      $('recTitle').textContent = 'Finishing up…';
    } else {
      $('recTitle').textContent = 'Tap to record a voice note';
      $('recSub').textContent = SR && settings.speechMode === 'live' ? 'Talk freely. Your words appear as you speak, then get sorted into thoughts.' : 'Talk freely. When you stop, the audio is transcribed privately on this device and sorted into thoughts.';
    }
  }

  function drawWave() {
    const canvas = $('wave');
    const ctx2d = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(120, canvas.clientWidth) * dpr;
    const hgt = Math.max(30, canvas.clientHeight) * dpr;
    canvas.width = w;
    canvas.height = hgt;
    const color = getComputedStyle(document.documentElement).getPropertyValue('--rec').trim() || '#d33a3a';
    const buf = new Uint8Array(1024);
    const barW = 3 * dpr;
    const gap = 2 * dpr;
    const maxBars = Math.floor(w / (barW + gap));
    const loop = () => {
      if (!rec || !rec.active) {
        ctx2d.clearRect(0, 0, w, hgt);
        return;
      }
      let level = 0.08 + 0.05 * Math.sin(Date.now() / 300);
      if (rec.analyser) {
        rec.analyser.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) {
          const v = (buf[i] - 128) / 128;
          sum += v * v;
        }
        level = Math.min(1, Math.sqrt(sum / buf.length) * 4.5);
      }
      rec.history.push(level);
      if (rec.history.length > maxBars) rec.history.shift();
      ctx2d.clearRect(0, 0, w, hgt);
      ctx2d.fillStyle = color;
      const start = w - rec.history.length * (barW + gap);
      rec.history.forEach((lv, i) => {
        const bh = Math.max(2 * dpr, lv * hgt);
        const x = start + i * (barW + gap);
        const y = (hgt - bh) / 2;
        ctx2d.beginPath();
        if (ctx2d.roundRect) ctx2d.roundRect(x, y, barW, bh, barW / 2);
        else ctx2d.rect(x, y, barW, bh);
        ctx2d.fill();
      });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------------
  // On-device Whisper for imported voice memos and recordings
  // ---------------------------------------------------------------------
  const WORKER_SRC = `
import { pipeline, env } from '${TRANSFORMERS}';
env.allowLocalModels = false;
let asr = null, loaded = null;
self.onmessage = async (e) => {
  const { id, audio, model, language } = e.data;
  const files = {};
  try {
    if (!asr || loaded !== model) {
      self.postMessage({ id, type: 'status', status: 'loading' });
      asr = await pipeline('automatic-speech-recognition', model, {
        progress_callback: (p) => {
          if (p.status === 'progress' && p.file) {
            files[p.file] = { loaded: p.loaded || 0, total: p.total || 0 };
            let l = 0, t = 0;
            for (const f of Object.values(files)) { l += f.loaded; t += f.total; }
            if (t) self.postMessage({ id, type: 'progress', percent: Math.round((l / t) * 100), mb: Math.round(t / 1048576) });
          }
        },
      });
      loaded = model;
    }
    self.postMessage({ id, type: 'status', status: 'transcribing' });
    const opts = { chunk_length_s: 30, stride_length_s: 5 };
    if (language && !model.endsWith('.en')) { opts.language = language; opts.task = 'transcribe'; }
    const out = await asr(audio, opts);
    const text = Array.isArray(out) ? out.map((o) => o.text).join(' ') : out.text;
    self.postMessage({ id, type: 'done', text: (text || '').trim() });
  } catch (err) {
    self.postMessage({ id, type: 'error', error: String((err && err.message) || err) });
  }
};`;

  const Whisper = {
    worker: null,
    pending: new Map(),
    seq: 0,
    ensure() {
      if (this.worker) return this.worker;
      const url = URL.createObjectURL(new Blob([WORKER_SRC], { type: 'text/javascript' }));
      this.worker = new Worker(url, { type: 'module' });
      this.worker.onmessage = (e) => {
        const msg = e.data;
        const p = this.pending.get(msg.id);
        if (!p) return;
        if (msg.type === 'progress') p.onProgress(msg);
        else if (msg.type === 'status') p.onStatus(msg.status);
        else if (msg.type === 'done') {
          this.pending.delete(msg.id);
          p.resolve(msg.text);
        } else if (msg.type === 'error') {
          this.pending.delete(msg.id);
          p.reject(new Error(msg.error));
        }
      };
      this.worker.onerror = (e) => {
        for (const p of this.pending.values()) p.reject(new Error((e && e.message) || 'The speech model stopped unexpectedly.'));
        this.pending.clear();
        this.worker.terminate();
        this.worker = null;
      };
      return this.worker;
    },
    transcribe(audio, opts) {
      const worker = this.ensure();
      const id = ++this.seq;
      return new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject, onProgress: opts.onProgress || (() => {}), onStatus: opts.onStatus || (() => {}) });
        worker.postMessage({ id, audio, model: opts.model, language: opts.language }, [audio.buffer]);
      });
    },
  };

  async function decodeTo16k(blob) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    const buf = await blob.arrayBuffer();
    const ctx = new Ctx();
    let audio;
    try {
      audio = await new Promise((resolve, reject) => {
        const p = ctx.decodeAudioData(buf, resolve, reject);
        if (p && p.then) p.then(resolve, reject);
      });
    } finally {
      ctx.close && ctx.close().catch(() => {});
    }
    const rate = 16000;
    const length = Math.max(1, Math.ceil(audio.duration * rate));
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const off = new Offline(1, length, rate);
    const src = off.createBufferSource();
    src.buffer = audio;
    src.connect(off.destination);
    src.start(0);
    const rendered = await off.startRendering();
    return { data: new Float32Array(rendered.getChannelData(0)), duration: audio.duration };
  }

  const jobs = [];
  function addJob(name) {
    const job = { id: newId(), name, status: 'Waiting…', percent: null, error: false };
    jobs.push(job);
    renderJobs();
    return job;
  }
  function updateJob(job, patch) {
    Object.assign(job, patch);
    renderJobs();
  }
  function endJob(job, delay) {
    setTimeout(() => {
      const i = jobs.indexOf(job);
      if (i >= 0) jobs.splice(i, 1);
      renderJobs();
    }, delay || 0);
  }
  function renderJobs() {
    const box = $('jobs');
    box.replaceChildren(
      ...jobs.map((j) =>
        h(
          'div',
          { class: 'job' + (j.error ? ' error' : '') },
          h('div', { class: 'job-top' }, h('span', { class: 'job-name', text: j.name }), h('span', { class: 'job-status', text: j.status })),
          j.error ? h('button', { class: 'btn btn-quiet', type: 'button', text: 'Dismiss', onclick: () => endJob(j) }) : h('div', { class: 'bar' + (j.percent == null ? ' indeterminate' : '') }, h('i', { style: j.percent == null ? null : 'width:' + j.percent + '%' }))
        )
      )
    );
  }

  async function transcribeBlob(blob, opts) {
    const job = addJob(opts.name || 'Voice note');
    try {
      updateJob(job, { status: 'Reading audio…' });
      const { data, duration } = await decodeTo16k(blob);
      const started = Date.now();
      let tick = null;
      const text = await Whisper.transcribe(data, {
        model: settings.whisperModel,
        language: (settings.lang || navigator.language || 'en').slice(0, 2).toLowerCase(),
        onProgress: (p) => updateJob(job, { status: 'Getting the speech model ready (' + p.mb + ' MB, first time only) ' + p.percent + '%', percent: p.percent }),
        onStatus: (s) => {
          if (s === 'loading') updateJob(job, { status: 'Loading the speech model…', percent: null });
          if (s === 'transcribing') {
            updateJob(job, { status: 'Transcribing ' + clock(duration) + ' of audio…', percent: null });
            tick = setInterval(() => updateJob(job, { status: 'Transcribing ' + clock(duration) + ' of audio… ' + clock((Date.now() - started) / 1000) }), 1000);
          }
        },
      }).finally(() => clearInterval(tick));
      if (!text || !text.replace(/\[.*?\]|\(.*?\)/g, '').trim()) {
        updateJob(job, { status: 'No speech found in this audio.', error: true });
        return;
      }
      updateJob(job, { status: 'Sorting…', percent: 100 });
      await createNote({ text, source: opts.source || 'import', duration: opts.duration || duration, audio: opts.keepAudio ? blob : null, createdAt: opts.createdAt, fileName: opts.fileName });
      endJob(job, 400);
    } catch (err) {
      const msg = String((err && err.message) || err);
      let status = "Couldn't transcribe this file. " + msg;
      if (/decode|EncodingError|Unable to decode/i.test(msg)) status = "This browser can't read that audio format. Try an .m4a, .mp3 or .wav file.";
      else if (/fetch|network|Failed to load/i.test(msg)) status = "Couldn't download the speech model. Check your connection and try again.";
      updateJob(job, { status, error: true });
    }
  }

  function stripCaptions(raw) {
    return String(raw)
      .replace(/^﻿/, '')
      .replace(/^WEBVTT.*$/m, '')
      .replace(/^\d+\s*$/gm, '')
      .replace(/^[\d:.,]+\s*-->\s*[\d:.,]+.*$/gm, '')
      .replace(/<[^>]+>/g, '')
      .replace(/^(NOTE|STYLE|REGION)\b.*$/gm, '')
      .replace(/\n{2,}/g, '\n')
      .trim();
  }

  async function importFile(file) {
    const isText = /\.(txt|md|vtt|srt)$/i.test(file.name) || /^text\//.test(file.type);
    if (isText) {
      const text = stripCaptions(await file.text());
      if (!text) return toast(file.name + ' is empty.');
      await createNote({ text, source: 'import', createdAt: file.lastModified || Date.now(), fileName: file.name });
      return;
    }
    if (IN_VIEWER) {
      const job = addJob(file.name);
      updateJob(job, { status: "Audio files can't be transcribed inside Claude. Copy the transcript from your recorder app and paste it above, or open the standalone app.", error: true });
      return;
    }
    await transcribeBlob(file, { name: file.name, source: 'import', createdAt: file.lastModified || Date.now(), fileName: file.name, keepAudio: true });
  }

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function allThoughts(notes) {
    const out = [];
    for (const n of notes) for (const t of n.thoughts || []) out.push({ t, n });
    return out;
  }

  function matches(item) {
    if (state.filterTopic && !(item.t.topics || []).includes(state.filterTopic)) return false;
    if (state.query) {
      const q = state.query.toLowerCase();
      if (!item.t.text.toLowerCase().includes(q) && !(item.n.title || '').toLowerCase().includes(q)) return false;
    }
    return true;
  }

  function renderAll() {
    state.showingExamples = !state.notes.length;
    $('exampleBanner').hidden = !state.showingExamples;
    $('notesCount').textContent = String(state.notes.length);
    renderKindGrid();
    renderTopics();
    renderThoughts();
    renderNotes();
    renderPatterns();
  }

  function renderKindGrid() {
    const items = allThoughts(visibleNotes()).filter(matches);
    const counts = {};
    for (const { t } of items) counts[t.kind] = (counts[t.kind] || 0) + 1;
    const tile = (id, label, count) =>
      h(
        'button',
        {
          class: 'kind-tile' + (id === 'all' ? ' kind-all' : ''),
          type: 'button',
          'data-kind': id,
          'aria-pressed': String(state.filterKind === id),
          onclick: () => {
            state.filterKind = state.filterKind === id && id !== 'all' ? 'all' : id;
            renderAll();
          },
        },
        h('span', { class: 'swatch', 'aria-hidden': 'true' }),
        h('span', { class: 'kind-name', text: label }),
        h('span', { class: 'kind-count', text: String(count) })
      );
    $('kindGrid').replaceChildren(...E.KINDS.map((k) => tile(k.id, k.label, counts[k.id] || 0)), tile('all', 'All thoughts', items.length));
  }

  function bumpKinds(kinds) {
    for (const k of new Set(kinds)) {
      const el = $('kindGrid').querySelector('[data-kind="' + k + '"]');
      if (!el) continue;
      el.classList.remove('bump');
      void el.offsetWidth;
      el.classList.add('bump');
    }
  }

  function renderTopics() {
    const counts = {};
    for (const { t } of allThoughts(visibleNotes())) for (const tp of t.topics || []) counts[tp] = (counts[tp] || 0) + 1;
    const ids = E.TOPICS.map((t) => t.id).filter((id) => counts[id]);
    $('topicRow').hidden = !ids.length;
    $('topicRow').replaceChildren(
      h('button', { class: 'chip', type: 'button', 'aria-pressed': String(!state.filterTopic), onclick: () => ((state.filterTopic = null), renderAll()) }, 'All topics'),
      ...ids.map((id) =>
        h(
          'button',
          {
            class: 'chip',
            type: 'button',
            'aria-pressed': String(state.filterTopic === id),
            onclick: () => {
              state.filterTopic = state.filterTopic === id ? null : id;
              renderAll();
            },
          },
          TOPIC[id].label,
          h('span', { class: 'chip-count', text: String(counts[id]) })
        )
      )
    );
  }

  function thoughtCard(item) {
    const { t, n } = item;
    const isTodo = t.kind === 'todo';
    const card = h('article', { class: 'thought' + (t.done ? ' done' : ''), 'data-kind': t.kind });
    const mark = h('div', { class: 'thought-mark' });
    if (isTodo) {
      mark.append(
        h('input', {
          class: 'check',
          type: 'checkbox',
          checked: t.done,
          disabled: n.example,
          'aria-label': (t.done ? 'Mark not done: ' : 'Mark done: ') + t.text,
          onchange: (e) => toggleDone(t.id, e.target.checked),
        })
      );
    } else {
      mark.append(h('span', { class: 'dot', 'aria-hidden': 'true' }));
    }
    card.append(mark, h('p', { class: 'thought-text', text: t.text }));
    const meta = h(
      'div',
      { class: 'thought-meta' },
      h('span', { class: 'meta-kind', text: KIND[t.kind].one }),
      h('span', { class: 'meta-time', text: when(n.createdAt) }),
      t.due ? h('span', { class: 'tag tag-due', text: t.due.label }) : null,
      ...(t.topics || []).map((tp) => (TOPIC[tp] ? h('span', { class: 'tag', text: TOPIC[tp].label }) : null)),
      n.example ? h('span', { class: 'tag tag-example', text: 'Example' }) : null
    );
    if (!n.example) {
      meta.append(
        h(
          'span',
          { class: 'thought-actions' },
          h('button', { class: 'mini', type: 'button', 'aria-expanded': String(state.moving === t.id), onclick: () => ((state.moving = state.moving === t.id ? null : t.id), renderThoughts()) }, 'Move'),
          h('button', { class: 'mini', type: 'button', 'aria-label': 'Delete thought', onclick: () => deleteThought(t.id) }, 'Delete')
        )
      );
    }
    card.append(meta);
    if (state.moving === t.id) {
      card.append(
        h(
          'div',
          { class: 'move-row', role: 'group', 'aria-label': 'Move to' },
          ...E.KINDS.map((k) => h('button', { class: 'chip', type: 'button', 'data-kind': k.id, 'aria-current': String(k.id === t.kind), onclick: () => moveThought(t.id, k.id) }, k.label))
        )
      );
    }
    return card;
  }

  function renderThoughts() {
    const list = $('thoughtList');
    const items = allThoughts(visibleNotes()).filter(matches);
    items.sort((a, b) => b.n.createdAt - a.n.createdAt);
    const kinds = state.filterKind === 'all' ? E.KINDS : E.KINDS.filter((k) => k.id === state.filterKind);
    const groups = [];
    for (const k of kinds) {
      let rows = items.filter((i) => i.t.kind === k.id);
      if (k.id === 'todo') rows = rows.filter((i) => !i.t.done).concat(rows.filter((i) => i.t.done));
      if (!rows.length) continue;
      groups.push(
        h(
          'section',
          { class: 'kind-group', 'data-kind': k.id, 'aria-label': k.label },
          h('div', { class: 'group-head' }, h('h2', { text: k.label }), h('span', { class: 'count', text: String(rows.length) }), h('span', { class: 'blurb', text: k.blurb })),
          h('div', { class: 'cards' }, ...rows.map(thoughtCard))
        )
      );
    }
    if (!groups.length) {
      const label = state.filterKind === 'all' ? 'thoughts' : KIND[state.filterKind].label.toLowerCase();
      groups.push(h('div', { class: 'empty' }, h('strong', { text: 'No ' + label + ' yet' }), state.query || state.filterTopic ? 'Try clearing the search or topic filter.' : 'Record a note and anything that fits here will show up.'));
    }
    list.replaceChildren(...groups);
  }

  const SOURCE_LABEL = { voice: 'Recorded', import: 'Imported', typed: 'Typed' };

  function renderNotes() {
    const notes = visibleNotes().slice().sort((a, b) => b.createdAt - a.createdAt);
    const open = new Set(Array.from(document.querySelectorAll('.note[open]')).map((d) => d.dataset.id));
    $('noteList').replaceChildren(
      ...notes.map((n) => {
        const counts = {};
        for (const t of n.thoughts) counts[t.kind] = (counts[t.kind] || 0) + 1;
        const busy = state.claudeBusy.has(n.id);
        const details = h('details', { class: 'note', 'data-id': n.id, open: open.has(n.id) });
        const summary = h(
          'summary',
          null,
          h('span', { class: 'note-title', text: n.title || 'Untitled note' }),
          h('span', { class: 'note-when', text: when(n.createdAt) }),
          h(
            'span',
            { class: 'note-sub' },
            h('span', { class: 'kind-dots', 'aria-hidden': 'true' }, ...E.KINDS.filter((k) => counts[k.id]).map((k) => h('i', { 'data-kind': k.id }))),
            h('span', { text: plural(n.thoughts.length, 'thought') }),
            n.duration ? h('span', { text: SOURCE_LABEL[n.source] + ' · ' + clock(n.duration) }) : h('span', { text: SOURCE_LABEL[n.source] || 'Note' }),
            n.mood ? h('span', { class: 'mood', text: n.mood.label }) : null,
            busy ? h('span', { text: 'Claude is sorting…' }) : n.engine === 'claude' ? h('span', { text: 'Sorted by Claude' }) : null,
            n.example ? h('span', { class: 'tag tag-example', text: 'Example' }) : null
          )
        );
        details.append(summary);
        details.addEventListener('toggle', () => {
          if (details.open && !details.querySelector('.note-body')) details.append(noteBody(n));
        });
        if (open.has(n.id)) details.append(noteBody(n));
        return details;
      })
    );
  }

  function noteBody(n) {
    const body = h('div', { class: 'note-body' });
    if (n.audio && !IN_VIEWER) {
      const audio = h('audio', { controls: true, preload: 'metadata' });
      AudioStore.get(n.id)
        .then((blob) => {
          if (blob) audio.src = URL.createObjectURL(blob);
          else audio.replaceWith(h('p', { class: 'muted small', text: 'The audio for this note is stored on another device.' }));
        })
        .catch(() => audio.remove());
      body.append(audio);
    }
    const ta = h('textarea', { 'aria-label': 'Transcript', rows: 5, readonly: n.example });
    ta.value = n.transcript || '';
    const save = h('button', { class: 'btn btn-primary', type: 'button', hidden: true, onclick: () => resortNote(n, ta.value) }, 'Save and re-sort');
    ta.addEventListener('input', () => (save.hidden = ta.value.trim() === (n.transcript || '').trim()));
    body.append(h('label', { class: 'small muted', text: 'Transcript' }), ta);
    const list = h('ul');
    for (const t of n.thoughts) list.append(h('li', { 'data-kind': t.kind }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', null, h('strong', { text: KIND[t.kind].one + ': ' }), t.text)));
    body.append(h('div', { class: 'note-thoughts' }, list));
    if (!n.example) {
      const busy = state.claudeBusy.has(n.id);
      body.append(
        h(
          'div',
          { class: 'btn-row' },
          save,
          h('button', { class: 'btn btn-ghost', type: 'button', onclick: () => resortNote(n, n.transcript) }, 'Re-sort on device'),
          claudeReady() ? h('button', { class: 'btn btn-ghost', type: 'button', disabled: busy, onclick: () => refineWithClaude(n) }, busy ? 'Claude is sorting…' : 'Sort with Claude') : null,
          h('button', { class: 'btn btn-danger', type: 'button', onclick: () => deleteNote(n.id) }, 'Delete note')
        )
      );
    }
    return body;
  }

  function renderPatterns() {
    const notes = visibleNotes();
    const s = E.summarize(notes, state.days);
    const box = $('patterns');
    const max = Math.max(1, ...Object.values(s.byKind));
    const bars = h(
      'ul',
      { class: 'bars', 'aria-label': 'Thoughts by kind' },
      ...E.KINDS.map((k) => {
        const v = s.byKind[k.id] || 0;
        const pct = Math.round((v / s.thoughts || 0) * 100);
        return h(
          'li',
          { 'data-kind': k.id, title: k.label + ': ' + plural(v, 'thought') + (s.thoughts ? ' (' + pct + '%)' : '') },
          h('span', { class: 'label', text: k.label }),
          h('span', { class: 'track', 'aria-hidden': 'true' }, v ? h('span', { class: 'fill', style: 'width:' + (v / max) * 100 + '%' }) : null),
          h('span', { class: 'val', text: String(v) })
        );
      })
    );
    const moodText = Object.entries(s.moods)
      .filter(([, v]) => v)
      .map(([k, v]) => plural(v, k.toLowerCase() + ' note', k.toLowerCase() + ' notes'))
      .join(', ');
    const reflectBtn = claudeReady() && !state.showingExamples ? h('button', { class: 'btn btn-primary', type: 'button', id: 'reflectBtn', onclick: reflect }, 'Write my reflection') : null;
    box.replaceChildren(
      h(
        'div',
        { class: 'stat-row' },
        h('div', { class: 'stat' }, h('b', { text: String(s.notes) }), h('span', { text: s.notes === 1 ? 'note' : 'notes' })),
        h('div', { class: 'stat' }, h('b', { text: String(s.thoughts) }), h('span', { text: s.thoughts === 1 ? 'thought' : 'thoughts' })),
        h('div', { class: 'stat' }, h('b', { text: String(s.openTodos.length) }), h('span', { text: 'open to-dos' }))
      ),
      h(
        'div',
        { class: 'panel-grid' },
        h('div', { class: 'panel' }, h('h3', { text: 'What you think about most' }), bars, moodText ? h('p', { class: 'muted small', text: 'Mood: ' + moodText + '.' }) : null),
        h(
          'div',
          { class: 'panel-grid', style: 'grid-template-columns: minmax(0,1fr)' },
          h(
            'div',
            { class: 'panel' },
            h('h3', { text: 'Recurring topics' }),
            s.topics.length ? h('div', { class: 'topic-list' }, ...s.topics.slice(0, 8).map((t) => h('button', { class: 'chip', type: 'button', onclick: () => ((state.filterTopic = t.id), switchTab('thoughts'), renderAll()) }, t.label, h('span', { class: 'chip-count', text: String(t.count) })))) : h('p', { class: 'muted small', text: 'Topics like work, health and people show up here as you record.' })
          ),
          h(
            'div',
            { class: 'panel', 'data-kind': 'todo' },
            h('h3', { text: 'Open to-dos' }),
            s.openTodos.length
              ? h(
                  'ul',
                  { class: 'todo-list' },
                  ...s.openTodos.slice(0, 6).map((t) =>
                    h(
                      'li',
                      null,
                      h('input', { class: 'check', type: 'checkbox', disabled: state.showingExamples, 'aria-label': 'Mark done: ' + t.text, onchange: (e) => toggleDone(t.id, e.target.checked) }),
                      h('span', null, t.text, t.due ? h('span', { class: 'muted small', text: ' · ' + t.due.label }) : null)
                    )
                  )
                )
              : h('p', { class: 'muted small', text: 'Nothing open. Nice.' })
          )
        )
      ),
      h(
        'div',
        { class: 'panel' },
        h('h3', { text: 'Reflection' }),
        claudeReady()
          ? h('p', { class: 'muted small', text: state.showingExamples ? 'Record a few notes, then Claude can write you a reflection on what keeps coming up.' : 'Claude reads the thoughts from this period and writes back what keeps coming up, ideas worth chasing, and loose ends.' })
          : h('p', { class: 'muted small', text: IN_VIEWER ? 'Turn on Claude sorting in Settings to get a written reflection.' : 'Add an Anthropic API key in Settings to get a written reflection from Claude.' }),
        reflectBtn,
        h('div', { class: 'reflection', id: 'reflection', text: state.reflection })
      )
    );
  }

  async function reflect() {
    const btn = $('reflectBtn');
    const out = $('reflection');
    const since = Date.now() - state.days * 86400000;
    const notes = state.notes.filter((n) => n.createdAt >= since).sort((a, b) => a.createdAt - b.createdAt);
    if (!notes.length) return toast('No notes in this period yet.');
    btn.disabled = true;
    btn.textContent = 'Thinking…';
    out.textContent = '';
    try {
      state.reflection = await claudeText(E.buildReflectionPrompt(notes, state.days), (text) => {
        state.reflection = text;
        const el = $('reflection');
        if (el) el.textContent = text;
      });
    } catch (err) {
      state.reflection = (err && err.text) || '';
      toast(claudeErrorMessage(err).replace('The on-device sort is kept.', '').trim() || "Couldn't write a reflection right now.");
    } finally {
      renderPatterns();
    }
  }

  // ---------------------------------------------------------------------
  // Tabs, settings, export
  // ---------------------------------------------------------------------
  const TABS = { thoughts: ['tab-thoughts', 'board'], notes: ['tab-notes', 'notesView'], patterns: ['tab-patterns', 'patternsView'] };
  function switchTab(name) {
    state.tab = name;
    for (const [key, [tabId, panelId]] of Object.entries(TABS)) {
      $(tabId).setAttribute('aria-selected', String(key === name));
      $(tabId).tabIndex = key === name ? 0 : -1;
      $(panelId).hidden = key !== name;
    }
    try {
      sessionStorage.setItem('thought-sorter.tab', name);
    } catch (_) {}
  }

  function updateEngineUI() {
    const on = claudeReady();
    $('enginePill').dataset.engine = on ? 'claude' : 'device';
    $('engineLabel').textContent = on ? 'Claude' : 'On device';
    $('enginePill').title = on ? 'Notes are sorted by Claude. Tap to change.' : 'Notes are sorted on this device. Tap to change.';
    $('enginePill').setAttribute('aria-label', on ? 'Sorting with Claude. Open settings.' : 'Sorting on this device. Open settings.');
  }

  function applyModeUI() {
    const capture = $('capture');
    if (!canRecord) {
      capture.classList.add('no-mic');
      $('draftLabel').textContent = 'Type, paste, or dictate a note';
      $('dictateHint').hidden = false;
      $('dictateHint').textContent = IN_VIEWER ? 'Tap the box, then the microphone on your keyboard, and just talk. Or paste a transcript from your phone’s recorder app.' : 'Recording needs a secure (https) page. You can still dictate with your keyboard’s microphone.';
    }
    if (IN_VIEWER) {
      $('importText').textContent = 'Import transcripts';
      $('fileInput').setAttribute('accept', '.txt,.md,.vtt,.srt,text/plain');
      $('speechGroup').hidden = true;
      $('apiKeyField').hidden = true;
      $('modelField').hidden = true;
      $('claudeHelp').textContent = 'Uses your Claude account to split and label notes with more nuance. Claude asks your permission the first time.';
    } else {
      $('claudeHelp').textContent = 'Claude splits and labels your notes with more nuance. Needs your Anthropic API key below.';
    }
  }

  function fillSettings() {
    $('useClaude').checked = settings.useClaude;
    $('useClaudeRow').hidden = IN_VIEWER && !caps.sample;
    $('apiKey').value = settings.apiKey;
    $('claudeModel').value = settings.claudeModel;
    $('tidy').checked = settings.tidy;
    $('speechMode').value = settings.speechMode;
    $('speechMode').querySelector('[value="live"]').disabled = !SR;
    if (!SR) $('speechMode').value = 'whisper';
    $('whisperModel').value = settings.whisperModel;
    $('lang').value = settings.lang;
    $('lang').placeholder = navigator.language || 'en-US';
    $('keepAudio').checked = settings.keepAudio;
    $('storageNote').textContent =
      backend.kind === 'db'
        ? 'Notes are saved privately to your Claude account, so they follow you to any device where you open this page. Only you can see them.'
        : 'Notes are saved in this browser on this device' + (IN_VIEWER ? '' : ', and audio never leaves it') + '. Export a backup to move them.';
  }

  function bindSettings() {
    const dlg = $('settings');
    const open = () => {
      fillSettings();
      if (dlg.showModal) dlg.showModal();
      else dlg.setAttribute('open', '');
    };
    $('settingsBtn').addEventListener('click', open);
    $('enginePill').addEventListener('click', open);
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    });
    const bind = (id, key, prop) => {
      $(id).addEventListener('change', () => {
        settings[key] = prop === 'checked' ? $(id).checked : $(id).value.trim();
        saveSettings();
        updateEngineUI();
        if (!rec) setRecordingUI('idle');
        renderAll();
      });
    };
    bind('useClaude', 'useClaude', 'checked');
    bind('apiKey', 'apiKey', 'value');
    bind('claudeModel', 'claudeModel', 'value');
    bind('tidy', 'tidy', 'checked');
    bind('speechMode', 'speechMode', 'value');
    bind('whisperModel', 'whisperModel', 'value');
    bind('lang', 'lang', 'value');
    bind('keepAudio', 'keepAudio', 'checked');

    $('exportMd').addEventListener('click', () => offerFile('thought-sorter-' + new Date().toISOString().slice(0, 10) + '.md', toMarkdown(), 'text/markdown'));
    $('exportJson').addEventListener('click', () => offerFile('thought-sorter-backup-' + new Date().toISOString().slice(0, 10) + '.json', JSON.stringify({ app: 'thought-sorter', version: 1, exportedAt: new Date().toISOString(), notes: state.notes, meta: state.meta }, null, 2), 'application/json'));
    $('importJson').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        const data = JSON.parse(await file.text());
        if (!data || !Array.isArray(data.notes)) throw new Error('bad');
        let added = 0;
        for (const n of data.notes) {
          if (!n || !n.id || !Array.isArray(n.thoughts) || state.notes.some((x) => x.id === n.id)) continue;
          delete n.audio;
          state.notes.push(n);
          await persistNote(n);
          added++;
        }
        if (data.meta && data.meta.lexicon) {
          state.meta.lexicon = Object.assign({}, data.meta.lexicon, state.meta.lexicon);
          persistMeta();
        }
        state.notes.sort((a, b) => b.createdAt - a.createdAt);
        renderAll();
        toast('Restored ' + plural(added, 'note') + '.');
      } catch (_) {
        toast("That file isn't a Thought Sorter backup.");
      }
    });
    $('clearAll').addEventListener('click', () => ($('clearConfirm').hidden = false));
    $('clearNo').addEventListener('click', () => ($('clearConfirm').hidden = true));
    $('clearYes').addEventListener('click', async () => {
      $('clearConfirm').hidden = true;
      state.notes = [];
      state.meta = { lexicon: {}, corrections: [] };
      renderAll();
      await backend.clear().catch(() => {});
      AudioStore.clear();
      dlg.close();
      toast('All notes deleted.');
    });
  }

  function toMarkdown() {
    const lines = ['# Thought Sorter export', '', 'Exported ' + new Date().toLocaleString(), ''];
    for (const k of E.KINDS) {
      const items = allThoughts(state.notes).filter((i) => i.t.kind === k.id);
      if (!items.length) continue;
      lines.push('## ' + k.label, '');
      for (const { t, n } of items) {
        const box = k.id === 'todo' ? (t.done ? '[x] ' : '[ ] ') : '';
        lines.push('- ' + box + t.text + ' _(' + new Date(n.createdAt).toLocaleDateString() + (t.due ? ', ' + t.due.label : '') + ')_');
      }
      lines.push('');
    }
    lines.push('## Notes', '');
    for (const n of state.notes) lines.push('### ' + (n.title || 'Untitled note'), '_' + new Date(n.createdAt).toLocaleString() + '_', '', n.transcript || '', '');
    return lines.join('\n');
  }

  async function offerFile(filename, data, type) {
    if (!state.notes.length) return toast('There are no notes to export yet.');
    if (IN_VIEWER) {
      if (caps.downloads) {
        try {
          await caps.downloads.save({ filename, data });
          return;
        } catch (err) {
          if (err && err.code === 'declined') return;
        }
      }
      try {
        await navigator.clipboard.writeText(data);
        toast('Copied the export to your clipboard.');
      } catch (_) {
        toast("This view can't save files. Open the standalone app to export.");
      }
      return;
    }
    const url = URL.createObjectURL(new Blob([data], { type }));
    const a = h('a', { href: url, download: filename });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------
  function bindCapture() {
    $('recBtn').addEventListener('click', () => (rec && rec.active ? stopRecording(true) : startRecording()));
    $('recCancel').addEventListener('click', () => stopRecording(false));
    const draft = $('draft');
    const saveDraft = debounce(() => writeJSON('thought-sorter.draft', draft.value), 400);
    draft.addEventListener('input', () => {
      $('sortBtn').disabled = !draft.value.trim();
      saveDraft();
    });
    $('sortBtn').addEventListener('click', async () => {
      const text = draft.value.trim();
      if (!text) return;
      $('sortBtn').disabled = true;
      const note = await createNote({ text, source: 'typed' });
      if (note) {
        draft.value = '';
        writeJSON('thought-sorter.draft', '');
      } else {
        $('sortBtn').disabled = false;
      }
    });
    draft.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) $('sortBtn').click();
    });
    $('fileInput').addEventListener('change', async (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      for (const f of files) await importFile(f);
    });
    // Drop voice memos anywhere on the page.
    document.addEventListener('dragover', (e) => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault();
    });
    document.addEventListener('drop', async (e) => {
      const files = Array.from((e.dataTransfer && e.dataTransfer.files) || []);
      if (!files.length) return;
      e.preventDefault();
      for (const f of files) await importFile(f);
    });
  }

  function bindBoard() {
    $('search').addEventListener(
      'input',
      debounce(() => {
        state.query = $('search').value.trim();
        renderKindGrid();
        renderThoughts();
      }, 120)
    );
    const order = Object.keys(TABS);
    for (const [key, [tabId]] of Object.entries(TABS)) {
      $(tabId).addEventListener('click', () => switchTab(key));
      $(tabId).addEventListener('keydown', (e) => {
        const i = order.indexOf(key);
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          const next = order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length];
          switchTab(next);
          $(TABS[next][0]).focus();
        }
      });
    }
    document.querySelectorAll('.range .chip').forEach((chip) =>
      chip.addEventListener('click', () => {
        state.days = Number(chip.dataset.days);
        state.reflection = '';
        document.querySelectorAll('.range .chip').forEach((c) => c.setAttribute('aria-pressed', String(c === chip)));
        renderPatterns();
      })
    );
  }

  async function connectViewer() {
    const [sample, downloads] = await Promise.all([window.claude.use('sample').catch(() => null), window.claude.use('downloads').catch(() => null)]);
    caps.sample = sample;
    caps.downloads = downloads;
    updateEngineUI();
    renderAll();
    const dbb = await makeDbBackend().catch(() => null);
    if (!dbb) return;
    const localNotes = state.notes.slice();
    backend = dbb;
    try {
      const r = await dbb.loadAll();
      state.notes = r.notes;
      state.meta = { lexicon: (r.meta && r.meta.lexicon) || {}, corrections: (r.meta && r.meta.corrections) || [] };
      // Carry over anything written before account storage connected.
      for (const n of localNotes) {
        if (!state.notes.some((x) => x.id === n.id)) {
          state.notes.push(n);
          dbb.saveNote(n).catch(() => {});
        }
      }
      if (localNotes.length) LocalBackend.clear();
    } catch (_) {
      /* keep what we have; the subscription below retries */
    }
    renderAll();
    dbb.subscribe();
  }

  function start(hotData) {
    applyModeUI();
    bindCapture();
    bindBoard();
    bindSettings();
    setRecordingUI('idle');
    updateEngineUI();

    const draft = $('draft');
    draft.value = (hotData && hotData.draft) || readJSON('thought-sorter.draft', '') || '';
    // Text shared into the installed app (for example a transcript from a recorder app).
    try {
      const params = new URLSearchParams(location.search);
      const shared = [params.get('title'), params.get('text'), params.get('url')].filter(Boolean).join('\n').trim();
      if (shared) {
        draft.value = shared;
        history.replaceState(null, '', location.pathname);
      }
    } catch (_) {}
    $('sortBtn').disabled = !draft.value.trim();
    let tab = 'thoughts';
    try {
      tab = (hotData && hotData.tab) || sessionStorage.getItem('thought-sorter.tab') || 'thoughts';
    } catch (_) {}
    switchTab(TABS[tab] ? tab : 'thoughts');

    LocalBackend.loadAll().then((r) => {
      state.notes = Array.isArray(r.notes) ? r.notes : [];
      state.meta = { lexicon: (r.meta && r.meta.lexicon) || {}, corrections: (r.meta && r.meta.corrections) || [] };
      renderAll();
      if (IN_VIEWER) connectViewer();
      else LocalBackend.subscribe();
    });
    renderAll();
  }

  const hot = window.claude && window.claude.hot;
  if (hot && hot.snapshot) hot.snapshot(() => ({ draft: $('draft').value, tab: state.tab }));
  if (hot && hot.ready) hot.ready(start);
  else start((hot && hot.data) || {});
})();
