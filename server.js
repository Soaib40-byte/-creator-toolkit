const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 3000;
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.vtt': 'text/vtt; charset=utf-8',
  '.srt': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

// Load .env variables into process.env
function loadEnv() {
  try {
    const envPath = path.join(__dirname, '.env');
    if (fs.existsSync(envPath)) {
      const content = fs.readFileSync(envPath, 'utf8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
          const idx = trimmed.indexOf('=');
          const key = trimmed.slice(0, idx).trim();
          const val = trimmed.slice(idx + 1).trim().replace(/^["']|["']$/g, '');
          if (val) {
            process.env[key] = val;
          }
        }
      }
    }
  } catch (e) {
    console.error('Error reading .env file:', e);
  }
}

// Initial env load
loadEnv();

function getApiKey() {
  loadEnv();
  return (process.env.GEMINI_API_KEY || '').trim();
}

// Helper to read JSON request body (up to 50MB)
function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    const MAX_BYTES = 50 * 1024 * 1024; // 50MB

    req.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > MAX_BYTES) {
        req.destroy();
        reject(new Error('Payload too large. Maximum supported size is 50MB.'));
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        const json = raw ? JSON.parse(raw) : {};
        resolve(json);
      } catch (err) {
        reject(new Error('Invalid JSON payload'));
      }
    });

    req.on('error', err => reject(err));
  });
}

// Helper to call Gemini AI API for word-by-word transcription
async function callGeminiForWordTimestamps(audioBase64, mimeType, language) {
  const apiKey = getApiKey();
  if (!apiKey) {
    throw new Error('NO_API_KEY');
  }

  const prompt = `You are an expert audio transcription and subtitle timing engine.
Transcribe the spoken audio with exact millisecond start and end timestamps for EVERY SINGLE WORD.
Spoken Language: ${language || 'Bengali/English'}

CRITICAL REQUIREMENTS:
1. Output MUST be ONLY a valid raw JSON array of objects with the exact schema:
[
  {"word": "word1", "start": 0.120, "end": 0.450},
  {"word": "word2", "start": 0.460, "end": 0.820}
]
2. 'start' and 'end' must be numbers in seconds with millisecond precision (3 decimals).
3. Transcribe all spoken words accurately (Bengali script for Bengali, Latin script for English).
4. Do NOT output markdown backticks (\`\`\`json), explanations, or notes. Output ONLY the JSON array.`;

  const requestBody = {
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: mimeType || 'audio/mp3',
              data: audioBase64
            }
          },
          {
            text: prompt
          }
        ]
      }
    ],
    generationConfig: {
      temperature: 0.1,
      responseMimeType: 'application/json'
    }
  };

  // Active models verified with this API key
  const models = ['gemini-3.5-flash', 'gemini-3.5-flash-lite', 'gemini-flash-latest'];
  let lastError = null;

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const errText = await response.text();
        console.warn(`Model ${model} returned ${response.status}:`, errText);
        lastError = new Error(`Gemini API error (${response.status}): ${errText}`);
        continue;
      }

      const resData = await response.json();
      const rawText = resData?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        throw new Error('No transcription returned from Gemini model');
      }

      // Clean raw text if wrapped in markdown
      let cleaned = rawText.trim();
      if (cleaned.startsWith('```json')) cleaned = cleaned.slice(7);
      if (cleaned.startsWith('```')) cleaned = cleaned.slice(3);
      if (cleaned.endsWith('```')) cleaned = cleaned.slice(0, -3);
      cleaned = cleaned.trim();

      const wordsArray = JSON.parse(cleaned);
      if (!Array.isArray(wordsArray) || wordsArray.length === 0) {
        throw new Error('Transcribed output was not a valid non-empty array of words');
      }

      // Normalize and ensure each word is an individual timestamp
      const sanitized = [];
      wordsArray.forEach(item => {
        const textStr = String(item.word || item.text || '').trim();
        const startNum = Number(item.start || item.startTime || 0);
        const endNum = Number(item.end || item.endTime || (startNum + 0.3));
        
        const subWords = textStr.split(/\s+/).filter(Boolean);
        if (subWords.length > 1) {
          const durPerWord = Math.max(0.08, (endNum - startNum) / subWords.length);
          subWords.forEach((sw, idx) => {
            const wStart = Math.round((startNum + idx * durPerWord) * 1000) / 1000;
            const wEnd = Math.round((wStart + durPerWord) * 1000) / 1000;
            sanitized.push({ word: sw, start: wStart, end: wEnd });
          });
        } else if (subWords.length === 1) {
          sanitized.push({ word: subWords[0], start: startNum, end: endNum });
        }
      });

      if (sanitized.length === 0) {
        throw new Error('No spoken words could be recognized in the audio.');
      }

      return sanitized;
    } catch (e) {
      lastError = e;
      console.warn(`Failed with model ${model}:`, e.message);
    }
  }

  throw lastError || new Error('Transcription failed on all Gemini models');
}

const server = http.createServer(async (req, res) => {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = parsedUrl.pathname;

  // -------------------------------------------------------------
  // API ROUTE 1: GET /api/status - Check if server has Gemini Key
  // -------------------------------------------------------------
  if (pathname === '/api/status' && req.method === 'GET') {
    const key = getApiKey();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      configured: !!key && key.length > 5,
      hasKey: !!key && key.length > 5,
      mode: key ? 'server_engine_active' : 'admin_key_needed',
      message: key 
        ? 'Creator Server AI Engine is active and ready for all users.' 
        : 'Admin setup required: GEMINI_API_KEY is not configured on the server.'
    }));
    return;
  }

  // -----------------------------------------------------------------
  // API ROUTE 2: POST /api/set-server-key - Admin saves key to server
  // -----------------------------------------------------------------
  if (pathname === '/api/set-server-key' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const newKey = (body.apiKey || '').trim();
      
      if (!newKey || newKey.length < 5) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Invalid API key provided' }));
        return;
      }

      // Write to .env file permanently
      const envPath = path.join(__dirname, '.env');
      let currentContent = '';
      if (fs.existsSync(envPath)) {
        currentContent = fs.readFileSync(envPath, 'utf8');
      }

      let updatedContent = '';
      if (currentContent.includes('GEMINI_API_KEY=')) {
        updatedContent = currentContent.replace(/GEMINI_API_KEY=.*/g, `GEMINI_API_KEY=${newKey}`);
      } else {
        updatedContent = currentContent + (currentContent.endsWith('\n') ? '' : '\n') + `GEMINI_API_KEY=${newKey}\n`;
      }

      fs.writeFileSync(envPath, updatedContent, 'utf8');
      process.env.GEMINI_API_KEY = newKey;

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        message: 'Server Gemini API Key successfully saved! All visitors can now transcribe without entering any key.'
      }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: false, error: err.message }));
    }
    return;
  }

  // ------------------------------------------------------------------
  // API ROUTE 3: POST /api/transcribe - Transcribe Audio for any user
  // ------------------------------------------------------------------
  if (pathname === '/api/transcribe' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const { audioBase64, mimeType, language } = body;

      if (!audioBase64) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: false, error: 'Missing audioBase64 in request' }));
        return;
      }

      const apiKey = getApiKey();
      if (!apiKey) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: false,
          error: 'SERVER_KEY_NOT_CONFIGURED',
          message: 'Website administrator has not configured the server API key yet.'
        }));
        return;
      }

      console.log(`Transcribing audio (${(audioBase64.length / 1024).toFixed(1)} KB base64) for language: ${language}...`);
      const words = await callGeminiForWordTimestamps(audioBase64, mimeType, language);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: true,
        wordsCount: words.length,
        words: words
      }));
    } catch (err) {
      console.error('Transcription error:', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        success: false,
        error: err.message
      }));
    }
    return;
  }

  // -------------------------------------------------------------
  // STATIC FILE SERVING
  // -------------------------------------------------------------
  let reqPath = decodeURI(pathname);
  if (reqPath === '/' || reqPath === '') {
    reqPath = '/index.html';
  }

  const filePath = path.join(__dirname, reqPath);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback to index.html for SPA
      const indexPath = path.join(__dirname, 'index.html');
      fs.readFile(indexPath, (err2, data) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain' });
          res.end('Not Found');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(data);
        }
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';

    // Support range requests for video & audio scrubbing
    const range = req.headers.range;
    if (range) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, { start, end });
      res.writeHead(206, {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType
      });
      file.pipe(res);
    } else {
      res.writeHead(200, {
        'Content-Length': stats.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes'
      });
      fs.createReadStream(filePath).pipe(res);
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Creator Toolkit web server running on http://0.0.0.0:${PORT}`);
  console.log(`Server API Key configured: ${!!getApiKey()}`);
});
