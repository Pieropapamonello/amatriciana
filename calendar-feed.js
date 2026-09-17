const crypto = require('crypto');

function decodeCalendarConfig(token) {
  if (!/^[A-Za-z0-9_-]{1,2048}$/.test(token)) throw new Error('Link non valido');
  const p = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  const start = new Date(p.w + 'T12:00:00Z');
  if (!['tutor', 'dipendente'].includes(p.r) || typeof p.n !== 'string' || p.n.length > 160 ||
      !/^\d{4}-\d{2}-\d{2}$/.test(p.w) || !Number.isFinite(start.getTime()) ||
      start.toISOString().slice(0,10) !== p.w || start.getUTCDay() !== 1 ||
      start.getUTCFullYear() < 1900 || start.getUTCFullYear() > 9998 ||
      (p.t != null && (!Number.isInteger(p.t) || p.t < 1 || p.t > 9)) ||
      ![240,360,396,480].includes(p.dm) || !Number.isInteger(p.a) || p.a < 0 ||
      p.a >= (p.r === 'tutor' ? 15 : 18)) throw new Error('Configurazione non valida');
  return { name:p.n, role:p.r, durationMinutes:p.dm, startWeekISO:p.w, anchorPatternIndex:p.a, team:p.t || null };
}

function buildCalendarFeed(cfg, schedule, year, now = new Date()) {
  if (year !== undefined && (!Number.isInteger(year) || year < 1900 || year > 9998)) throw new Error('Anno non valido');
  const firstYear = year ?? Math.max(now.getUTCFullYear() - 1, Number(cfg.startWeekISO.slice(0,4)));
  const lastYear = year ?? Math.max(now.getUTCFullYear() + 2, firstYear + 1);
  const escape = value => String(value).replace(/\\/g,'\\\\').replace(/\r?\n/g,'\\n').replace(/[,;]/g, c=>'\\'+c);
  const fold = line => {
    const parts = []; let part = '', bytes = 0;
    for (const char of line) {
      const size = Buffer.byteLength(char);
      if (bytes + size > 75) { parts.push(part); part = ' '; bytes = 1; }
      part += char; bytes += size;
    }
    parts.push(part); return parts.join('\r\n');
  };
  const stamp = now.toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
  const identity = crypto.createHash('sha256').update(JSON.stringify(cfg)).digest('hex').slice(0,24);
  const lines = ['BEGIN:VCALENDAR','VERSION:2.0','PRODID:-//Matrice Orari//IT','CALSCALE:GREGORIAN','METHOD:PUBLISH',
    'X-WR-CALNAME:'+escape('Turni di '+cfg.name),'X-WR-TIMEZONE:Europe/Rome',
    'BEGIN:VTIMEZONE','TZID:Europe/Rome','BEGIN:STANDARD','DTSTART:19701025T030000',
    'RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=10','TZOFFSETFROM:+0200','TZOFFSETTO:+0100','TZNAME:CET','END:STANDARD',
    'BEGIN:DAYLIGHT','DTSTART:19700329T020000','RRULE:FREQ=YEARLY;BYDAY=-1SU;BYMONTH=3',
    'TZOFFSETFROM:+0100','TZOFFSETTO:+0200','TZNAME:CEST','END:DAYLIGHT','END:VTIMEZONE'];
  for (let date = new Date(Date.UTC(firstYear,0,1,12)); date.getUTCFullYear() <= lastYear; date.setUTCDate(date.getUTCDate()+1)) {
    const iso = date.toISOString().slice(0,10);
    const day = schedule(cfg, iso);
    if (!day || day.isRest) continue;
    const startDate = iso.replace(/-/g,'');
    const endDate = new Date(date);
    if (day.end <= day.start) endDate.setUTCDate(endDate.getUTCDate()+1);
    const endISO = endDate.toISOString().slice(0,10).replace(/-/g,'');
    lines.push('BEGIN:VEVENT',`UID:${identity}-${startDate}@matrice-orari`,`DTSTAMP:${stamp}`,
      `DTSTART;TZID=Europe/Rome:${startDate}T${day.start.replace(':','')}00`,
      `DTEND;TZID=Europe/Rome:${endISO}T${day.end.replace(':','')}00`,
      'SUMMARY:'+escape(`Turno ${day.start}–${day.end}${day.isRientro?' (Rientro)':''}`),
      'DESCRIPTION:'+escape(`Turno di ${cfg.name}${day.holidayName?' · '+day.holidayName:''}`),
      'STATUS:CONFIRMED','TRANSP:OPAQUE','END:VEVENT');
  }
  lines.push('END:VCALENDAR');
  return lines.map(fold).join('\r\n')+'\r\n';
}

module.exports = { decodeCalendarConfig, buildCalendarFeed };
