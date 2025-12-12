// =======================
// MEMORY AMIGO - FINAL VERSION
// =======================

const express = require('express');
const fetch = require('node-fetch');
const bodyParser = require('body-parser');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: "2mb" }));
app.use(express.static("public"));
const upload = multer({ dest: "uploads/" });

// ---------------------- ENV ----------------------

const RAINDROP_MCP_URL = process.env.RAINDROP_MCP_URL?.trim();
const SMARTMEMORY_API_KEY = process.env.SMARTMEMORY_API_KEY?.trim();
const SMARTSQL_API_KEY = process.env.SMARTSQL_API_KEY?.trim();
const SMARTINFERENCE_API_KEY = process.env.SMARTINFERENCE_API_KEY?.trim();
const RAINDROP_ORG_ID = process.env.RAINDROP_ORG_ID?.trim();

if (!RAINDROP_MCP_URL || !SMARTMEMORY_API_KEY || !SMARTSQL_API_KEY || !SMARTINFERENCE_API_KEY || !RAINDROP_ORG_ID) {
  console.error("❌ Missing required env variables");
}

// ---------------------- MCP CALL HELPER ----------------------

async function raindropCall(path, apiKey, payload = {}) {
  const url = `${RAINDROP_MCP_URL}${path}`;

  const body = {
    ...payload,
    organization_id: RAINDROP_ORG_ID
  };

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });

    const text = await res.text();
    try { return JSON.parse(text); }
    catch { return { raw: text, status: res.status }; }

  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// =======================
// SAVE MEMORY
// =======================

app.post("/api/save", async (req, res) => {
  const body = req.body;
  const payload = {
    title: body.title || body.content.slice(0, 40),
    content: body.content,
    tags: body.tags || [],
    metadata: {
      categories: body.categories || [],
      mood: body.mood || null,
      date: new Date().toISOString(),
      source: "voice",
      audio_url: body.audio_url || null
    }
  };

  const result = await raindropCall("/smartmemory/save", SMARTMEMORY_API_KEY, payload);
  return res.json(result);
});

// =======================
// SEARCH MEMORY
// =======================

app.get("/api/search", async (req, res) => {
  const q = req.query.q || "";

  const result = await raindropCall("/smartsql/query", SMARTSQL_API_KEY, {
    query: q,
    limit: 20
  });

  res.json(result);
});

// =======================
// INFERENCE (SUMMARY)
// =======================

app.post("/api/infer", async (req, res) => {
  const { mode, query, contextEntries } = req.body;

  const prompt =
    mode === "weekly_summary"
      ? `Write a weekly summary using:\n${contextEntries.join("\n\n")}`
      : `Answer the query: ${query}\nUsing memory:\n${contextEntries.join("\n\n")}`;

  const result = await raindropCall("/smartinference/infer", SMARTINFERENCE_API_KEY, {
    prompt,
    options: { temperature: 0.2, maxTokens: 500 }
  });

  res.json(result);
});

// =======================
// ELEVENLABS STT
// =======================

app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  const audioPath = req.file.path;
  const ELEVEN_KEY = process.env.ELEVEN_KEY;

  const FormData = require("form-data");
  const form = new FormData();
  form.append("file", fs.createReadStream(path.resolve(audioPath)));
  form.append("model_id", "scribe_v1");

  try {
    const sttRes = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": ELEVEN_KEY, ...form.getHeaders() },
      body: form
    });

    const bodyText = await sttRes.text();
    let parsed = {};
    try { parsed = JSON.parse(bodyText); } catch { parsed = { raw: bodyText }; }

    fs.unlinkSync(audioPath);
    return res.json({ ok: sttRes.ok, ...parsed });

  } catch (e) {
    fs.unlinkSync(audioPath);
    return res.json({ ok: false, error: e.message });
  }
});

// =======================
// START SERVER
// =======================

app.listen(5000, "0.0.0.0", () =>
  console.log(`✅ Memory Amigo server running on 5000`)
);
