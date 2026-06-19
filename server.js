const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 7860;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const TG_BOT_USERNAME = process.env.TELEGRAM_BOT_USERNAME || '';
const LINKS_FILE = '/tmp/tg-links.json';
const SESSIONS_FILE = '/tmp/tg-sessions.json';
const REQUESTS_FILE = '/tmp/tg-requests.json';

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
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return {}; }
}
function saveSessions(obj) {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj)); } catch (e) { console.warn('save sessions failed', e); }
}
function loadRequests() {
  try { return JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8')); } catch { return []; }
}
function saveRequests(arr) {
  try { fs.writeFileSync(REQUESTS_FILE, JSON.stringify(arr)); } catch (e) { console.warn('save requests failed', e); }
}
function getAdminChatId() {
  const links = loadLinks();
  return links['__admin__'] ? links['__admin__'].chatId : null;
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

// ===== TELEGRAM BOT CONVERSATION =====
const ADMIN_TG_PASS = process.env.ADMIN_PASS || '';

async function tgSend(chatId, text, extra) {
  return tgRequest('sendMessage', Object.assign({ chat_id: chatId, text, parse_mode: 'HTML' }, extra || {}));
}
async function tgForwardPhoto(adminChatId, fileId, caption) {
  return tgRequest('sendPhoto', { chat_id: adminChatId, photo: fileId, caption: caption || '', parse_mode: 'HTML' });
}
function mainMenuKeyboard() {
  return {
    reply_markup: {
      keyboard: [
        [{ text: '📋 Richiedi la mia matrice' }],
        [{ text: 'ℹ️ Aiuto' }, { text: '❌ Annulla' }]
      ],
      resize_keyboard: true,
    }
  };
}
function cancelKeyboard() {
  return { reply_markup: { keyboard: [[{ text: '❌ Annulla' }]], resize_keyboard: true } };
}
function removeKeyboard() {
  return { reply_markup: { remove_keyboard: true } };
}

async function handleTelegramUpdate(update) {
  const msg = update.message;
  if (!msg) return;
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const userName = [msg.from.first_name, msg.from.last_name].filter(Boolean).join(' ') || msg.from.username || ('user' + userId);
  const text = (msg.text || '').trim();
  const sessions = loadSessions();
  const sessionKey = String(chatId);
  const session = sessions[sessionKey] || { step: 'idle' };

  // /admin <password> — registra questo chat come admin
  if (text.startsWith('/admin ')) {
    const pass = text.substring(7).trim();
    if (ADMIN_TG_PASS && pass === ADMIN_TG_PASS) {
      const links = loadLinks();
      links['__admin__'] = { chatId, linkedAt: new Date().toISOString(), name: userName };
      saveLinks(links);
      await tgSend(chatId, '✅ Sei registrato come amministratore.\nRiceverai qui tutte le richieste di matrici degli utenti.');
    } else {
      await tgSend(chatId, '❌ Password admin errata.');
    }
    return;
  }

  // /start con codice (collegamento profilo dall'app)
  if (text.startsWith('/start ')) {
    const code = text.substring(7).trim();
    const links = loadLinks();
    links[code] = { chatId, linkedAt: new Date().toISOString(), name: userName };
    saveLinks(links);
    await tgSend(chatId, '✅ <b>Collegato!</b>\nRiceverai ogni sera il tuo turno del giorno dopo.', mainMenuKeyboard());
    return;
  }

  // /start senza codice o /menu
  if (text === '/start' || text === '/menu' || text === 'ℹ️ Aiuto' || text === '/help') {
    await tgSend(chatId,
      '👋 <b>Benvenuto in Matrice Orari Bot</b>\n\n' +
      'Comandi disponibili:\n' +
      '📋 <b>Richiedi la mia matrice</b> — chiedi all\'amministratore di crearti la matrice turni\n' +
      'ℹ️ <b>Aiuto</b> — mostra questo messaggio\n' +
      '❌ <b>Annulla</b> — interrompi una richiesta in corso',
      mainMenuKeyboard()
    );
    return;
  }

  // Annulla
  if (text === '❌ Annulla' || text === '/annulla' || text === '/cancel') {
    delete sessions[sessionKey];
    saveSessions(sessions);
    await tgSend(chatId, '❌ Operazione annullata.', mainMenuKeyboard());
    return;
  }

  // Inizio richiesta
  if (text === '📋 Richiedi la mia matrice' || text === '/richiesta') {
    sessions[sessionKey] = { step: 'nome', data: { telegramName: userName, userId } };
    saveSessions(sessions);
    await tgSend(chatId,
      '📝 <b>Richiesta nuova matrice</b>\n\nQual è il tuo <b>nome e cognome completo</b>?\n(es. Mario Rossi)',
      cancelKeyboard()
    );
    return;
  }

  // State machine
  if (session.step === 'nome' && text) {
    if (text.length < 3) { await tgSend(chatId, '⚠️ Nome troppo corto. Riprova:', cancelKeyboard()); return; }
    session.data.nome = text;
    session.step = 'ruolo';
    sessions[sessionKey] = session; saveSessions(sessions);
    await tgSend(chatId, '👔 Sei <b>Dipendente</b> o <b>Tutor</b>?', {
      reply_markup: { keyboard: [[{ text: 'Dipendente' }, { text: 'Tutor' }], [{ text: '❌ Annulla' }]], resize_keyboard: true }
    });
    return;
  }

  if (session.step === 'ruolo' && text) {
    const r = text.toLowerCase();
    if (r !== 'dipendente' && r !== 'tutor') { await tgSend(chatId, '⚠️ Scegli "Dipendente" o "Tutor":'); return; }
    session.data.ruolo = r;
    session.step = 'team';
    sessions[sessionKey] = session; saveSessions(sessions);
    await tgSend(chatId, '🏷 Qual è il tuo <b>team</b>? (numero da 1 a 9)', cancelKeyboard());
    return;
  }

  if (session.step === 'team' && text) {
    const t = parseInt(text, 10);
    if (!Number.isFinite(t) || t < 1 || t > 9) { await tgSend(chatId, '⚠️ Inserisci un numero da 1 a 9:'); return; }
    session.data.team = t;
    session.step = 'rientro';
    sessions[sessionKey] = session; saveSessions(sessions);
    await tgSend(chatId, '🏢 Qual è la <b>settimana del rientro in sede</b>?\n(es. <i>23-29 marzo 2026</i> oppure <i>nessun rientro</i>)', cancelKeyboard());
    return;
  }

  if (session.step === 'rientro' && text) {
    session.data.rientro = text;
    session.step = 'foto1';
    session.data.photos = [];
    sessions[sessionKey] = session; saveSessions(sessions);
    await tgSend(chatId,
      '📸 Ora invia il <b>primo screenshot</b> con i tuoi orari della <b>settimana scorsa</b>.\n\n⚠️ Importante: deve essere <b>senza cambi</b> di turno.',
      cancelKeyboard()
    );
    return;
  }

  if (session.step === 'foto1') {
    if (!msg.photo || !msg.photo.length) {
      await tgSend(chatId, '⚠️ Invia uno <b>screenshot</b> (foto), non testo:');
      return;
    }
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    session.data.photos.push(fileId);
    session.step = 'foto2';
    sessions[sessionKey] = session; saveSessions(sessions);
    await tgSend(chatId, '✅ Primo screenshot ricevuto.\n\n📸 Ora invia il <b>secondo screenshot</b> con gli orari della <b>settimana corrente</b>.', cancelKeyboard());
    return;
  }

  if (session.step === 'foto2') {
    if (!msg.photo || !msg.photo.length) {
      await tgSend(chatId, '⚠️ Invia uno <b>screenshot</b> (foto), non testo:');
      return;
    }
    const fileId = msg.photo[msg.photo.length - 1].file_id;
    session.data.photos.push(fileId);

    // Salva richiesta
    const requests = loadRequests();
    const requestId = Date.now().toString(36);
    const request = {
      id: requestId,
      createdAt: new Date().toISOString(),
      from: { chatId, userId, telegramName: userName },
      nome: session.data.nome,
      ruolo: session.data.ruolo,
      team: session.data.team,
      rientro: session.data.rientro,
      photos: session.data.photos,
      status: 'pending'
    };
    requests.push(request);
    saveRequests(requests);

    // Conferma all'utente
    delete sessions[sessionKey];
    saveSessions(sessions);
    await tgSend(chatId,
      '✅ <b>Richiesta inviata!</b>\n\n' +
      'Riepilogo:\n' +
      `• Nome: <b>${escapeHtml(request.nome)}</b>\n` +
      `• Ruolo: <b>${request.ruolo}</b>\n` +
      `• Team: <b>${request.team}</b>\n` +
      `• Rientro: <b>${escapeHtml(request.rientro)}</b>\n\n` +
      "L'amministratore ti contatterà appena la matrice sarà pronta. Riceverai poi le notifiche turno quotidiane.",
      mainMenuKeyboard()
    );

    // Inoltra all'admin
    const adminChatId = getAdminChatId();
    if (adminChatId) {
      const summary =
        '📬 <b>Nuova richiesta matrice</b>\n\n' +
        `👤 Telegram: <b>${escapeHtml(userName)}</b> (chat <code>${chatId}</code>)\n` +
        `📝 Nome: <b>${escapeHtml(request.nome)}</b>\n` +
        `👔 Ruolo: <b>${request.ruolo}</b>\n` +
        `🏷 Team: <b>${request.team}</b>\n` +
        `🏢 Rientro: <b>${escapeHtml(request.rientro)}</b>\n` +
        `🆔 Richiesta: <code>${requestId}</code>\n\n` +
        '📸 Screenshot in arrivo...';
      try { await tgSend(adminChatId, summary); } catch (e) { console.warn('forward to admin failed', e.message); }
      for (let i = 0; i < request.photos.length; i++) {
        try { await tgForwardPhoto(adminChatId, request.photos[i], `Settimana ${i+1} di 2 — ${escapeHtml(request.nome)}`); } catch (e) { console.warn('forward photo', i, e.message); }
      }
    } else {
      console.warn('No admin chat registered — request', requestId, 'saved but not forwarded');
    }
    return;
  }

  // Default: messaggio generico
  await tgSend(chatId,
    "Non ho capito. Premi <b>📋 Richiedi la mia matrice</b> per iniziare oppure <b>ℹ️ Aiuto</b>.",
    mainMenuKeyboard()
  );
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
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
    return res.end(JSON.stringify({ enabled: !!key }));
  }

  if (req.url === '/api/gemini-vision' && req.method === 'POST') {
    const key = process.env.GEMINI_KEY || '';
    if (!key) { res.writeHead(503); return res.end(JSON.stringify({ error: 'Gemini key non configurata' })); }
    const body = await readBody(req);
    if (!body.imageBase64 || !body.role) { res.writeHead(400); return res.end(JSON.stringify({ error: 'imageBase64 + role richiesti' })); }
    const prompt = `Sei un OCR specializzato in turni di lavoro. Nell'immagine c'è una settimana lavorativa con date e orari di inizio turno.
Estrai:
1. Le 7 date della settimana (numero del giorno, da 1 a 31)
2. Per ogni giorno, l'orario di inizio turno in formato HH:MM (oppure "RIPOSO" se è giorno libero, o "00:00" se è una colonna lavorativa con orario 0)
Ruolo operatore: ${body.role}.
Rispondi SOLO con JSON valido in questo formato esatto, senza testo aggiuntivo:
{"giorni": [{"data": 15, "inizio": "08:00"}, {"data": 16, "inizio": "RIPOSO"}, ...], "weekLabel": "15-21 Mar 2026"}`;
    const payload = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: body.mimeType || 'image/jpeg', data: body.imageBase64 } }
        ]
      }],
      generationConfig: { temperature: 0.1, responseMimeType: 'application/json' }
    };
    const data = JSON.stringify(payload);
    const apiReq = https.request({
      hostname: 'generativelanguage.googleapis.com',
      path: `/v1beta/models/gemini-2.0-flash:generateContent?key=${key}`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }
    }, apiRes => {
      const chunks = [];
      apiRes.on('data', c => chunks.push(c));
      apiRes.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try {
          const json = JSON.parse(text);
          const out = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(out || JSON.stringify({ error: 'no response' }));
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: 'parse error', raw: text }));
        }
      });
    });
    apiReq.on('error', e => { res.writeHead(500); res.end(JSON.stringify({ error: e.message })); });
    apiReq.write(data);
    apiReq.end();
    return;
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
      await handleTelegramUpdate(update);
    } catch (e) { console.warn('webhook error', e); }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end('{}');
  }

  if (req.url === '/api/telegram/requests' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify(loadRequests()));
  }

  // Endpoint admin: update richiesta + notifica utente via Telegram
  if (req.url === '/api/telegram/requests/action' && req.method === 'POST') {
    const body = await readBody(req);
    const adminPass = process.env.ADMIN_PASS || '';
    if (!body.adminPass || body.adminPass !== adminPass) {
      res.writeHead(401); return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    const { requestId, action, message } = body;
    if (!requestId || !action) { res.writeHead(400); return res.end(JSON.stringify({ error: 'requestId+action richiesti' })); }
    const requests = loadRequests();
    const idx = requests.findIndex(r => r.id === requestId);
    if (idx === -1) { res.writeHead(404); return res.end(JSON.stringify({ error: 'Richiesta non trovata' })); }
    const r = requests[idx];
    const chatId = r.from && r.from.chatId;
    let userMessage = '';
    if (action === 'approve') {
      r.status = 'approved';
      userMessage = '✅ <b>Matrice creata!</b>\n\nLa tua matrice turni è ora disponibile. ' +
        (body.link ? '\n\n🔗 Link permanente:\n' + body.link : 'Aprila dall\'app o usa il menu del bot.') +
        '\n\nDa ora riceverai ogni sera il turno del giorno dopo.';
    } else if (action === 'reject') {
      r.status = 'rejected';
      userMessage = '❌ <b>Richiesta non accolta</b>\n\n' + (message || 'L\'amministratore non può creare la matrice al momento.') + '\n\nPuoi inviare una nuova richiesta in qualsiasi momento.';
    } else if (action === 'needs_info') {
      r.status = 'needs_info';
      userMessage = '📝 <b>Servono ulteriori informazioni</b>\n\n' + (message || 'L\'amministratore richiede dettagli aggiuntivi.') + '\n\nRispondi qui sotto oppure premi 📋 Richiedi la mia matrice per ricominciare.';
    } else if (action === 'message') {
      // Solo messaggio custom, non cambia stato
      userMessage = message || '';
    } else if (action === 'delete') {
      requests.splice(idx, 1);
      saveRequests(requests);
      res.writeHead(200); return res.end(JSON.stringify({ ok: true, deleted: true }));
    } else {
      res.writeHead(400); return res.end(JSON.stringify({ error: 'action non valida' }));
    }
    r.updatedAt = new Date().toISOString();
    saveRequests(requests);
    // Notifica utente via Telegram
    if (chatId && userMessage) {
      try { await tgSend(chatId, userMessage); }
      catch (e) { console.warn('notify user failed', e.message); }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, request: r }));
  }

  // Proxy file Telegram per visualizzare gli screenshot nell'app
  const fileMatch = req.url && req.url.match(/^\/api\/telegram\/file\/([^?]+)/);
  if (fileMatch && req.method === 'GET' && TG_TOKEN) {
    const fileId = decodeURIComponent(fileMatch[1]);
    try {
      const info = await tgRequest('getFile', { file_id: fileId });
      if (!info.ok || !info.result || !info.result.file_path) {
        res.writeHead(404); return res.end('File not found');
      }
      const filePath = info.result.file_path;
      const fileUrl = `https://api.telegram.org/file/bot${TG_TOKEN}/${filePath}`;
      https.get(fileUrl, fileRes => {
        if (fileRes.statusCode !== 200) {
          res.writeHead(fileRes.statusCode); return res.end('Upstream error');
        }
        const ext = path.extname(filePath).toLowerCase();
        const contentType = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg';
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
        fileRes.pipe(res);
      }).on('error', e => { res.writeHead(500); res.end('Fetch error: ' + e.message); });
      return;
    } catch (e) {
      res.writeHead(500); return res.end('Error: ' + e.message);
    }
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
