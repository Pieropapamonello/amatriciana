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

// ===== FIRESTORE PERSISTENCE =====
// Render free tier ha filesystem effimero. Persistiamo richieste e links su Firestore
// usando le stesse credenziali Firebase del client.
const FB_API_KEY = process.env.FB_API_KEY || 'AIzaSyBEeNgqLl8hLhxSMvZxHXoxvw9TDYlaOiw';
const FB_PROJECT_ID = process.env.FB_PROJECT_ID || 'amatriciana-199a1';
let _idToken = null;
let _idTokenExp = 0;

function httpsPost(hostname, urlPath, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const req = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) }, headers || {})
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); }
        catch { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}
function httpsRequestRaw(hostname, urlPath, method, payload, headers) {
  return new Promise((resolve, reject) => {
    const data = payload ? (typeof payload === 'string' ? payload : JSON.stringify(payload)) : null;
    const opts = { hostname, path: urlPath, method, headers: Object.assign({}, headers || {}) };
    if (data) opts.headers['Content-Length'] = Buffer.byteLength(data);
    if (data && !opts.headers['Content-Type']) opts.headers['Content-Type'] = 'application/json';
    const req = https.request(opts, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString();
        try { resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null }); }
        catch { resolve({ status: res.statusCode, body: text }); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function getFirestoreToken() {
  const email = process.env.FB_EMAIL || '';
  const password = process.env.FB_PASS || '';
  if (!email || !password) throw new Error('FB credenziali mancanti');
  if (_idToken && Date.now() < _idTokenExp - 60000) return _idToken;
  const r = await httpsPost('identitytoolkit.googleapis.com',
    `/v1/accounts:signInWithPassword?key=${FB_API_KEY}`,
    { email, password, returnSecureToken: true });
  if (r.status !== 200 || !r.body || !r.body.idToken) {
    throw new Error('Firebase auth failed: ' + JSON.stringify(r.body));
  }
  _idToken = r.body.idToken;
  _idTokenExp = Date.now() + (Number(r.body.expiresIn) * 1000);
  return _idToken;
}

// Firestore REST: GET doc → ritorna fields parsed, o null se non esiste
async function fsGet(docPath) {
  try {
    const token = await getFirestoreToken();
    const r = await httpsRequestRaw('firestore.googleapis.com',
      `/v1/projects/${FB_PROJECT_ID}/databases/(default)/documents/${docPath}`,
      'GET', null, { Authorization: 'Bearer ' + token });
    if (r.status === 404) return null;
    if (r.status !== 200) throw new Error('fsGet ' + r.status);
    return fsParseDoc(r.body);
  } catch (e) { console.warn('fsGet fail', docPath, e.message); return null; }
}
// Firestore REST: SET doc (overwrite)
async function fsSet(docPath, data) {
  try {
    const token = await getFirestoreToken();
    const body = { fields: fsEncode(data) };
    const r = await httpsRequestRaw('firestore.googleapis.com',
      `/v1/projects/${FB_PROJECT_ID}/databases/(default)/documents/${docPath}`,
      'PATCH', body, { Authorization: 'Bearer ' + token });
    if (r.status !== 200) console.warn('fsSet status', r.status, r.body);
    return r.status === 200;
  } catch (e) { console.warn('fsSet fail', docPath, e.message); return false; }
}
// Firestore type encoding
function fsEncode(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(fsEncode) } };
  if (typeof v === 'object') {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = fsEncode(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}
function fsDecode(v) {
  if (!v) return null;
  if ('nullValue' in v) return null;
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fsDecode);
  if ('mapValue' in v) {
    const out = {};
    for (const k of Object.keys(v.mapValue.fields || {})) out[k] = fsDecode(v.mapValue.fields[k]);
    return out;
  }
  return null;
}
function fsParseDoc(doc) {
  if (!doc || !doc.fields) return null;
  const out = {};
  for (const k of Object.keys(doc.fields)) out[k] = fsDecode(doc.fields[k]);
  return out;
}

// Cache in memoria sincronizzata con Firestore
let _cachedLinks = null;
let _cachedRequests = null;
let _firestoreReady = false;

async function fsBoot() {
  try {
    const linksDoc = await fsGet('app_state/tg_links');
    if (linksDoc && linksDoc.data) _cachedLinks = linksDoc.data;
    else _cachedLinks = {};
    const reqDoc = await fsGet('app_state/tg_requests');
    if (reqDoc && Array.isArray(reqDoc.list)) _cachedRequests = reqDoc.list;
    else _cachedRequests = [];
    _firestoreReady = true;
    console.log('Firestore loaded: links=' + Object.keys(_cachedLinks).length + ' requests=' + _cachedRequests.length);
  } catch (e) {
    console.warn('Firestore boot failed, fallback to /tmp', e.message);
    _cachedLinks = (function(){ try { return JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); } catch { return {}; } })();
    _cachedRequests = (function(){ try { return JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8')); } catch { return []; } })();
  }
}
fsBoot();

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
  if (_cachedLinks !== null) return _cachedLinks;
  try { _cachedLinks = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8')); } catch { _cachedLinks = {}; }
  return _cachedLinks;
}
function saveLinks(obj) {
  _cachedLinks = obj;
  try { fs.writeFileSync(LINKS_FILE, JSON.stringify(obj)); } catch (e) { console.warn('save links failed', e); }
  // Persist to Firestore in background
  fsSet('app_state/tg_links', { data: obj, updatedAt: new Date().toISOString() }).catch(()=>{});
}
function loadSessions() {
  try { return JSON.parse(fs.readFileSync(SESSIONS_FILE, 'utf8')); } catch { return {}; }
}
function saveSessions(obj) {
  try { fs.writeFileSync(SESSIONS_FILE, JSON.stringify(obj)); } catch (e) { console.warn('save sessions failed', e); }
}
function loadRequests() {
  if (_cachedRequests !== null) return _cachedRequests;
  try { _cachedRequests = JSON.parse(fs.readFileSync(REQUESTS_FILE, 'utf8')); } catch { _cachedRequests = []; }
  return _cachedRequests;
}
function saveRequests(arr) {
  _cachedRequests = arr;
  try { fs.writeFileSync(REQUESTS_FILE, JSON.stringify(arr)); } catch (e) { console.warn('save requests failed', e); }
  // Persist to Firestore in background
  fsSet('app_state/tg_requests', { list: arr, updatedAt: new Date().toISOString() }).catch(()=>{});
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
function isAdminChat(chatId) {
  const links = loadLinks();
  return !!(links['__admin__'] && links['__admin__'].chatId === chatId);
}
function mainMenuKeyboard(chatId) {
  const isAdmin = chatId && isAdminChat(chatId);
  const rows = isAdmin
    ? [
        [{ text: '📬 Richieste' }, { text: '👥 Colleghi' }],
        [{ text: '📅 Oggi' }, { text: '📆 Domani' }],
        [{ text: '📊 Statistiche' }, { text: '📢 Broadcast' }],
        [{ text: 'ℹ️ Aiuto' }, { text: '❌ Annulla' }]
      ]
    : [
        [{ text: '📋 Richiedi la mia matrice' }],
        [{ text: 'ℹ️ Aiuto' }, { text: '❌ Annulla' }]
      ];
  return { reply_markup: { keyboard: rows, resize_keyboard: true } };
}
function cancelKeyboard() {
  return { reply_markup: { keyboard: [[{ text: '❌ Annulla' }]], resize_keyboard: true } };
}
function removeKeyboard() {
  return { reply_markup: { remove_keyboard: true } };
}

// ===== MATRIX CALCULATION (port da index.html, solo essenziali) =====
const M_DAYS = ['Lun','Mar','Mer','Gio','Ven','Sab','Dom'];
const M_DIPENDENTE_PATTERN = [
  { startTime: '14:00', restDays: ['Lun','Dom'] },
  { startTime: '06:00', restDays: ['Mer','Sab'] },
  { startTime: '13:30', restDays: ['Ven','Sab'] },
  { startTime: '15:30', restDays: ['Mar','Dom'] },
  { startTime: '09:30', restDays: ['Gio','Dom'] },
  { startTime: '12:00', restDays: ['Sab','Dom'] },
  { startTime: '14:30', restDays: ['Lun','Dom'] },
  { startTime: '08:00', restDays: ['Mer','Sab'] },
  { startTime: '14:00', restDays: ['Ven','Sab'] },
  { startTime: '16:00', restDays: ['Mar','Dom'] },
  { startTime: '09:30', restDays: ['Gio','Dom'] },
  { startTime: '12:30', restDays: ['Sab','Dom'] },
  { startTime: '15:00', restDays: ['Lun','Dom'] },
  { startTime: '08:30', restDays: ['Mer','Sab'] },
  { startTime: '14:30', restDays: ['Ven','Sab'] },
  { startTime: '18:00', restDays: ['Mar','Dom'] },
  { startTime: '10:00', restDays: ['Gio','Dom'] },
  { startTime: '13:00', restDays: ['Sab','Dom'] }
];
const M_DIP_OVR = {
  12: { Sab: '18:00' }, 13: { Dom: '10:00' }, 14: { Dom: '18:00' }, 15: { Sab: '12:00' },
  16: { Sab: '09:00' }, 0:  { Sab: '14:00' }, 1:  { Dom: '06:00' }, 2:  { Dom: '14:00' },
  3:  { Sab: '10:00' }, 4:  { Sab: '06:00' }, 6:  { Sab: '16:00' }, 7:  { Dom: '09:00' },
  8:  { Dom: '16:00' }, 9:  { Sab: '11:00' }, 10: { Sab: '08:00' }
};
const M_TUTOR_PATTERN = [
  { startTime: '12:00', restDays: ['Mer','Sab'], overrides: { Dom: '12:00' } },
  { startTime: '06:00', restDays: ['Mar','Sab'], overrides: { Dom: '06:00' } },
  { startTime: '18:00', restDays: ['Mer','Dom'], overrides: { Sab: '18:00' } },
  { startTime: '15:00', restDays: ['Sab','Dom'] },
  { startTime: '06:00', restDays: ['Gio','Dom'], overrides: { Sab: '06:00' } },
  { startTime: '18:00', restDays: ['Lun','Sab'], overrides: { Dom: '18:00' } },
  { startTime: '12:00', restDays: ['Mar','Dom'], overrides: { Sab: '12:00' } },
  { startTime: '08:00', restDays: ['Sab','Dom'] },
  { startTime: '18:00', restDays: ['Mar','Sab'], overrides: { Dom: '18:00' } },
  { startTime: '12:00', restDays: ['Lun','Sab'], overrides: { Dom: '12:00' } },
  { startTime: '06:00', restDays: ['Mer','Dom'], overrides: { Sab: '06:00' } },
  { startTime: '11:00', restDays: ['Sab','Dom'] },
  { startTime: '12:00', restDays: ['Gio','Dom'], overrides: { Sab: '12:00' } },
  { startTime: '06:00', restDays: ['Lun','Sab'], overrides: { Dom: '06:00' } },
  { startTime: '18:00', restDays: ['Gio','Dom'], overrides: { Sab: '18:00' } }
];
let M_TEAM_RIENTRO_ANCHORS = { 3:'2026-03-02', 6:'2026-02-23', 7:'2026-02-16', 8:'2026-02-23', 9:'2026-03-02' };
function parseISO(iso){ const [y,m,d] = String(iso).split('-').map(Number); return new Date(y, (m||1)-1, d||1); }
function pad2(n){ return String(n).padStart(2,'0'); }
function isoStr(d){ return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate()); }
function addDays(d, n){ const x = new Date(d.getTime()); x.setDate(x.getDate()+n); return x; }
function timeToMin(t){ const [h,m] = String(t).split(':').map(Number); return (h||0)*60+(m||0); }
function minToTime(m){ m = ((m%1440)+1440)%1440; return pad2(Math.floor(m/60))+':'+pad2(m%60); }
function computeStartEnd(rawStart, durMin){
  if(!durMin) return { start: rawStart, end: '' };
  const startStr = String(rawStart);
  if(startStr === '18:00') return { start: minToTime(1440 - durMin), end: '00:00' };
  const end = minToTime(timeToMin(startStr) + durMin);
  if(timeToMin(end) < timeToMin(startStr)) return { start: startStr, end: '00:00' };
  return { start: startStr, end };
}
function isRientroWeek(weekMonday, team){
  const anchorISO = M_TEAM_RIENTRO_ANCHORS[team];
  if(!anchorISO || !team) return false;
  const anchor = parseISO(anchorISO);
  const diffDays = Math.round((weekMonday.getTime() - anchor.getTime()) / 86400000);
  return (((diffDays % 42) + 42) % 42) === 0;
}
function easterDate(year){
  const a=year%19, b=Math.floor(year/100), c=year%100, d=Math.floor(b/4), e=b%4;
  const f=Math.floor((b+8)/25), g=Math.floor((b-f+1)/3);
  const h=(19*a+b-d-g+15)%30, i=Math.floor(c/4), k=c%4;
  const l=(32+2*e+2*i-h-k)%7, m=Math.floor((a+11*h+22*l)/451);
  const month=Math.floor((h+l-7*m+114)/31), day=((h+l-7*m+114)%31)+1;
  return new Date(year, month-1, day);
}
function buildHolidayMap(year){
  const map = new Map();
  map.set(year+'-01-01','Capodanno'); map.set(year+'-01-06','Epifania');
  map.set(year+'-04-25','Liberazione'); map.set(year+'-05-01','Festa del Lavoro');
  map.set(year+'-06-02','Festa della Repubblica'); map.set(year+'-08-15','Ferragosto');
  map.set(year+'-11-01','Ognissanti'); map.set(year+'-12-08','Immacolata');
  map.set(year+'-12-25','Natale'); map.set(year+'-12-26','Santo Stefano');
  map.set(year+'-05-10','San Cataldo');
  map.set(isoStr(addDays(easterDate(year),1)),'Pasquetta');
  return map;
}
// Equivalente di getScheduleOnDate del client (O(1) calc)
function getScheduleOnDate(cfg, targetISO){
  if(!cfg || !cfg.startWeekISO || cfg.anchorPatternIndex === null || cfg.anchorPatternIndex === undefined) return null;
  const pattern = cfg.role === 'tutor' ? M_TUTOR_PATTERN : M_DIPENDENTE_PATTERN;
  const specialOvr = cfg.role === 'tutor' ? {} : M_DIP_OVR;
  const start = parseISO(cfg.startWeekISO);
  const target = parseISO(targetISO);
  const diffMs = target.getTime() - start.getTime();
  if(diffMs < 0) return null;
  const daysDiff = Math.round(diffMs / 86400000);
  const weekIdx = Math.floor(daysDiff / 7);
  const dayIdx = daysDiff % 7;
  const dayName = M_DAYS[dayIdx];
  const pIdx = ((cfg.anchorPatternIndex + weekIdx) % pattern.length + pattern.length) % pattern.length;
  const pat = pattern[pIdx];
  const isRest = pat.restDays.includes(dayName);
  const rawStart = ((pat.overrides||{})[dayName]) || ((specialOvr[pIdx]||{})[dayName]) || pat.startTime;
  const se = computeStartEnd(rawStart, cfg.durationMinutes || 0);
  const hMap = buildHolidayMap(target.getFullYear());
  const holidayName = hMap.get(targetISO) || null;
  const weekStart = addDays(target, -dayIdx);
  const isRientro = isRientroWeek(weekStart, cfg.team || null) && dayIdx < 5;
  return { dayName, isRest, start: se.start, end: se.end, isHoliday: !!holidayName, holidayName, isRientro };
}

// Carica colleghi dal Firestore (userdata/main)
let _cachedTeam = null;
let _cachedTeamAt = 0;
async function loadTeam(){
  if(_cachedTeam && Date.now() - _cachedTeamAt < 60000) return _cachedTeam;
  const doc = await fsGet('userdata/main');
  if(doc){
    _cachedTeam = Array.isArray(doc.colleghi) ? doc.colleghi : [];
    if(doc.rientriAnchors && typeof doc.rientriAnchors === 'object'){
      Object.entries(doc.rientriAnchors).forEach(([k,v])=>{ if(v) M_TEAM_RIENTRO_ANCHORS[Number(k)] = v; });
    }
    _cachedTeamAt = Date.now();
  } else _cachedTeam = [];
  return _cachedTeam;
}
function formatDayShift(day) {
  if(!day) return '—';
  if(day.isRest) return '🔴 LIBERO' + (day.holidayName ? ' · ' + day.holidayName : '');
  let s = day.start + ' – ' + day.end;
  if(day.isHoliday) s += ' · ' + day.holidayName;
  if(day.isRientro) s += ' · 🏢 Rientro';
  return s;
}

async function handleTelegramUpdate(update) {
  // === CALLBACK QUERIES (inline keyboard) ===
  if (update.callback_query) {
    const cq = update.callback_query;
    const data = cq.data || '';
    const chatIdCb = cq.message && cq.message.chat ? cq.message.chat.id : null;
    if (!chatIdCb) return;
    // Azioni admin su richieste via inline keyboard
    if (data.startsWith('req_approve:') || data.startsWith('req_info:') || data.startsWith('req_reject:')) {
      if (!isAdminChat(chatIdCb)) {
        await tgRequest('answerCallbackQuery', { callback_query_id: cq.id, text: '⛔ Solo admin', show_alert: true });
        return;
      }
      const [act, reqId] = data.split(':');
      const requests = loadRequests();
      const r = requests.find(x => x.id === reqId);
      if (!r) {
        await tgRequest('answerCallbackQuery', { callback_query_id: cq.id, text: 'Richiesta non trovata', show_alert: true });
        return;
      }
      const userChatId = r.from && r.from.chatId;
      if (act === 'req_approve') {
        // Quick approve: nessun link auto. Suggerisce all'admin di usare l'app per link
        r.status = 'approved'; r.awaitingReply = false; r.updatedAt = new Date().toISOString();
        saveRequests(requests);
        if (userChatId) {
          await tgSend(userChatId,
            '✅ <b>Matrice creata!</b>\n\nLa tua matrice turni è pronta. L\'amministratore ti invierà a breve il link.'
          );
        }
        await tgRequest('answerCallbackQuery', { callback_query_id: cq.id, text: '✅ Approvata, manda il link dall\'app' });
        await tgRequest('editMessageReplyMarkup', { chat_id: chatIdCb, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [[{ text: '✅ APPROVATA', callback_data: 'noop' }]] } });
      } else if (act === 'req_reject') {
        r.status = 'rejected'; r.awaitingReply = false; r.updatedAt = new Date().toISOString();
        saveRequests(requests);
        if (userChatId) {
          await tgSend(userChatId, '❌ <b>Richiesta non accolta</b>\n\nL\'amministratore non può creare la matrice al momento. Puoi inviare una nuova richiesta in qualsiasi momento.');
        }
        await tgRequest('answerCallbackQuery', { callback_query_id: cq.id, text: '❌ Rifiutata' });
        await tgRequest('editMessageReplyMarkup', { chat_id: chatIdCb, message_id: cq.message.message_id, reply_markup: { inline_keyboard: [[{ text: '❌ RIFIUTATA', callback_data: 'noop' }]] } });
      } else if (act === 'req_info') {
        // Avvia conversazione admin per scrivere messaggio
        const sessions = loadSessions();
        sessions[String(chatIdCb)] = { step: 'admin_info_msg', data: { reqId } };
        saveSessions(sessions);
        await tgRequest('answerCallbackQuery', { callback_query_id: cq.id, text: 'Scrivi il messaggio' });
        await tgSend(chatIdCb,
          `❓ <b>Scrivi cosa serve a ${escapeHtml(r.nome)}:</b>\n\nIl tuo prossimo messaggio sarà inoltrato come richiesta info.\nPremi ❌ Annulla per fermarti.`,
          cancelKeyboard()
        );
      }
      return;
    }
    if (data === 'noop') { await tgRequest('answerCallbackQuery', { callback_query_id: cq.id }); return; }

    if (data === 'notif_on' || data === 'notif_off') {
      const enabled = data === 'notif_on';
      const links = loadLinks();
      const k = String(chatIdCb);
      if (!links[k]) links[k] = { chatId: chatIdCb, linkedAt: new Date().toISOString(), name: cq.from.first_name || '' };
      links[k].notificationsEnabled = enabled;
      saveLinks(links);
      // Risposta callback (toast nel client TG)
      try {
        await tgRequest('answerCallbackQuery', {
          callback_query_id: cq.id,
          text: enabled ? '✅ Notifiche attivate!' : '🔕 Notifiche disattivate',
          show_alert: false
        });
      } catch {}
      // Edita il messaggio originale per confermare
      try {
        await tgRequest('editMessageText', {
          chat_id: chatIdCb,
          message_id: cq.message.message_id,
          parse_mode: 'HTML',
          text: enabled
            ? '🔔 <b>Notifiche attive!</b>\n\nOgni sera dopo le 18:00 riceverai un messaggio col turno del giorno dopo.\n\nPuoi disattivarle quando vuoi con /notifiche.'
            : '🔕 <b>Notifiche disattivate.</b>\n\nPuoi riattivarle in qualsiasi momento con /notifiche.'
        });
      } catch {}
    }
    return;
  }

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
      const pending = loadRequests().filter(r => r.status === 'pending').length;
      await tgSend(chatId,
        '✅ <b>Sei registrato come amministratore.</b>\n\n' +
        '🚨 Ti arriverà una notifica qui per ogni nuova richiesta di matrice.\n' +
        '📱 Puoi gestire tutte le richieste direttamente dall\'app admin.\n\n' +
        (pending > 0 ? `📬 Hai <b>${pending}</b> richieste in attesa.` : '✨ Nessuna richiesta pendente al momento.')
      );
    } else {
      await tgSend(chatId, '❌ Password admin errata.');
    }
    return;
  }

  // /status — verifica registrazione
  if (text === '/status' || text === '/stato') {
    const links = loadLinks();
    const isAdmin = links['__admin__'] && links['__admin__'].chatId === chatId;
    const myEntry = links[String(chatId)];
    const notif = myEntry && myEntry.notificationsEnabled === true ? '🔔 Attive' : '🔕 Disattive';
    const pending = isAdmin ? loadRequests().filter(r => r.status === 'pending').length : null;
    const total = isAdmin ? loadRequests().length : null;
    await tgSend(chatId,
      '📊 <b>Il tuo stato</b>\n\n' +
      `👤 Account: <b>${escapeHtml(userName)}</b>\n` +
      `🆔 Chat ID: <code>${chatId}</code>\n` +
      `${isAdmin ? '👑 <b>Amministratore registrato</b>' : '👤 Utente normale'}\n` +
      `🔔 Notifiche turno: <b>${notif}</b>\n` +
      (isAdmin ? `\n📬 Richieste pending: <b>${pending}</b> / ${total} totali\n` : '')
    );
    return;
  }

  // /start con codice (collegamento profilo dall'app)
  if (text.startsWith('/start ')) {
    const code = text.substring(7).trim();
    const links = loadLinks();
    links[code] = { chatId, linkedAt: new Date().toISOString(), name: userName };
    saveLinks(links);
    await tgSend(chatId, '✅ <b>Collegato!</b>\nRiceverai ogni sera il tuo turno del giorno dopo.', mainMenuKeyboard(chatId));
    return;
  }

  // /start senza codice o /menu
  if (text === '/start' || text === '/menu' || text === 'ℹ️ Aiuto' || text === '/help') {
    const isAdmin = isAdminChat(chatId);
    let helpText = '👋 <b>Benvenuto in Matrice Orari Bot</b>\n\n';
    if (isAdmin) {
      helpText += '👑 <b>Sei amministratore</b>\n\n' +
        '<b>Comandi admin:</b>\n' +
        '📬 /richieste — richieste matrici pending con azioni rapide\n' +
        '👥 /colleghi — elenco completo team\n' +
        '📅 /oggi — chi è in turno oggi\n' +
        '📆 /domani — chi è in turno domani\n' +
        '📊 /stats — statistiche team e bot\n' +
        '📢 /broadcast — messaggio a tutti gli utenti\n\n' +
        '<b>Comandi generali:</b>\n' +
        '🔔 /notifiche — gestisci notifiche turno\n' +
        '📊 /status — il tuo stato\n' +
        'ℹ️ /help — questo messaggio';
    } else {
      helpText += 'Comandi disponibili:\n' +
        '📋 <b>Richiedi la mia matrice</b> — chiedi all\'amministratore di crearti la matrice turni\n' +
        '🔔 /notifiche — attiva o disattiva le notifiche serali\n' +
        '📊 /status — il tuo stato\n' +
        'ℹ️ <b>Aiuto</b> — mostra questo messaggio\n' +
        '❌ <b>Annulla</b> — interrompi una richiesta in corso';
    }
    await tgSend(chatId, helpText, mainMenuKeyboard(chatId));
    return;
  }

  // ===== COMANDI ADMIN (solo se autenticato) =====
  if (isAdminChat(chatId)) {
    // /richieste o "📬 Richieste"
    if (text === '/richieste' || text === '📬 Richieste') {
      const reqs = loadRequests();
      const pending = reqs.filter(r => r.status === 'pending');
      if (!pending.length) {
        await tgSend(chatId, '✨ <b>Nessuna richiesta in attesa.</b>\n\nTotale richieste storiche: ' + reqs.length, mainMenuKeyboard(chatId));
        return;
      }
      await tgSend(chatId, `📬 <b>${pending.length} richieste in attesa</b>\n\nClicca su una per gestirla:`);
      for (const r of pending.slice(0, 10)) {
        const dt = new Date(r.createdAt).toLocaleDateString('it-IT', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
        const txt = `📝 <b>${escapeHtml(r.nome)}</b>\n` +
          `👔 ${r.ruolo === 'tutor' ? 'Tutor' : 'Dipendente'} · Team ${r.team}\n` +
          `🏢 ${escapeHtml(r.rientro)}\n` +
          `📅 ${dt}\n` +
          `🆔 <code>${r.id}</code>`;
        await tgRequest('sendMessage', {
          chat_id: chatId, text: txt, parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[
            { text: '✅ Approva', callback_data: 'req_approve:' + r.id },
            { text: '❓ Info', callback_data: 'req_info:' + r.id },
            { text: '❌ Rifiuta', callback_data: 'req_reject:' + r.id }
          ], [
            { text: '📱 Apri nell\'app', url: (process.env.APP_URL || 'https://amatriciana.onrender.com') + '/?request=' + r.id }
          ]] }
        });
      }
      if (pending.length > 10) await tgSend(chatId, `(Mostrate prime 10 di ${pending.length})`);
      return;
    }

    // /colleghi o "👥 Colleghi"
    if (text === '/colleghi' || text === '👥 Colleghi') {
      const team = await loadTeam();
      if (!team.length) {
        await tgSend(chatId, '⚠️ Nessun collega nel database.', mainMenuKeyboard(chatId));
        return;
      }
      const byTeam = {};
      team.forEach(c => {
        const key = `${c.role === 'tutor' ? 'Tutor' : 'Dipendente'} · Team ${c.team || '—'}`;
        if (!byTeam[key]) byTeam[key] = [];
        byTeam[key].push(c);
      });
      let out = `👥 <b>${team.length} colleghi nel team</b>\n\n`;
      Object.keys(byTeam).sort().forEach(k => {
        out += `<b>${escapeHtml(k)}</b> (${byTeam[k].length})\n`;
        byTeam[k].forEach(c => {
          const ok = c.startWeekISO && c.anchorPatternIndex !== null && c.anchorPatternIndex !== undefined;
          out += `  ${ok ? '✓' : '⚠️'} ${escapeHtml(c.name)} ${c.durationKey ? '(' + c.durationKey + ')' : ''}\n`;
        });
        out += '\n';
      });
      // Telegram limita testo a ~4096 char, splitta se necessario
      while (out.length > 4000) {
        await tgSend(chatId, out.substring(0, 4000));
        out = out.substring(4000);
      }
      if (out) await tgSend(chatId, out, mainMenuKeyboard(chatId));
      return;
    }

    // /oggi o "📅 Oggi" — chi è in turno oggi
    if (text === '/oggi' || text === '📅 Oggi' || text === '/domani' || text === '📆 Domani') {
      const isDomani = text.includes('omani');
      const target = addDays(new Date(), isDomani ? 1 : 0);
      const targetISO = isoStr(target);
      const dayNames = ['Domenica','Lunedì','Martedì','Mercoledì','Giovedì','Venerdì','Sabato'];
      const team = await loadTeam();
      const rows = [];
      team.forEach(c => {
        if (!c.startWeekISO || c.anchorPatternIndex === null || c.anchorPatternIndex === undefined) return;
        const day = getScheduleOnDate(c, targetISO);
        if (!day) return;
        rows.push({ c, day });
      });
      if (!rows.length) {
        await tgSend(chatId, `📅 <b>${dayNames[target.getDay()]} ${target.getDate()}/${target.getMonth()+1}</b>\n\n⚠️ Nessun collega configurato.`, mainMenuKeyboard(chatId));
        return;
      }
      // Raggruppa per orario
      const byShift = {};
      rows.forEach(({c, day}) => {
        const key = day.isRest ? '🔴 RIPOSO' : formatDayShift(day);
        if (!byShift[key]) byShift[key] = [];
        byShift[key].push(c);
      });
      let out = `📅 <b>${dayNames[target.getDay()]} ${target.getDate()}/${target.getMonth()+1}</b>\n`;
      out += isDomani ? '(domani)\n\n' : '(oggi)\n\n';
      Object.keys(byShift).sort((a,b) => {
        // Riposi in fondo
        if (a.startsWith('🔴')) return 1;
        if (b.startsWith('🔴')) return -1;
        return a.localeCompare(b);
      }).forEach(shift => {
        out += `<b>${shift}</b>\n`;
        byShift[shift].forEach(c => {
          out += `  • ${escapeHtml(c.name)} <i>(T${c.team || '—'})</i>\n`;
        });
        out += '\n';
      });
      while (out.length > 4000) {
        await tgSend(chatId, out.substring(0, 4000));
        out = out.substring(4000);
      }
      if (out) await tgSend(chatId, out, mainMenuKeyboard(chatId));
      return;
    }

    // /stats o "📊 Statistiche"
    if (text === '/stats' || text === '📊 Statistiche' || text === '/statistiche') {
      const team = await loadTeam();
      const reqs = loadRequests();
      const links = loadLinks();
      const linkedUsers = Object.keys(links).filter(k => k !== '__admin__' && links[k].chatId).length;
      const notifEnabled = Object.values(links).filter(l => l.notificationsEnabled === true).length;
      const configured = team.filter(c => c.startWeekISO && c.anchorPatternIndex !== null && c.anchorPatternIndex !== undefined).length;
      const tutorN = team.filter(c => c.role === 'tutor').length;
      const dipN = team.filter(c => c.role !== 'tutor').length;
      const byTeam = {};
      team.forEach(c => { byTeam[c.team || 'N/A'] = (byTeam[c.team || 'N/A'] || 0) + 1; });
      const out = '📊 <b>Statistiche</b>\n\n' +
        '👥 <b>Team:</b>\n' +
        `  • Totale colleghi: <b>${team.length}</b>\n` +
        `  • Configurati: <b>${configured}</b> / ${team.length}\n` +
        `  • Dipendenti: <b>${dipN}</b> · Tutor: <b>${tutorN}</b>\n\n` +
        '🏷 <b>Per team:</b>\n' +
        Object.keys(byTeam).sort().map(t => `  • Team ${t}: <b>${byTeam[t]}</b>`).join('\n') + '\n\n' +
        '📬 <b>Richieste:</b>\n' +
        `  • Totali: <b>${reqs.length}</b>\n` +
        `  • Pending: <b>${reqs.filter(r => r.status==='pending').length}</b>\n` +
        `  • Approvate: <b>${reqs.filter(r => r.status==='approved').length}</b>\n` +
        `  • Rifiutate: <b>${reqs.filter(r => r.status==='rejected').length}</b>\n\n` +
        '🤖 <b>Bot:</b>\n' +
        `  • Utenti collegati: <b>${linkedUsers}</b>\n` +
        `  • Con notifiche attive: <b>${notifEnabled}</b>`;
      await tgSend(chatId, out, mainMenuKeyboard(chatId));
      return;
    }

    // /broadcast o "📢 Broadcast" — inizia un broadcast a tutti
    if (text === '/broadcast' || text === '📢 Broadcast') {
      sessions[sessionKey] = { step: 'broadcast_msg' };
      saveSessions(sessions);
      const links = loadLinks();
      const recipients = Object.keys(links).filter(k => k !== '__admin__').length;
      await tgSend(chatId,
        `📢 <b>Broadcast a ${recipients} utenti</b>\n\n` +
        'Scrivi il messaggio che vuoi inviare a tutti i colleghi collegati al bot.\n' +
        '(Solo testo, no foto. Premi ❌ Annulla per fermare.)',
        cancelKeyboard()
      );
      return;
    }

    // Admin invia messaggio info su richiesta
    if (session.step === 'admin_info_msg' && text) {
      const reqId = session.data && session.data.reqId;
      const requests = loadRequests();
      const r = requests.find(x => x.id === reqId);
      if (!r) {
        await tgSend(chatId, '⚠️ Richiesta non più trovata.', mainMenuKeyboard(chatId));
        delete sessions[sessionKey]; saveSessions(sessions);
        return;
      }
      r.status = 'needs_info'; r.awaitingReply = true; r.updatedAt = new Date().toISOString();
      saveRequests(requests);
      const userChatId = r.from && r.from.chatId;
      if (userChatId) {
        await tgSend(userChatId,
          '📝 <b>Servono ulteriori informazioni</b>\n\n' + escapeHtml(text) +
          '\n\n💬 <b>Rispondi direttamente qui</b> scrivendo un messaggio o inviando una foto. Tutto quello che scriverai sarà inoltrato all\'amministratore.'
        );
      }
      delete sessions[sessionKey]; saveSessions(sessions);
      await tgSend(chatId, '✅ Messaggio inviato a ' + escapeHtml(r.nome) + '.', mainMenuKeyboard(chatId));
      return;
    }

    // Esecuzione broadcast
    if (session.step === 'broadcast_msg' && text) {
      const links = loadLinks();
      const targets = Object.entries(links).filter(([k]) => k !== '__admin__');
      let sent = 0, failed = 0;
      for (const [, link] of targets) {
        try { await tgSend(link.chatId, '📢 <b>Messaggio dall\'amministratore:</b>\n\n' + text); sent++; }
        catch { failed++; }
      }
      delete sessions[sessionKey]; saveSessions(sessions);
      await tgSend(chatId, `✅ Broadcast completato: <b>${sent}</b> inviati, <b>${failed}</b> falliti.`, mainMenuKeyboard(chatId));
      return;
    }
  }

  // /notifiche — toggle notifiche giornaliere
  if (text === '/notifiche' || text === '/notifications') {
    const links = loadLinks();
    const k = String(chatId);
    const cur = links[k] && links[k].notificationsEnabled === true;
    await tgRequest('sendMessage', {
      chat_id: chatId,
      parse_mode: 'HTML',
      text: cur
        ? '🔔 Le notifiche serali sono <b>attive</b>.\n\nVuoi disattivarle?'
        : '🔕 Le notifiche serali sono <b>disattive</b>.\n\nVuoi attivarle?',
      reply_markup: {
        inline_keyboard: [[
          cur ? { text: '🔕 Disattiva', callback_data: 'notif_off' } : { text: '🔔 Attiva', callback_data: 'notif_on' }
        ]]
      }
    });
    return;
  }

  // Annulla
  if (text === '❌ Annulla' || text === '/annulla' || text === '/cancel') {
    delete sessions[sessionKey];
    saveSessions(sessions);
    await tgSend(chatId, '❌ Operazione annullata.', mainMenuKeyboard(chatId));
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
      mainMenuKeyboard(chatId)
    );

    // Inoltra all'admin
    const adminChatId = getAdminChatId();
    const APP_URL = process.env.APP_URL || 'https://amatriciana.onrender.com';
    if (adminChatId) {
      const summary =
        '🚨 <b>NUOVA RICHIESTA MATRICE</b>\n' +
        '━━━━━━━━━━━━━━━━━━━━━━\n\n' +
        `📝 <b>${escapeHtml(request.nome)}</b>\n` +
        `👔 ${request.ruolo === 'tutor' ? 'Tutor' : 'Dipendente'}  ·  🏷 Team ${request.team}\n` +
        `🏢 Rientro: <b>${escapeHtml(request.rientro)}</b>\n\n` +
        `👤 Telegram: <b>${escapeHtml(userName)}</b>\n` +
        `🆔 <code>${requestId}</code>\n\n` +
        '📸 Screenshot in arrivo qui sotto...';
      try {
        await tgRequest('sendMessage', {
          chat_id: adminChatId,
          text: summary,
          parse_mode: 'HTML',
          disable_notification: false,
          reply_markup: {
            inline_keyboard: [[
              { text: '📱 Apri nell\'app admin', url: APP_URL + '/?request=' + requestId }
            ]]
          }
        });
      } catch (e) { console.warn('forward to admin failed', e.message); }
      for (let i = 0; i < request.photos.length; i++) {
        try { await tgForwardPhoto(adminChatId, request.photos[i], `📸 Settimana ${i+1} di ${request.photos.length} — ${escapeHtml(request.nome)}`); } catch (e) { console.warn('forward photo', i, e.message); }
      }
    } else {
      console.warn('No admin chat registered — request', requestId, 'saved but not forwarded');
      // Avvisa il richiedente in modo che possa segnalare al manager
      try {
        await tgSend(chatId,
          '⚠️ Attenzione: l\'amministratore non è ancora registrato sul bot.\n' +
          'La tua richiesta è salvata. Contatta direttamente il tuo amministratore di team e digli di mandare al bot:\n' +
          '<code>/admin la-sua-password</code>'
        );
      } catch{}
    }
    return;
  }

  // Reply flow: se la chat ha una richiesta in awaitingReply, inoltra tutto all'admin
  const requests = loadRequests();
  const pendingReply = requests.find(r =>
    r.from && r.from.chatId === chatId && r.awaitingReply === true
  );
  if (pendingReply) {
    const adminChatId = getAdminChatId();
    if (!adminChatId) {
      await tgSend(chatId, '⚠️ L\'amministratore non è raggiungibile al momento. Riprova più tardi.');
      return;
    }
    // Inoltra messaggio all'admin con contesto
    const header = `💬 <b>Risposta da ${escapeHtml(pendingReply.nome)}</b> (richiesta <code>${pendingReply.id}</code>)\n`;
    if (msg.photo && msg.photo.length) {
      const fileId = msg.photo[msg.photo.length - 1].file_id;
      try { await tgForwardPhoto(adminChatId, fileId, header + (msg.caption ? '\n' + escapeHtml(msg.caption) : '')); }
      catch (e) { console.warn('forward reply photo', e.message); }
    } else if (text) {
      try { await tgSend(adminChatId, header + '\n' + escapeHtml(text)); }
      catch (e) { console.warn('forward reply text', e.message); }
    } else {
      try { await tgSend(adminChatId, header + '\n<i>(messaggio non testuale ricevuto)</i>'); } catch{}
    }
    // Aggiungi al log della richiesta
    pendingReply.replies = pendingReply.replies || [];
    pendingReply.replies.push({
      at: new Date().toISOString(),
      text: msg.photo ? '[foto]' + (msg.caption ? ': ' + msg.caption : '') : (text || '[messaggio non testuale]')
    });
    saveRequests(requests);
    await tgSend(chatId, '✅ <b>Risposta inviata all\'amministratore.</b>\n\nPuoi continuare a scrivere se servono altri dettagli.', cancelKeyboard());
    return;
  }

  // Default: messaggio generico
  await tgSend(chatId,
    "Non ho capito. Premi <b>📋 Richiedi la mia matrice</b> per iniziare oppure <b>ℹ️ Aiuto</b>.",
    mainMenuKeyboard(chatId)
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
    const images = Array.isArray(body.images) ? body.images : (body.imageBase64 ? [{ base64: body.imageBase64, mime: body.mimeType || 'image/jpeg' }] : []);
    if (!images.length || !body.role) { res.writeHead(400); return res.end(JSON.stringify({ error: 'images + role richiesti' })); }

    const prompt = `Sei un assistente OCR specializzato nella lettura di tabelle di turni di lavoro italiani.
Nelle immagini fornite vedi una o più settimane lavorative con date e orari di inizio turno.

REGOLE DI ESTRAZIONE:
1. Ogni colonna rappresenta un giorno. La riga superiore contiene il NUMERO del giorno (1-31).
2. Sotto ogni numero, leggi l'ORARIO DI INIZIO turno in formato HH:MM (es. "06:00", "12:00", "18:00").
3. Se la colonna è VUOTA o contiene parole come "Libero", "Riposo", "OFF", "—": è un giorno di RIPOSO.
4. Se l'orario è "00:00" o "0.00": è un turno valido che INIZIA a mezzanotte (non riposo).
5. NON inventare giorni. Estrai SOLO i giorni effettivamente visibili in tabella.
6. Per ogni giorno indica anche il MESE rilevato se visibile (es. da "Mar 2026" o "Marzo" o "MAR"); altrimenti null.
7. Per ogni giorno indica un CONFIDENCE da 0.0 a 1.0 sulla certezza della lettura.

OUTPUT JSON RIGOROSO (no markdown, no commenti, no testo prima/dopo):
{
  "giorni": [
    {"data": 23, "mese": "feb", "anno": 2026, "inizio": "08:00", "confidence": 0.95},
    {"data": 24, "mese": "feb", "anno": 2026, "inizio": "RIPOSO", "confidence": 0.90},
    {"data": 25, "mese": "feb", "anno": 2026, "inizio": "12:00", "confidence": 0.85}
  ],
  "weekLabel": "23 feb – 1 mar 2026",
  "noteOCR": "breve nota se hai dubbi (max 60 caratteri)",
  "confidenceGlobale": 0.85
}

ESEMPI:
- Se vedi colonna con "27" sopra e "06:00" sotto: {"data": 27, "inizio": "06:00", "confidence": 0.95}
- Se vedi colonna con "28" sopra e niente sotto: {"data": 28, "inizio": "RIPOSO", "confidence": 0.85}
- Se vedi "29" e "00:00": {"data": 29, "inizio": "00:00", "confidence": 0.90}
- Se vedi "30" e "Libero": {"data": 30, "inizio": "RIPOSO", "confidence": 0.95}

Ruolo operatore: ${body.role}.
Italiano = mesi gen, feb, mar, apr, mag, giu, lug, ago, set, ott, nov, dic.
Se ricevi più immagini, fondi i risultati in UN UNICO array "giorni" ordinato per data.`;

    const parts = [{ text: prompt }];
    images.forEach(img => parts.push({ inline_data: { mime_type: img.mime || 'image/jpeg', data: img.base64 } }));

    const payload = {
      contents: [{ parts }],
      generationConfig: { temperature: 0.05, responseMimeType: 'application/json', maxOutputTokens: 2048 }
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
          if (json.error) { res.writeHead(500); return res.end(JSON.stringify({ error: json.error.message || 'Gemini error' })); }
          let out = json?.candidates?.[0]?.content?.parts?.[0]?.text || '';
          // Pulisci eventuali wrapper markdown
          out = out.replace(/^\s*```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
          // Tenta parse, se fallisce prova ad estrarre JSON con regex
          try { JSON.parse(out); }
          catch {
            const m = out.match(/\{[\s\S]*\}/);
            if (m) out = m[0];
          }
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(out || JSON.stringify({ error: 'no response' }));
        } catch (e) {
          res.writeHead(500); res.end(JSON.stringify({ error: 'parse error', raw: text.substring(0, 500) }));
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
      r.awaitingReply = false;
      const customMsg = body.message ? '\n\n' + body.message : '';
      const linkBlock = body.link ? '\n\n🔗 <b>Link della tua matrice:</b>\n' + body.link : '\n\nL\'amministratore ti invierà a breve il link della matrice.';
      userMessage = '✅ <b>Matrice creata!</b>\n\nLa tua matrice turni è ora disponibile.' + linkBlock + customMsg;
      // Reset notifications: default OFF, l'utente sceglie con inline keyboard
      const userChatId = r.from && r.from.chatId;
      if (userChatId) {
        const linksRef = loadLinks();
        const userKey = String(userChatId);
        if (linksRef[userKey]) {
          linksRef[userKey].notificationsEnabled = false;
          saveLinks(linksRef);
        }
      }
    } else if (action === 'reject') {
      r.status = 'rejected';
      r.awaitingReply = false;
      userMessage = '❌ <b>Richiesta non accolta</b>\n\n' + (message || 'L\'amministratore non può creare la matrice al momento.') + '\n\nPuoi inviare una nuova richiesta in qualsiasi momento.';
    } else if (action === 'needs_info') {
      r.status = 'needs_info';
      r.awaitingReply = true; // Sblocca il flow di risposta libera
      userMessage = '📝 <b>Servono ulteriori informazioni</b>\n\n' + (message || 'L\'amministratore richiede dettagli aggiuntivi.') + '\n\n💬 <b>Rispondi direttamente qui</b> scrivendo un messaggio o inviando una foto. Tutto quello che scriverai sarà inoltrato all\'amministratore.';
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
      try {
        await tgSend(chatId, userMessage);
        // Se admin ha chiesto di proporre notifiche, manda inline keyboard separata
        if (action === 'approve' && body.proposeNotifications) {
          await tgRequest('sendMessage', {
            chat_id: chatId,
            text: '🔔 <b>Vuoi ricevere ogni sera il turno del giorno dopo?</b>\n\nPotrai cambiare idea in qualsiasi momento.',
            parse_mode: 'HTML',
            reply_markup: {
              inline_keyboard: [[
                { text: '🔔 Sì, attiva notifiche', callback_data: 'notif_on' },
                { text: '🔕 No grazie', callback_data: 'notif_off' }
              ]]
            }
          });
        }
      } catch (e) { console.warn('notify user failed', e.message); }
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
    const { code, text, force } = body;
    if (!code || !text) { res.writeHead(400); return res.end(JSON.stringify({ error: 'missing code/text' })); }
    const links = loadLinks();
    const link = links[code];
    if (!link) { res.writeHead(404); return res.end(JSON.stringify({ error: 'not linked' })); }
    // Rispetta opt-out: blocca daily reminders se l'utente non ha attivato notifiche
    if (!force && link.notificationsEnabled !== true) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, reason: 'notifications_disabled' }));
    }
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
      // Solo se l'utente ha opt-in attivamente
      if (code === '__admin__') continue;
      if (link.notificationsEnabled !== true) continue;
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
