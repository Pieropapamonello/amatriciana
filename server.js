const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = 7860;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';
const LINKS_FILE = '/tmp/tg-links.json';

const MIME = {
  '.html': 'text/html',
  '.js':   'application/javascript',
  '.css':  'text/css',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch { resolve({}); }
    });
    req.on('error', reject);
  });
}

function loadLinks() {
  try { return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); } catch { return {}; }
}
function saveLinks(obj) {
  try { fs.writeFileSync(LINKS_FILE, JSON.stringify(obj)); } catch (e) { console.warn('save links failed', e); }
}

function tgRequest(method, payload) {
  if (!TG_TOKEN) return Promise.reject(new Error('No Telegram token'));
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${TG_TOKEN}/${method}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

const server = http.createServer(async (req, res) => {
  if (req.url === '/api/auth-config') {
    const email    = process.env.FB_EMAIL || '';
    const password = process.env.FB_PASS  || '';
    if (!email || !password) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ error: 'Credenziali non configurate' }));
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ email, password }));
  }

  if (req.url === '/api/admin-verify' && req.method === 'POST') {
    const adminPass = process.env.ADMIN_PASS || '';
    if (!adminPass) {
      res.writeHead(503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: 'Password admin non configurata' }));
    }
    const body = await readBody(req);
    const pw = (body.password || '').normalize('NFC');
    const expected = adminPass.normalize('NFC');
    const a = Buffer.from(pw);
    const b = Buffer.from(expected);
    const ok = a.length === b.length && crypto.timingSafeEqual(a, b);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ ok }));
  }

  if (req.url === '/api/gemini-key' && req.method === 'GET') {
    const key = process.env.GEMINI_KEY || '';
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ key }));
  }

  if (req.url === '/api/telegram/info' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ enabled: !!TG_TOKEN, botUsername: TG_BOT_USERNAME }));
  }

  if (req.url === '/api/telegram/links' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(loadLinks()));
  }

  if (req.url === '/api/telegram/webhook' && req.method === 'POST') {
    const update = await readBody(req);
    try {
      const msg = update.message;
      if (msg && msg.text && msg.text.startsWith('/start')) {
        const parts = msg.text.split(' ');
        const code = parts[1] || '';
        const chatId = msg.chat.id;
        if (code) {
          const links = loadLinks();
          links[code] = { chatId, linkedAt: new Date().toISOString(), name: msg.from.first_name || '' };
          saveLinks(links);
          await tgRequest('sendMessage', {
            chat_id: chatId,
            text: '✅ Collegato! Riceverai ogni sera il tuo turno del giorno dopo.',
          });
        } else {
          await tgRequest('sendMessage', {
            chat_id: chatId,
            text: '👋 Benvenuto in Matrice Orari Bot. Usa il link dall\'app per collegare il tuo profilo.',
          });
        }
      }
    } catch (e) { console.warn('webhook error', e); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{}');
  }

  if (req.url === '/api/telegram/send' && req.method === 'POST') {
    const body = await readBody(req);
    const { code, text } = body;
    if (!code || !text) { res.writeHead(400); return res.end(JSON.stringify({ error: 'missing code/text' })); }
    const links = loadLinks();
    const link = links[code];
    if (!link) { res.writeHead(404); return res.end(JSON.stringify({ error: 'not linked' })); }
    try {
      await tgRequest('sendMessage', { chat_id: link.chatId, text, parse_mode: 'HTML' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true }));
    } catch (e) {
      res.writeHead(500); return res.end(JSON.stringify({ error: e.message }));
    }
  }

  const filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(__dirname, 'public', 'index.html'), (err2, fallback) => {
        if (err2) { res.writeHead(404); return res.end('Not Found'); }
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(fallback);
      });
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
});

// Daily reminder: every minute check if we're at the configured hour (default 20:00)
// and dispatch a request to all linked chats. The actual schedule data is computed
// client-side and pushed via /api/telegram/send by an admin trigger.
// For autonomous reminders, set TG_DAILY_PING=1 to broadcast a "remember to check"
// message at REMINDER_HOUR (default 20).
const REMINDER_HOUR = Number(process.env.REMINDER_HOUR || 20);
let _lastReminderDay = null;
setInterval(async () => {
  if (process.env.TG_DAILY_PING !== '1' || !TG_TOKEN) return;
  const now = new Date();
  const dayKey = now.toISOString().slice(0,10);
  if (now.getHours() === REMINDER_HOUR && _lastReminderDay !== dayKey) {
    _lastReminderDay = dayKey;
    const links = loadLinks();
    for (const [code, link] of Object.entries(links)) {
      try {
        await tgRequest('sendMessage', {
          chat_id: link.chatId,
          text: '⏰ Promemoria: controlla il tuo turno di domani su Matrice Orari.',
        });
      } catch (e) { console.warn('reminder send failed', code, e.message); }
    }
  }
}, 60000);

server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
