/*
 * Thought engine: splits a voice-note transcript into separate thoughts and
 * sorts each one by the kind of thought it is (idea, to-do, worry, ...).
 * Runs entirely on-device. Pure functions only, so it works in the browser
 * and in Node tests.
 */
(function (root) {
  'use strict';

  // Display order doubles as the categorical color order (validated for
  // color-vision deficiency as an adjacent sequence), so keep the two in sync.
  const KINDS = [
    { id: 'idea', label: 'Ideas', one: 'Idea', blurb: 'Sparks, what-ifs and things you could make' },
    { id: 'todo', label: 'To-dos', one: 'To-do', blurb: 'Tasks, errands and reminders' },
    { id: 'goal', label: 'Goals', one: 'Goal', blurb: 'Plans and what you want for yourself' },
    { id: 'feeling', label: 'Feelings', one: 'Feeling', blurb: 'How you feel and why' },
    { id: 'question', label: 'Questions', one: 'Question', blurb: 'Things you are wondering about' },
    { id: 'worry', label: 'Worries', one: 'Worry', blurb: 'What is weighing on you' },
    { id: 'gratitude', label: 'Gratitude', one: 'Gratitude', blurb: 'What went right and who helped' },
    { id: 'observation', label: 'Observations', one: 'Observation', blurb: 'Things you noticed, learned or did' },
  ];
  const KIND_IDS = KINDS.map((k) => k.id);

  const TOPICS = [
    { id: 'work', label: 'Work', words: ['work', 'job', 'boss', 'meeting', 'client', 'clients', 'project', 'deadline', 'office', 'coworker', 'colleague', 'team', 'manager', 'career', 'promotion', 'interview', 'presentation', 'report', 'email', 'emails', 'shift', 'customer', 'customers', 'proposal', 'pitch', 'invoice'] },
    { id: 'money', label: 'Money', words: ['money', 'budget', 'rent', 'bills', 'bill', 'pay', 'paid', 'salary', 'save', 'saving', 'savings', 'invest', 'investing', 'debt', 'loan', 'bank', 'taxes', 'tax', 'price', 'cost', 'expensive', 'afford', 'income', 'mortgage', 'credit', 'spend', 'spending', 'insurance'] },
    { id: 'health', label: 'Health', words: ['health', 'sleep', 'slept', 'gym', 'workout', 'run', 'running', 'walk', 'doctor', 'dentist', 'therapy', 'therapist', 'diet', 'eat', 'eating', 'food', 'water', 'meditate', 'meditation', 'yoga', 'sick', 'pain', 'tired', 'exercise', 'weight', 'medicine', 'appointment', 'stretch', 'energy'] },
    { id: 'people', label: 'People', words: ['mom', 'dad', 'mum', 'mother', 'father', 'sister', 'brother', 'friend', 'friends', 'partner', 'wife', 'husband', 'boyfriend', 'girlfriend', 'kids', 'kid', 'son', 'daughter', 'family', 'grandma', 'grandpa', 'baby', 'date', 'relationship', 'birthday', 'wedding', 'neighbor', 'aunt', 'uncle', 'cousin'] },
    { id: 'creative', label: 'Creative', words: ['write', 'writing', 'book', 'song', 'music', 'art', 'paint', 'painting', 'draw', 'drawing', 'design', 'podcast', 'video', 'youtube', 'story', 'poem', 'photo', 'photos', 'film', 'channel', 'content', 'novel', 'album', 'sketch', 'app', 'brand'] },
    { id: 'learning', label: 'Learning', words: ['learn', 'learning', 'study', 'studying', 'class', 'course', 'read', 'reading', 'research', 'school', 'exam', 'test', 'lesson', 'practice', 'skill', 'skills', 'language', 'tutorial', 'teach', 'homework', 'degree', 'college', 'university'] },
    { id: 'home', label: 'Home', words: ['home', 'house', 'apartment', 'clean', 'cleaning', 'laundry', 'dishes', 'groceries', 'grocery', 'kitchen', 'garden', 'repair', 'fix', 'furniture', 'move', 'moving', 'car', 'dog', 'cat', 'pet', 'cook', 'cooking', 'dinner', 'lunch', 'breakfast', 'trash', 'plants'] },
    { id: 'travel', label: 'Travel', words: ['trip', 'travel', 'flight', 'flights', 'vacation', 'holiday', 'hotel', 'beach', 'visit', 'visiting', 'passport', 'airport', 'road', 'abroad', 'camping', 'weekend away', 'tickets', 'train'] },
  ];

  const P = (re, w) => ({ re, w });
  const DAY = '(monday|tuesday|wednesday|thursday|friday|saturday|sunday)';

  // Each rule adds weight to one kind. Text is lowercased with straight quotes.
  const RULES = {
    todo: [
      P(/\b(i|we) (need|have|got|gotta) to\b/, 3),
      P(/\bi need\b/, 1),
      P(/\b(i|we) (must|should) (call|email|text|buy|get|pick|book|schedule|send|pay|finish|fix|clean|order|renew|cancel|reply|submit|sign|return|check)\b/, 2.5),
      P(/\b(remember|don't forget|do not forget|remind me|make sure) to\b/, 3.5),
      P(/\bgotta\b/, 1.5),
      P(/^(call|email|text|buy|pick up|book|schedule|send|pay|finish|fix|clean|order|renew|cancel|reply to|submit|grab|get|sign up|return|check|follow up|drop off|make an appointment|look up|set up|update|print|wash|water|feed)\b/, 3.5),
      P(/\b(call|email|text|buy|pick up|book|schedule|send|pay|renew|cancel|order|drop off|follow up)\b/, 0.8),
      P(/\b(today|tomorrow|tonight|asap|first thing|this (morning|afternoon|evening|weekend))\b/, 0.8),
      P(new RegExp('\\b(by|on|before|next) ' + DAY + '\\b'), 1),
      P(/\bto-?do\b|\bto do list\b|\bchecklist\b/, 2),
      P(/\bdeadline\b|\bdue\b/, 1),
    ],
    idea: [
      P(/\bwhat if\b/, 2.5),
      P(/^what if\b/, 2),
      P(/\b(an? )?(idea|ideas|concept|brainstorm)\b/, 2.5),
      P(/\b(we|i|you) could\b/, 1.8),
      P(/\bmaybe (i|we) (should|could)\b/, 1.2),
      P(/\bimagine\b/, 2),
      P(/\bhow about\b/, 1.5),
      P(/\bwouldn't it be\b|\bit would be (cool|amazing|great|fun|awesome|interesting)\b/, 2.5),
      P(/\b(build|create|make|launch|start|design|invent) (a|an|my own|our own|some)\b/, 1.6),
      P(/\b(app|product|business|startup|invention|feature|podcast|channel|brand|side project|prototype|service)\b/, 1),
      P(/\b(cool|clever|fun|neat) (way|thing)\b/, 1),
    ],
    goal: [
      P(/\b(i want to|i wanna|i'd like to|i would like to|i'm going to|i am going to|i'm gonna|i will|i plan to|i hope to)\b/, 2),
      P(/\b(goal|goals|aim|resolution|dream|ambition|commit to|commitment|milestone)\b/, 2.5),
      P(/\b(plan|planning)\b/, 1),
      P(/\b(this|next) (year|month|quarter|summer|winter|spring|fall)\b/, 1.5),
      P(/\bby (the end of|next|20\d\d)\b/, 1),
      P(/\b(every day|everyday|daily|weekly|habit|routine|consistently)\b/, 1.5),
      P(/\b(get better at|improve|learn (how )?to|save up|lose \w+ pounds|run a|finish my|get in shape|become)\b/, 1.5),
      P(/\bsomeday\b|\bone day\b/, 1.2),
    ],
    feeling: [
      P(/\bi (feel|felt|am feeling|'m feeling)\b/, 3),
      P(/\b(i'm|i am|i was|i've been|feeling) (so |really |very |kind of |kinda |a bit |pretty |super )?(happy|sad|excited|tired|exhausted|angry|mad|frustrated|annoyed|lonely|proud|calm|overwhelmed|bored|hopeful|motivated|drained|content|upset|hurt|relieved|inspired|grumpy|down|low|great|good|amazing|peaceful|restless|burnt out|burned out|confused|jealous|guilty|ashamed|energized|disappointed|heartbroken|joyful|giddy|numb)\b/, 2.5),
      P(/\b(happy|sad|excited|exhausted|frustrated|lonely|proud|overwhelmed|hopeful|motivated|drained|relieved|inspired|disappointed|heartbroken|joy|joyful|miserable|furious|thrilled|crying|cried|laughing|smiling)\b/, 1.2),
      P(/\b(mood|emotional|emotions|my heart)\b/, 1.2),
      P(/\bi (love|hate|miss|adore)\b/, 1.4),
      P(/\bmakes me (feel|happy|sad|angry|smile)\b/, 2),
    ],
    question: [
      P(/\?\s*$/, 3.5),
      P(/^(why|how|what|when|where|who|which|whose)\b/, 1.8),
      P(/^(should|could|would|is|are|do|does|did|can|will|am|have|has)\s+(i|we|it|they|he|she|you|there|this|that|my)\b/, 2.2),
      P(/\bi wonder\b|\bwondering\b/, 3),
      P(/\b(not sure|no idea|curious|figure out|i don't know (if|whether|how|why|what))\b/, 1.5),
      P(/\b(is it|am i|should i|do i|can i|could i|would it)\b/, 0.8),
    ],
    worry: [
      P(/\b(worried|worry|worrying|worries|anxious|anxiety|nervous|scared|afraid|fear|freaking out|stress|stressed|stressing|stressful|concerned|panic|panicking|dread|dreading|uneasy|terrified)\b/, 3),
      P(/\bwhat if (i|we|it|they|he|she|this|that)\b.*\b(fail|fails|lose|loses|wrong|don't|doesn't|can't|won't|bad|late|miss|break|breaks|hate|leave|quit|fired|sick)\b/, 2.5),
      P(/\b(can't stop thinking|keeps me up|keeping me up|losing sleep|overthinking|on my mind|bothering me|bugging me)\b/, 2.5),
      P(/\b(behind on|overdue|debt|can't afford|running out of)\b/, 1.2),
      P(/\bi hope (it|this|that|they|he|she) (doesn't|don't|won't|isn't)\b/, 2),
    ],
    gratitude: [
      P(/\b(grateful|thankful|thank you|thanks to|appreciate|appreciated|appreciative|blessed|so lucky|fortunate)\b/, 3.5),
      P(/\b(glad|happy) (that|i|we|to have)\b/, 1.6),
      P(/\b(best part|highlight) of (my|the) day\b/, 2),
      P(/\b(was|is) (so )?(kind|sweet|generous|helpful) (of|to)\b/, 1.5),
    ],
    observation: [
      P(/\b(i noticed|i realized|i realised|i learned|i learnt|i saw|i heard|i read|i found out|turns out|apparently|it seems|interesting(ly)?|funny thing)\b/, 2),
      P(/\b(today|yesterday|this morning|last night|earlier)\b.*\b(i|we) (went|saw|met|had|did|got|tried|watched|walked|ate|talked)\b/, 1.8),
      P(/\b(i|we) (went|met|had|tried|watched|talked|visited|finished)\b/, 0.8),
    ],
  };

  const FILLERS = /\b(um+|uh+|uhm+|erm+|er|hmm+|mhm|ah+)\b[,.]?\s*/gi;
  const SOFT_FILLERS = /,?\s*\b(you know|i mean|like|sort of|kind of|basically|literally),\s*/gi;

  const LEAD_IN = /^(and also|and then|and so|oh and|also|and|so|okay so|ok so|okay|ok|alright|anyway|anyways|plus|then|but also|oh|right|well|so yeah|yeah)\b(?:[,\s]+|$)/i;
  const AFTERTHOUGHT = /^(i don't know|i dunno|not sure|no idea|who knows|i guess|we'll see|or not|maybe|probably|hopefully)[.!?]*$/i;
  const DANGLING = /\b(and|but|so|or|then|because|cause|that|the|a|to|with|of|if)$/i;
  const CONTINUATION = /^(?:(?:that|it|this) (?:would|could|will|might|'d|'ll) be\b|(?:that|it)'s (?:a|so|such|really|pretty)\b|because|cause|'cause|cuz|since|which|so that|that's because|it's because|especially|for example|for instance|like when|meaning|otherwise|unless)\b/i;
  // Spoken transitions that start a new thought even without punctuation.
  const SHIFT_MARKERS = /\s+(?=(?:also|oh and|and another thing|another thing|one more thing|on another note|other than that|besides that|the other thing is|secondly|second thing|third thing|lastly|finally|anyway|anyways|and also)\b)/gi;
  // Phrases that very often begin a new thought in unpunctuated speech.
  const SPEECH_CUES = /\s+(?=(?:i need to|i have to|i've got to|i gotta|i want to|i wanna|i'd like to|i'm going to|i'm gonna|i wonder|what if|i feel|i'm feeling|i'm worried|i'm so|i am so|remember to|don't forget|i'm grateful|i'm thankful|i realized|i noticed|maybe i should|maybe we should|should i|why do|why does|why is|how do|how can)\b)/gi;

  const STOP = new Set('a an the and or but if then so to of in on at for with from by is are was were be been being am i me my mine we our you your he she it they them their this that these those there here just really very also too not no yes do does did have has had will would can could should about into over up down out off again more most some any all much many own same than which what who whom when where why how its it\'s i\'m i\'ve i\'d i\'ll im ive id dont don\'t thats that\'s gonna wanna gotta like get got going go thing things kind sort maybe need want think know feel make made one way lot bit'.split(' '));

  const POSITIVE = new Set('happy excited proud calm hopeful motivated content relieved inspired great good amazing peaceful energized joy joyful thrilled grateful thankful love loved lucky blessed glad fun awesome wonderful beautiful nice better best progress win won celebrate smiling laughing'.split(' '));
  const NEGATIVE = new Set('sad tired exhausted angry mad frustrated annoyed lonely overwhelmed bored drained upset hurt grumpy down low worried anxious nervous scared afraid stress stressed panic dread terrified confused jealous guilty ashamed disappointed heartbroken miserable furious crying cried sick pain hate behind overdue debt broke fail failed failing lost losing problem problems bad worse worst awful terrible'.split(' '));

  function normalize(text) {
    return String(text || '')
      .replace(/[‘’ʼ]/g, "'")
      .replace(/[“”]/g, '"')
      .replace(/\r\n?/g, '\n');
  }

  function tidy(text) {
    let t = normalize(text);
    t = t.replace(FILLERS, '');
    t = t.replace(SOFT_FILLERS, ', ');
    t = t.replace(/\b(\w+)( \1\b)+/gi, '$1'); // "I I think" -> "I think"
    t = t.replace(/\s+,/g, ',').replace(/,{2,}/g, ',').replace(/^[,\s]+/gm, '');
    t = t.replace(/[ \t]{2,}/g, ' ');
    return t.trim();
  }

  function capitalize(s) {
    s = s.trim();
    if (!s) return s;
    s = s.replace(/^\w/, (c) => c.toUpperCase());
    return s.replace(/\bi\b/g, 'I').replace(/\bi('m|'ve|'d|'ll)\b/g, 'I$1');
  }

  function stripLeadIn(s) {
    let prev;
    do {
      prev = s;
      s = s.replace(LEAD_IN, '');
    } while (s !== prev);
    return s.replace(/^[,;:\-\s]+/, '');
  }

  function wordCount(s) {
    return (s.match(/[\w']+/g) || []).length;
  }

  function tokens(s) {
    return (normalize(s).toLowerCase().match(/[a-z][a-z']+/g) || []).filter((w) => w.length > 2 && !STOP.has(w));
  }

  function splitSegments(text) {
    const t = normalize(text);
    const punctuated = (t.match(/[.!?]/g) || []).length;
    const lines = t.split(/\n+/).map((l) => l.trim()).filter(Boolean);
    const out = [];
    for (const line of lines) {
      let parts = line.split(/(?<=[.!?])\s+(?=["'(]?[A-Za-z0-9])/);
      parts = parts.flatMap((p) => p.split(SHIFT_MARKERS)).filter((p) => p && !/^(also|oh and|and another thing|another thing|one more thing|on another note|other than that|besides that|the other thing is|secondly|second thing|third thing|lastly|finally|anyway|anyways|and also)$/i.test(p.trim()));
      // Live browser transcripts often have no punctuation at all, so lean on
      // spoken cues for long runs of text.
      const sparse = punctuated === 0 || wordCount(line) / Math.max(1, (line.match(/[.!?]/g) || []).length) > 40;
      if (sparse) {
        parts = parts.flatMap((p) => (wordCount(p) > 14 ? p.split(SPEECH_CUES) : [p]));
      }
      for (const p of parts) {
        const s = p.trim();
        if (!s || /^[,.;:!?\s]*$/.test(s)) continue;
        const last = out[out.length - 1];
        // "I was walking the dog and | I realized..." belongs together.
        if (last && last.line === line && DANGLING.test(last.text)) last.text += ' ' + s;
        else out.push({ text: s, line });
      }
    }
    return out.map((o) => o.text);
  }

  function scoreText(text, lexicon) {
    const low = normalize(text).toLowerCase().trim();
    const scores = {};
    for (const id of KIND_IDS) {
      let s = 0;
      for (const rule of RULES[id]) if (rule.re.test(low)) s += rule.w;
      scores[id] = s;
    }
    scores.observation += 0.6; // the fallback when nothing else fits

    // A negative "what if" is a worry, not an idea.
    if (scores.worry >= 2.5 && /\bwhat if\b/.test(low)) scores.idea -= 4;
    // "I should start a podcast" is a goal or idea, not a task.
    if (scores.todo > 0 && scores.todo < 2 && (scores.idea >= 2 || scores.goal >= 2)) scores.todo -= 1;
    // A question about a task still reads best as a question.
    if (/\?\s*$/.test(low) && scores.todo < 3.5 && !/^what if\b/.test(low)) scores.question += 1;
    // "What if we...?" is usually a spark, even with a question mark.
    if (/^what if\b/.test(low) && scores.worry < 2.5) scores.question -= 2.5;

    if (lexicon) {
      const toks = tokens(low);
      for (const id of KIND_IDS) {
        const lex = lexicon[id];
        if (!lex) continue;
        let bonus = 0;
        for (const w of toks) bonus += lex[w] || 0;
        scores[id] += Math.max(-3, Math.min(4, bonus * 0.9));
      }
    }
    return scores;
  }

  function classify(text, lexicon) {
    const scores = scoreText(text, lexicon);
    let best = 'observation';
    let bestScore = -Infinity;
    let second = -Infinity;
    for (const id of KIND_IDS) {
      const s = scores[id];
      if (s > bestScore) {
        second = bestScore;
        bestScore = s;
        best = id;
      } else if (s > second) {
        second = s;
      }
    }
    const margin = bestScore - Math.max(0, second);
    const confidence = Math.max(0.2, Math.min(0.98, 0.35 + margin / 5));
    return { kind: best, scores, confidence: Math.round(confidence * 100) / 100 };
  }

  function detectTopics(text, max) {
    const low = ' ' + normalize(text).toLowerCase().replace(/[^a-z' ]+/g, ' ') + ' ';
    const hits = [];
    for (const topic of TOPICS) {
      let n = 0;
      for (const w of topic.words) if (low.includes(' ' + w + ' ')) n++;
      if (n) hits.push({ id: topic.id, n });
    }
    hits.sort((a, b) => b.n - a.n);
    return hits.slice(0, max || 2).map((h) => h.id);
  }

  function detectDue(text, now) {
    const low = normalize(text).toLowerCase();
    const base = now ? new Date(now) : new Date();
    const fmt = (d) => d.toISOString().slice(0, 10);
    const addDays = (n) => {
      const d = new Date(base);
      d.setDate(d.getDate() + n);
      return d;
    };
    if (/\b(today|tonight|this (morning|afternoon|evening)|asap|right away)\b/.test(low)) return { label: 'Today', date: fmt(base) };
    if (/\btomorrow\b/.test(low)) return { label: 'Tomorrow', date: fmt(addDays(1)) };
    if (/\bthis weekend\b/.test(low)) {
      const until = (6 - base.getDay() + 7) % 7;
      return { label: 'This weekend', date: fmt(addDays(until)) };
    }
    if (/\bnext week\b/.test(low)) return { label: 'Next week', date: fmt(addDays(7)) };
    const m = low.match(new RegExp('\\b' + DAY + '\\b'));
    if (m) {
      const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
      const target = names.indexOf(m[1]);
      let diff = (target - base.getDay() + 7) % 7;
      if (diff === 0) diff = 7;
      if (/\bnext\s+/.test(low.slice(Math.max(0, m.index - 6), m.index + 1))) diff = diff < 7 ? diff + 7 : diff;
      return { label: m[1][0].toUpperCase() + m[1].slice(1), date: fmt(addDays(diff)) };
    }
    return null;
  }

  function moodOf(text) {
    let pos = 0;
    let neg = 0;
    const words = normalize(text).toLowerCase().match(/[a-z']+/g) || [];
    for (let i = 0; i < words.length; i++) {
      const w = words[i];
      const negated = i > 0 && /^(not|never|no|don't|didn't|isn't|wasn't|can't)$/.test(words[i - 1]);
      if (POSITIVE.has(w)) negated ? neg++ : pos++;
      else if (NEGATIVE.has(w)) negated ? pos++ : neg++;
    }
    const total = pos + neg;
    const score = total ? (pos - neg) / total : 0;
    let label = 'Neutral';
    if (total && score >= 0.34) label = 'Upbeat';
    else if (total && score <= -0.34) label = 'Heavy';
    else if (total >= 2) label = 'Mixed';
    return { score: Math.round(score * 100) / 100, label };
  }

  function makeTitle(thoughts, text) {
    const pick = thoughts.find((t) => t.kind !== 'observation') || thoughts[0];
    const src = (pick ? pick.text : String(text || '')).replace(/[.!?]+$/, '');
    if (!src) return 'Untitled note';
    if (src.length <= 52) return src;
    const cut = src.slice(0, 52);
    return cut.slice(0, cut.lastIndexOf(' ') > 30 ? cut.lastIndexOf(' ') : 52).replace(/[,;:\s]+$/, '') + '…';
  }

  function canMerge(prev, next) {
    if (prev.kind !== next.kind) return false;
    if (prev.kind === 'todo' || prev.kind === 'question') return false;
    if ((prev.text + ' ' + next.text).length > 240) return false;
    if (prev.kind === 'idea') return /^(it|this|that|they|you could|we could|and|with|plus)\b/i.test(next.raw);
    return wordCount(prev.text) < 18 || wordCount(next.text) < 10;
  }

  /**
   * analyze(text, opts) -> { title, text, thoughts: [{text, kind, topics, due, confidence}], mood }
   * opts.lexicon: personal word weights learned from your corrections
   * opts.tidy: remove filler words (default true)
   */
  function analyze(text, opts) {
    opts = opts || {};
    const clean = opts.tidy === false ? normalize(text).trim() : tidy(text);
    const segments = splitSegments(clean);

    // Fold fragments and "because..." clauses into the thought before them.
    const units = [];
    for (const seg of segments) {
      const stripped = stripLeadIn(seg);
      if (!stripped) continue;
      const last = units[units.length - 1];
      const tiny = wordCount(stripped) < 3 && !/\?\s*$/.test(stripped);
      if (last && (CONTINUATION.test(stripped) || AFTERTHOUGHT.test(stripped) || tiny)) {
        last.raw += ' ' + stripped;
      } else {
        units.push({ raw: stripped });
      }
    }

    let thoughts = units.map((u) => {
      const textOut = capitalize(u.raw);
      const c = classify(textOut, opts.lexicon);
      return { raw: u.raw, text: textOut, kind: c.kind, confidence: c.confidence };
    });

    // Join neighbouring sentences that belong to the same thought.
    const merged = [];
    for (const t of thoughts) {
      const prev = merged[merged.length - 1];
      if (prev && canMerge(prev, t)) {
        prev.text = prev.text.replace(/([^.!?])$/, '$1.') + ' ' + t.text;
        prev.confidence = Math.max(prev.confidence, t.confidence);
      } else {
        merged.push({ ...t });
      }
    }

    thoughts = merged.map((t) => {
      const out = {
        text: t.text,
        kind: t.kind,
        topics: detectTopics(t.text, 2),
        confidence: t.confidence,
      };
      if (t.kind === 'todo') {
        const due = detectDue(t.text, opts.now);
        if (due) out.due = due;
      }
      return out;
    });

    return {
      title: makeTitle(thoughts, clean),
      text: clean,
      thoughts,
      mood: moodOf(clean),
    };
  }

  /** Learn from a correction: words in `text` lean toward `kind` (and away from `from`). */
  function learn(lexicon, text, kind, from) {
    const next = JSON.parse(JSON.stringify(lexicon || {}));
    const toks = Array.from(new Set(tokens(text))).slice(0, 24);
    for (const w of toks) {
      next[kind] = next[kind] || {};
      next[kind][w] = Math.min(3, Math.round(((next[kind][w] || 0) + 0.6) * 100) / 100);
      if (from && from !== kind) {
        next[from] = next[from] || {};
        next[from][w] = Math.max(-2, Math.round(((next[from][w] || 0) - 0.3) * 100) / 100);
      }
    }
    return next;
  }

  // ---- Claude prompt + schema, shared by every Claude integration ----------

  const CLAUDE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['title', 'mood', 'thoughts'],
    properties: {
      title: { type: 'string' },
      mood: { type: 'string', enum: ['Upbeat', 'Neutral', 'Mixed', 'Heavy'] },
      thoughts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['text', 'kind', 'topics', 'due'],
          properties: {
            text: { type: 'string' },
            kind: { type: 'string', enum: KIND_IDS },
            topics: { type: 'array', items: { type: 'string', enum: TOPICS.map((t) => t.id) } },
            due: { type: 'string' },
          },
        },
      },
    },
  };

  function buildClaudePrompt(transcript, examples) {
    const kinds = KINDS.map((k) => `- ${k.id}: ${k.blurb}`).join('\n');
    const topics = TOPICS.map((t) => t.id).join(', ');
    const learned = (examples || []).slice(-12).map((e) => `- "${e.text}" -> ${e.kind}`).join('\n');
    return [
      'You sort a person\'s voice note into the separate thoughts it contains.',
      '',
      'Split the transcript into distinct thoughts. One thought is one idea, task, feeling, question, and so on. Keep each to one to three sentences. Rewrite each in the speaker\'s own first-person voice: fix speech-to-text errors and drop filler words, but keep their meaning and wording. Skip pure filler ("okay so", "anyway").',
      '',
      'Give every thought exactly one kind:',
      kinds,
      '',
      `Give each thought zero to two topics from: ${topics}.`,
      'For to-dos with a time mentioned, set "due" to a short label like "Today", "Tomorrow", "Friday" or "Next week". Otherwise set "due" to "".',
      'Write a "title" of at most 7 words that names what the note is mostly about.',
      'Set "mood" to the overall tone: Upbeat, Neutral, Mixed or Heavy.',
      learned ? '\nThe person has corrected earlier sorting like this. Follow their preferences:\n' + learned : '',
      '',
      'Reply with only JSON in this shape:',
      '{"title": "...", "mood": "Neutral", "thoughts": [{"text": "...", "kind": "todo", "topics": ["work"], "due": "Tomorrow"}]}',
      '',
      '<transcript>',
      String(transcript || '').slice(0, 60000),
      '</transcript>',
    ].join('\n');
  }

  /** Validate and clean whatever Claude returned into the analyze() shape. */
  function normalizeClaudeResult(data, transcript) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.thoughts)) throw new Error('Claude replied in an unexpected shape.');
    const topicIds = new Set(TOPICS.map((t) => t.id));
    const thoughts = data.thoughts
      .filter((t) => t && typeof t.text === 'string' && t.text.trim())
      .map((t) => {
        const kind = KIND_IDS.includes(t.kind) ? t.kind : classify(t.text).kind;
        const out = {
          text: t.text.trim(),
          kind,
          topics: Array.isArray(t.topics) ? t.topics.filter((x) => topicIds.has(x)).slice(0, 2) : detectTopics(t.text, 2),
          confidence: 0.95,
        };
        if (kind === 'todo') {
          const due = typeof t.due === 'string' && t.due.trim() ? { label: t.due.trim().slice(0, 24), date: (detectDue(t.due) || {}).date || null } : detectDue(t.text);
          if (due) out.due = due;
        }
        return out;
      });
    if (!thoughts.length) throw new Error('Claude did not find any thoughts in this note.');
    const moods = ['Upbeat', 'Neutral', 'Mixed', 'Heavy'];
    const local = moodOf(transcript || thoughts.map((t) => t.text).join(' '));
    return {
      title: typeof data.title === 'string' && data.title.trim() ? data.title.trim().slice(0, 80) : makeTitle(thoughts),
      text: normalize(transcript || '').trim(),
      thoughts,
      mood: { score: local.score, label: moods.includes(data.mood) ? data.mood : local.label },
    };
  }

  function buildReflectionPrompt(notes, days) {
    const lines = [];
    for (const n of notes) {
      const when = new Date(n.createdAt).toISOString().slice(0, 16).replace('T', ' ');
      for (const t of n.thoughts || []) lines.push(`[${when}] (${t.kind}${t.done ? ', done' : ''}) ${t.text}`);
    }
    return [
      `Here are the sorted thoughts from my voice notes over the last ${days} days, oldest first.`,
      'Write me a short, warm reflection in plain text with these four parts, each a heading on its own line followed by two to four short lines:',
      'What keeps coming up',
      'Ideas worth chasing',
      'Open loops (unfinished to-dos and unanswered questions)',
      'One small next step',
      'Speak to me as "you". Be specific and quote my own words where it helps. No markdown symbols.',
      '',
      lines.join('\n').slice(-50000),
    ].join('\n');
  }

  /** Local stats for the Patterns view. */
  function summarize(notes, days, now) {
    const since = (now || Date.now()) - days * 86400000;
    const recent = notes.filter((n) => n.createdAt >= since);
    const byKind = Object.fromEntries(KIND_IDS.map((id) => [id, 0]));
    const byTopic = {};
    let thoughtsCount = 0;
    const openTodos = [];
    for (const n of recent) {
      for (const t of n.thoughts || []) {
        thoughtsCount++;
        byKind[t.kind] = (byKind[t.kind] || 0) + 1;
        for (const tp of t.topics || []) byTopic[tp] = (byTopic[tp] || 0) + 1;
        if (t.kind === 'todo' && !t.done) openTodos.push({ ...t, noteId: n.id, createdAt: n.createdAt });
      }
    }
    const topics = Object.entries(byTopic)
      .sort((a, b) => b[1] - a[1])
      .map(([id, count]) => ({ id, count, label: (TOPICS.find((t) => t.id === id) || { label: id }).label }));
    const moods = { Upbeat: 0, Neutral: 0, Mixed: 0, Heavy: 0 };
    for (const n of recent) if (n.mood && moods[n.mood.label] !== undefined) moods[n.mood.label]++;
    return { notes: recent.length, thoughts: thoughtsCount, byKind, topics, openTodos, moods };
  }

  // ---- Long transcripts ------------------------------------------------------

  /** Split text into pieces of at most maxChars, preferring paragraph, then sentence breaks. */
  function chunkText(text, maxChars) {
    const max = maxChars || 24000;
    const src = normalize(text).trim();
    if (src.length <= max) return src ? [src] : [];
    const pieces = [];
    for (const para of src.split(/\n\s*\n|\n/)) {
      if (para.length <= max) {
        pieces.push(para);
        continue;
      }
      let buf = '';
      for (const sentence of para.split(/(?<=[.!?])\s+/)) {
        if (sentence.length > max) {
          // No usable punctuation: fall back to a hard cut on a space.
          for (let i = 0; i < sentence.length; ) {
            let end = Math.min(sentence.length, i + max);
            if (end < sentence.length) {
              const sp = sentence.lastIndexOf(' ', end);
              if (sp > i) end = sp;
            }
            pieces.push(sentence.slice(i, end).trim());
            i = end;
          }
        } else if ((buf + ' ' + sentence).length > max) {
          pieces.push(buf.trim());
          buf = sentence;
        } else {
          buf = buf ? buf + ' ' + sentence : sentence;
        }
      }
      if (buf.trim()) pieces.push(buf.trim());
    }
    const chunks = [];
    let cur = '';
    for (const p of pieces.filter(Boolean)) {
      if (cur && cur.length + p.length + 2 > max) {
        chunks.push(cur);
        cur = p;
      } else {
        cur = cur ? cur + '\n\n' + p : p;
      }
    }
    if (cur) chunks.push(cur);
    return chunks;
  }

  const FILLER_WORDS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'erm', 'er', 'hmm', 'hm', 'mhm', 'ah']);

  /** Lowercase words without punctuation or filler, for matching text against timestamps. */
  function normWords(text) {
    return (normalize(text).toLowerCase().match(/[a-z0-9']+/g) || []).map((w) => w.replace(/'/g, '')).filter((w) => w && !FILLER_WORDS.has(w));
  }

  /** Turn word timestamps ({word|punctuated_word, start}) into a compact lookup. */
  function buildTiming(words) {
    const out = { words: [], starts: [] };
    for (const w of words || []) {
      const norm = normWords(w.punctuated_word || w.word || '');
      for (const n of norm) {
        out.words.push(n);
        out.starts.push(Math.round((Number(w.start) || 0) * 10) / 10);
      }
    }
    return out;
  }

  /**
   * Find when each thought was said. Thoughts are matched in order against the
   * timed words, tolerating small rewrites; a thought that can't be found gets
   * the start of the one before it.
   */
  function alignThoughts(thoughts, timing) {
    const W = (timing && timing.words) || [];
    const S = (timing && timing.starts) || [];
    let cursor = 0;
    let last = W.length ? S[0] : null;
    return thoughts.map((t) => {
      const tw = normWords(t.text).slice(0, 4);
      if (!tw.length || !W.length) return last;
      const need = Math.min(3, tw.length);
      const limit = Math.min(W.length, cursor + 4000);
      let found = -1;
      for (let p = cursor; p < limit && found < 0; p++) {
        if (W[p] !== tw[0] && W[p] !== tw[1]) continue;
        let hits = 0;
        let q = p;
        for (const w of tw) {
          for (let k = q; k <= Math.min(W.length - 1, p + 6); k++) {
            if (W[k] === w) {
              hits++;
              q = k + 1;
              break;
            }
          }
        }
        if (hits >= need) found = p;
      }
      if (found < 0) return last;
      cursor = found + 1;
      last = S[found];
      return last;
    });
  }

  const api = {
    KINDS,
    KIND_IDS,
    TOPICS,
    analyze,
    classify,
    tidy,
    splitSegments,
    detectTopics,
    detectDue,
    moodOf,
    learn,
    tokens,
    summarize,
    chunkText,
    normWords,
    buildTiming,
    alignThoughts,
    CLAUDE_SCHEMA,
    buildClaudePrompt,
    buildReflectionPrompt,
    normalizeClaudeResult,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.ThoughtEngine = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
