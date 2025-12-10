// index.js (Voice-Input Only)
const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json({limit:'1mb'}));
app.use(express.static('public')); // serve frontend from public/
const upload = multer({ dest: 'uploads/' });
const PORT = process.env.PORT || 8080;

// ---------------- Raindrop config + safe raindropCall helper ----------------
const RAINDROP_API_URL = (process.env.RAINDROP_MCP_URL || process.env.RAINDROP_API_URL || '').trim();
const RAINDROP_API_KEY = (process.env.RAINDROP_API_KEY || '').trim();
const ELEVEN_KEY = (process.env.ELEVEN_KEY || process.env.ELEVEN_API_KEY || '').trim();

function raindropIsConfigured() {
  if (!RAINDROP_API_URL) return false;
  const l = RAINDROP_API_URL.toLowerCase();
  // treat obvious placeholders as not configured
  if (l.includes('example') || l.includes('raindrop.example') || l.includes('api.raindrop')) return false;
  if (!RAINDROP_API_KEY) return false;
  return true;
}

// Safe raindropCall: returns RAINDROP_NOT_CONFIGURED if not set, otherwise performs the call
async function raindropCall(path, method = 'POST', payload = null) {
  if (!raindropIsConfigured()) {
    // Return a predictable object so calling code can fallback to mock
    return { ok: false, error: 'RAINDROP_NOT_CONFIGURED', path, method, payload };
  }

  const opts = {
    method,
    headers: {
      'Authorization': `Bearer ${RAINDROP_API_KEY}`,
      'Content-Type': 'application/json'
    }
  };
  if (payload) opts.body = JSON.stringify(payload);

  const res = await fetch(`${RAINDROP_API_URL}${path}`, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch (e) { return { raw: text, status: res.status, body: text }; }
}


// Transcribe uploaded audio via ElevenLabs Scribe STT (safe: reads env at runtime)
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  const audioPath = req.file && req.file.path;
  if (!audioPath) return res.status(400).json({ ok: false, error: 'no_audio_file' });

  try {
    // read key directly from process.env at call time to avoid ReferenceError
    const ELEVEN_KEY_RUNTIME = (process.env.ELEVEN_KEY || process.env.ELEVEN_API_KEY || '').trim();
    if (!ELEVEN_KEY_RUNTIME) {
      // Clean up uploaded file before returning
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      return res.status(500).json({ ok: false, error: 'ELEVEN_KEY_NOT_SET' });
    }

    const scribeUrl = `https://api.elevenlabs.io/v1/speech-to-text`;
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', fs.createReadStream(path.resolve(audioPath)));
    form.append('model_id', 'scribe_v1');

    const sttRes = await fetch(scribeUrl, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVEN_KEY_RUNTIME, ...form.getHeaders() },
      body: form
    });

    const status = sttRes.status;
    const textBody = await sttRes.text();
    console.log(`[ElevenLabs STT] status=${status} body=${textBody}`);

    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    let sttJson;
    try { sttJson = JSON.parse(textBody); } catch (e) { sttJson = { rawText: textBody }; }

    if (!sttRes.ok) {
      return res.status(502).json({ ok: false, error: 'elevenlabs_stt_failed', status, body: sttJson });
    }

    const transcript = sttJson.text || sttJson.transcript || sttJson.result || textBody;
    return res.json({ ok: true, transcript, raw: sttJson });
  } catch (e) {
    console.error('[Transcribe error]', e);
    if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

  // If Raindrop is configured, attempt to call it (but we handle failures)
  if (raindropIsConfigured()) {
    try {
      const payload = {
        title: body.title || (body.content||'').slice(0,40),
        content: body.content,
        tags: body.tags || [],
        metadata: {
          categories: body.categories || [],
          mood: body.mood || null,
          date: body.date || new Date().toISOString(),
          source: body.source || 'voice',
          audio_url: body.audio_url || null
        }
      };
      const result = await raindropCall('/smartmemory/save', 'POST', payload);
      // If raindropCall flagged not-configured or returned an error, fall through to mock
      if (result && result.ok) return res.json({ ok:true, result, provider: 'raindrop' });
      // else continue to fallback to mock
    } catch (e) {
      console.error('Raindrop save attempt failed, falling back to mock', e);
      // continue to fallback
    }
  }

  // FALLBACK: write to local mock storage (guaranteed)
  try {
    const payload = {
      title: body.title || (body.content||'').slice(0,40),
      content: body.content || '',
      tags: body.tags || [],
      metadata: {
        categories: body.categories || [],
        mood: body.mood || null,
        date: body.date || new Date().toISOString(),
        source: body.source || 'voice',
        audio_url: body.audio_url || null
      }
    };
    const mem = loadSmartMem();
    const id = 'mm_' + Date.now();
    const item = { id, title: payload.title, content: payload.content, tags: payload.tags, metadata: payload.metadata };
    mem.items.unshift(item);
    saveSmartMem(mem);
    return res.json({ ok: true, result: item, mock: true });
  } catch (e) {
    console.error('Mock save failed', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});



// Semantic search via SmartSQL
app.get('/api/search', async (req, res) => {
  const q = req.query.q || '';
  try {
    const payload = { query: q, limit: 12 };
    const result = await raindropCall('/smartsql/query', 'POST', payload);
    res.json({ ok: true, result });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, error: e.message }); }
});

// Recent entries list (convenience)
app.get('/api/recent', async (req, res) => {
  try {
    const payload = { limit: 20 };
    const result = await raindropCall('/smartmemory/list', 'POST', payload);
    res.json({ ok: true, result });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, error: e.message }); }
});

// Infer / Summarize (wrap SmartInference)
app.post('/api/infer', async (req, res) => {
  const { mode, contextEntries, query } = req.body;
  try {
    let prompt = '';
    if (mode === 'weekly_summary') {
      prompt = `You are Memory Amigo assistant. Summarize the entries into a concise weekly report. Provide 3 themes, mood summary, top 3 learnings, 3 next steps.\n\nEntries:\n${contextEntries.join('\n\n')}`;
    } else {
      prompt = `Answer: "${query}". Use context:\n${contextEntries.join('\n\n')}`;
    }
    const payload = { prompt, options: { temperature:0.2, maxTokens:700 } };
    const result = await raindropCall('/smartinference/infer', 'POST', payload);
    res.json({ ok: true, result });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, error: e.message }); }
});

// Transcribe uploaded audio via ElevenLabs Scribe STT (fixed: use model_id)
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  const audioPath = req.file.path;
  try {
    const scribeUrl = `https://api.elevenlabs.io/v1/speech-to-text`;
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', fs.createReadStream(path.resolve(audioPath)));
    // ElevenLabs expects 'model_id' not 'model'
    form.append('model_id', 'scribe_v1');

    const sttRes = await fetch(scribeUrl, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVEN_KEY, ...form.getHeaders() },
      body: form
    });

    const status = sttRes.status;
    const textBody = await sttRes.text();
    console.log(`[ElevenLabs STT] status=${status} body=${textBody}`);

    fs.unlinkSync(audioPath);
    let sttJson;
    try { sttJson = JSON.parse(textBody); } catch(e) { sttJson = { rawText: textBody }; }

    if (!sttRes.ok) {
      return res.status(502).json({ ok: false, error: 'elevenlabs_stt_failed', status, body: sttJson });
    }

    const transcript = sttJson.text || sttJson.transcript || sttJson.result || textBody;
    return res.json({ ok: true, transcript, raw: sttJson });
  } catch (e) {
    console.error('[Transcribe error]', e);
    if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// ---------------------- MOCK SMARTMEMORY (LOCAL STORAGE) ----------------------

const SMARTMEM_FILE = path.join(__dirname, 'smartmemory.json');

// helper: load & save JSON
function loadSmartMem() {
  try {
    if (!fs.existsSync(SMARTMEM_FILE)) {
      fs.writeFileSync(SMARTMEM_FILE, JSON.stringify({ items: [] }, null, 2));
    }
    const raw = fs.readFileSync(SMARTMEM_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('Error loading smartmemory:', e);
    return { items: [] };
  }
}

function saveSmartMem(data) {
  try {
    fs.writeFileSync(SMARTMEM_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error('Error saving smartmemory:', e);
    return false;
  }
}

// SAVE MEMORY
app.post('/api/smartmemory/save', (req, res) => {
  const body = req.body || {};
  const mem = loadSmartMem();
  const id = "mm_" + Date.now();

  const item = {
    id,
    title: body.title || (body.content || '').slice(0, 40),
    content: body.content || '',
    tags: body.tags || [],
    metadata: {
      categories: body.categories || [],
      mood: body.mood || null,
      date: body.date || new Date().toISOString(),
      source: body.source || 'voice',
      audio_url: body.audio_url || null
    }
  };

  mem.items.unshift(item);
  saveSmartMem(mem);

  return res.json({ ok: true, result: item, mock: true });
});

// LIST MEMORY
app.post('/api/smartmemory/list', (req, res) => {
  const { limit } = req.body || {};
  const mem = loadSmartMem();
  const items = mem.items.slice(0, limit || 50);
  return res.json({ ok: true, items });
});

// QUERY MEMORY
app.post('/api/smartmemory/query', (req, res) => {
  const { query, limit } = req.body || {};
  if (!query || !query.trim()) return res.json({ ok: true, items: [] });

  const q = query.toLowerCase();
  const mem = loadSmartMem();
  const items = mem.items
    .filter(item => {
      const text = ((item.title || '') + ' ' + (item.content || '')).toLowerCase();
      return text.includes(q) || (item.tags || []).some(t => t.toLowerCase().includes(q));
    })
    .slice(0, limit || 50);

  return res.json({ ok: true, items });
});

// INFERENCE (Weekly Summary, Mood, Themes)
app.post('/api/smartmemory/infer', (req, res) => {
  const { mode, query } = req.body || {};
  const mem = loadSmartMem();
  const recent = mem.items.slice(0, 20);

  if (mode === 'weekly_summary') {
    const catCount = {};
    const moodCount = {};
    const learnings = [];

    recent.forEach(it => {
      const categories = it.metadata?.categories || [];
      categories.forEach(c => catCount[c] = (catCount[c] || 0) + 1);

      const mood = it.metadata?.mood || 'neutral';
      moodCount[mood] = (moodCount[mood] || 0) + 1;

      const content = it.content || '';
      if (/learn|realize|understand|lesson/gi.test(content)) {
        learnings.push(content.slice(0, 150));
      }
    });

    const themes = Object.entries(catCount)
      .sort((a, b) => b[1] - a[1])
      .map(([cat]) => cat)
      .slice(0, 3);

    const moodSummary = Object.entries(moodCount)
      .sort((a, b) => b[1] - a[1])
      .map(([m, c]) => `${m} (${c})`)
      .slice(0, 3);

    return res.json({
      ok: true,
      summary: {
        themes: themes.length ? themes : ["no major themes"],
        mood_summary: moodSummary,
        top_learnings: learnings.slice(0, 3),
        next_steps: [
          "Reflect on your dominant theme.",
          "Act on one insight tomorrow.",
          "Spend 3 minutes reviewing memories each morning."
        ]
      }
    });
  }

  // Simple text search inference
  if (query) {
    const q = query.toLowerCase();
    const matches = recent.filter(it =>
      ((it.title || '') + ' ' + (it.content || '')).toLowerCase().includes(q)
    ).slice(0, 8);

    return res.json({
      ok: true,
      answer:
        matches.map(m => `- ${m.title}: ${m.content.slice(0, 140)}`).join("\n") ||
        "No matches found.",
      matches
    });
  }

  return res.json({ ok: false, error: "No mode or query provided" });
});

app.listen(PORT, () => console.log(`Memory Amigo voice server running on ${PORT}`));
