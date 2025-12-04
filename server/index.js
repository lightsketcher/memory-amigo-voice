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

// === CONFIG (set these as env vars in Replit / Vultr) ===
const RAINDROP_API_URL = process.env.RAINDROP_API_URL || "https://api.raindrop.example";
const RAINDROP_API_KEY = process.env.RAINDROP_API_KEY || "REPLACE_RAINDROP_KEY";
const ELEVEN_KEY = process.env.ELEVEN_KEY || "REPLACE_ELEVEN_KEY";
// ======================================================

async function raindropCall(path, method='POST', payload=null) {
  const opts = { method, headers: { 'Authorization': `Bearer ${RAINDROP_API_KEY}`, 'Content-Type': 'application/json' } };
  if (payload) opts.body = JSON.stringify(payload);
  const res = await fetch(`${RAINDROP_API_URL}${path}`, opts);
  const text = await res.text();
  try { return JSON.parse(text); } catch(e) { return { raw: text, status: res.status, body: text }; }
}

// Save text entry to SmartMemory (with safe mock if Raindrop not configured)
app.post('/api/save', async (req, res) => {
  const { title, content, categories, tags, mood, date } = req.body;

  // If RAINDROP_API_URL is still the placeholder, return a mock response
  if (!RAINDROP_API_URL || RAINDROP_API_URL.includes('example')) {
    console.log('RAINDROP not configured — returning mock save response');
    const mock = {
      id: 'mock-' + Date.now(),
      title: title || (content||'').slice(0,40),
      content,
      metadata: { categories: categories || [], mood: mood || null, date: date || new Date().toISOString(), source: 'voice' }
    };
    return res.json({ ok: true, result: mock });
  }

  try {
    const payload = {
      title: title || (content||'').slice(0,40),
      content,
      tags: tags || [],
      metadata: { categories: categories || [], mood: mood || null, date: date || new Date().toISOString(), source: 'voice' }
    };
    const result = await raindropCall('/smartmemory/save', 'POST', payload);
    res.json({ ok: true, result });
  } catch (e) { console.error(e); res.status(500).json({ ok:false, error: e.message }); }
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


app.listen(PORT, () => console.log(`Memory Amigo voice server running on ${PORT}`));
