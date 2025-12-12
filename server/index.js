// index.js (final cleaned file for Memory Amigo - Voice Input)
const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '2mb' }));
app.use(express.static('public'));
const upload = multer({ dest: 'uploads/' });
const PORT = process.env.PORT || 8080;

// ---------------- Raindrop config + safe raindropCall helper ----------------
const RAINDROP_API_URL = (process.env.RAINDROP_MCP_URL || process.env.RAINDROP_API_URL || '').trim();
const RAINDROP_API_KEY = (process.env.RAINDROP_API_KEY || '').trim();
const RAINDROP_ORG_ID = (process.env.RAINDROP_ORG_ID || '').trim();
const RAINDROP_USER_ID = (process.env.RAINDROP_USER_ID || '').trim();

function raindropIsConfigured() {
  if (!RAINDROP_API_URL) return false;
  const l = RAINDROP_API_URL.toLowerCase();
  if (l.includes('example') || l.includes('raindrop.example') || l.includes('api.raindrop')) return false;
  if (!RAINDROP_API_KEY) return false;
  return true;
}

// Safe raindropCall -- adds user/org when appropriate and returns parsed body
async function raindropCall(path, method = "POST", payload = {}) {
  if (!RAINDROP_API_URL) {
    return { ok: false, error: "RAINDROP_NOT_CONFIGURED" };
  }

  // Pick correct API key for each Raindrop service
  let key = null;

  if (path.includes("smartmemory")) {
    key = process.env.SMARTMEMORY_API_KEY;
  } else if (path.includes("smartsql")) {
    key = process.env.SMARTSQL_API_KEY;
  } else if (path.includes("smartinference")) {
    key = process.env.SMARTINFERENCE_API_KEY;
  }

  if (!key) {
    return { ok: false, error: "NO_VALID_KEY_FOR_ENDPOINT", path };
  }

  // Add mandatory fields
  payload.organization_id = process.env.RAINDROP_ORG_ID;
  payload.user_id = process.env.RAINDROP_USER_ID;

  try {
    const response = await fetch(`${RAINDROP_API_URL}${path}`, {
      method,
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }

  } catch (err) {
    return { ok: false, error: "RAINDROP_CALL_FAILED", message: err.message };
  }
}
  // ensure payload is an object (if provided)
  let bodyObj = (payload && typeof payload === 'object') ? { ...payload } : (payload ? payload : {});

  // For smart endpoints add user_id & organization_id if available and not present
  const pLower = (endpointPath || '').toLowerCase();
  if ((pLower.includes('smartmemory') || pLower.includes('smartsql') || pLower.includes('smartinference'))) {
    if (RAINDROP_ORG_ID && !bodyObj.organization_id && !bodyObj.organization) bodyObj.organization_id = RAINDROP_ORG_ID;
    if (RAINDROP_USER_ID && !bodyObj.user_id && !bodyObj.user) bodyObj.user_id = RAINDROP_USER_ID;
  }

  const headers = {
    'Authorization': `Bearer ${RAINDROP_API_KEY}`,
    'Content-Type': 'application/json'
  };

  const url = RAINDROP_API_URL.endsWith('/') ? `${RAINDROP_API_URL.slice(0, -1)}${endpointPath}` : `${RAINDROP_API_URL}${endpointPath}`;

  try {
    const resp = await fetch(url, {
      method,
      headers,
      body: Object.keys(bodyObj).length ? JSON.stringify(bodyObj) : undefined
    });

    const text = await resp.text();
    try {
      return JSON.parse(text);
    } catch (e) {
      return { ok: resp.ok, status: resp.status, raw: text };
    }
  } catch (e) {
    console.error('[raindropCall] network error:', e);
    return { ok: false, error: 'RAINDROP_CALL_FAILED', message: e.message };
  }
}

// ---------------------- SAVE (Raindrop preferred, fallback mock) ----------------------
const SMARTMEM_FILE = path.join(__dirname, 'smartmemory.json');
function loadSmartMem() {
  try {
    if (!fs.existsSync(SMARTMEM_FILE)) fs.writeFileSync(SMARTMEM_FILE, JSON.stringify({ items: [] }, null, 2));
    return JSON.parse(fs.readFileSync(SMARTMEM_FILE, 'utf8'));
  } catch (e) {
    console.error('loadSmartMem error', e);
    return { items: [] };
  }
}
function saveSmartMem(data) {
  try {
    fs.writeFileSync(SMARTMEM_FILE, JSON.stringify(data, null, 2));
    return true;
  } catch (e) {
    console.error('saveSmartMem error', e);
    return false;
  }
}

// Unified save endpoint: prefer Raindrop if configured; otherwise save to local mock
app.post('/api/save', async (req, res) => {
  const body = req.body || {};

  // build canonical payload
  const payload = {
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

  // attempt Raindrop if configured
  if (raindropIsConfigured()) {
    try {
      const rpc = await raindropCall('/smartmemory/save', 'POST', payload);
      // success cases may vary; accept rpc.ok === true or rpc.result presence
      if (rpc && (rpc.ok === true || rpc.result)) {
        return res.json({ ok: true, provider: 'raindrop', result: rpc });
      }
      // otherwise fall through to fallback (but include the rp error in logs)
      console.warn('[RAINDROP SAVE] raindrop responded:', rpc);
    } catch (e) {
      console.error('[RAINDROP SAVE] exception', e);
    }
  }

  // fallback local save
  try {
    const mem = loadSmartMem();
    const id = 'mm_' + Date.now();
    const item = {
      id,
      title: payload.title,
      content: payload.content,
      tags: payload.tags,
      metadata: payload.metadata
    };
    mem.items.unshift(item);
    saveSmartMem(mem);
    return res.json({ ok: true, provider: 'mock', result: item, mock: true });
  } catch (e) {
    console.error('[SAVE] fallback save failed', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// ---------------------- Transcribe via ElevenLabs (file upload) ----------------------
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  const audioPath = req.file && req.file.path;
  if (!audioPath) return res.status(400).json({ ok: false, error: 'no_audio_file' });

  try {
    // read key at runtime (so updating Replit secrets takes effect without code change)
    const ELEVEN_KEY_RUNTIME = (process.env.ELEVEN_KEY || process.env.ELEVEN_API_KEY || '').trim();
    if (!ELEVEN_KEY_RUNTIME) {
      if (fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
      return res.status(500).json({ ok: false, error: 'ELEVEN_KEY_NOT_SET' });
    }

    const scribeUrl = `https://api.elevenlabs.io/v1/speech-to-text`;
    const FormData = require('form-data');
    const form = new FormData();
    form.append('file', fs.createReadStream(path.resolve(audioPath)));
    // include both keys (safe): model_id is expected, model may be accepted in some SDKs
    form.append('model_id', 'scribe_v1');
    form.append('model', 'scribe_v1');

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

// ---------------------- Smart endpoints (search, recent, infer) ----------------------

// Semantic search via SmartSQL
app.get('/api/search', async (req, res) => {
  const q = req.query.q || '';
  try {
    const payload = { query: q, limit: 12 };
    const result = await raindropCall('/smartsql/query', 'POST', payload);
    return res.json({ ok: true, result });
  } catch (e) {
    console.error('/api/search error', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// Recent entries list (convenience)
app.get('/api/recent', async (req, res) => {
  try {
    const payload = { limit: 20 };
    const result = await raindropCall('/smartmemory/list', 'POST', payload);
    return res.json({ ok: true, result });
  } catch (e) {
    console.error('/api/recent error', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// Infer / Summarize (wrap SmartInference)
app.post('/api/infer', async (req, res) => {
  const { mode, contextEntries = [], query } = req.body || {};
  try {
    let prompt = '';
    if (mode === 'weekly_summary') {
      prompt = `You are Memory Amigo assistant. Summarize the entries into a concise weekly report. Provide 3 themes, mood summary, top 3 learnings, 3 next steps.\n\nEntries:\n${contextEntries.join('\n\n')}`;
    } else {
      prompt = `Answer: "${query}". Use context:\n${contextEntries.join('\n\n')}`;
    }
    const payload = { prompt, options: { temperature: 0.2, maxTokens: 700 } };
    const result = await raindropCall('/smartinference/infer', 'POST', payload);
    return res.json({ ok: true, result });
  } catch (e) {
    console.error('/api/infer error', e);
    return res.status(500).json({ ok:false, error: e.message });
  }
});

// ---------------------- MOCK SMARTMEMORY (local) ----------------------

// Save, list, query and infer mock endpoints (these are used when Raindrop is not configured)
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
      categories: body.metadata?.categories || body.categories || [],
      mood: body.metadata?.mood || body.mood || null,
      date: body.metadata?.date || new Date().toISOString(),
      source: body.metadata?.source || body.source || 'voice',
      audio_url: body.metadata?.audio_url || body.audio_url || null
    }
  };

  mem.items.unshift(item);
  saveSmartMem(mem);
  return res.json({ ok: true, result: item, mock: true });
});

app.post('/api/smartmemory/list', (req, res) => {
  const { limit } = req.body || {};
  const mem = loadSmartMem();
  const items = mem.items.slice(0, limit || 50);
  return res.json({ ok: true, items });
});

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

    const themes = Object.entries(catCount).sort((a,b) => b[1]-a[1]).map(([cat])=>cat).slice(0,3);
    const moodSummary = Object.entries(moodCount).sort((a,b)=>b[1]-a[1]).map(([m,c])=>`${m} (${c})`).slice(0,3);

    return res.json({ ok: true, summary: { themes: themes.length ? themes : ["no major themes"], mood_summary: moodSummary, top_learnings: learnings.slice(0,3), next_steps: ["Reflect on your dominant theme.", "Act on one insight tomorrow.", "Spend 3 minutes reviewing memories each morning."] }});
  }

  if (query) {
    const q = query.toLowerCase();
    const matches = recent.filter(it => ((it.title||'') + ' ' + (it.content||'')).toLowerCase().includes(q)).slice(0,8);
    return res.json({ ok: true, answer: matches.map(m => `- ${m.title}: ${m.content.slice(0,140)}`).join("\n") || "No matches found.", matches });
  }

  return res.json({ ok: false, error: "No mode or query provided" });
});

// ---------------------- Start ----------------------
app.listen(PORT, () => console.log(`Memory Amigo voice server running on ${PORT}`));
