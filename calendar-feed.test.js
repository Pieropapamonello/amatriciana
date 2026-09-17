const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeCalendarConfig, buildCalendarFeed } = require('./calendar-feed');
const payload = { n:'Collega è', r:'tutor', dm:360, w:'2026-02-16', a:0, t:8 };
const encode = p => Buffer.from(JSON.stringify(p)).toString('base64url');
const cfg = decodeCalendarConfig(encode(payload));

test('validates calendar links and rejects malformed or unbounded input', () => {
  assert.equal(cfg.name, payload.n);
  for(const change of [{w:'2026-02-30'},{w:'2026-02-17'},{dm:0},{a:15},{r:'unknown'},{t:{}},{w:'9999-01-04'}])
    assert.throws(() => decodeCalendarConfig(encode({...payload,...change})));
  assert.throws(() => decodeCalendarConfig('!'));
  assert.throws(() => buildCalendarFeed(cfg,()=>null,Infinity));
});

test('preserves midnight rollover and Rome daylight-saving rules', () => {
  const text = buildCalendarFeed(cfg, (_,date) => date==='2026-12-31' ? {start:'18:00',end:'00:00',isRest:false} : null, 2026);
  assert.match(text,/DTSTART;TZID=Europe\/Rome:20261231T180000/);
  assert.match(text,/DTEND;TZID=Europe\/Rome:20270101T000000/);
  assert.match(text,/BYDAY=-1SU;BYMONTH=3/);
  assert.match(text,/BYDAY=-1SU;BYMONTH=10/);
  assert.equal((text.match(/BEGIN:VEVENT/g)||[]).length,1);
});

test('skips rest days, escapes text, folds UTF-8 at 75 bytes and keeps stable event IDs', () => {
  const named = {...cfg,name:'è'.repeat(80)+'\nBEGIN:BAD;,'};
  const schedule = (_,date) => ({start:'06:00',end:'12:00',isRest:!date.endsWith('-01-01')});
  const first = buildCalendarFeed(named,schedule,2028,new Date('2026-09-17T12:00:00Z'));
  const second = buildCalendarFeed(named,schedule,2028,new Date('2026-09-18T12:00:00Z'));
  assert.equal((first.match(/BEGIN:VEVENT/g)||[]).length,1);
  assert.equal(first.match(/UID:.+/)[0],second.match(/UID:.+/)[0]);
  assert(!first.includes('\r\nBEGIN:BAD'));
  assert(first.split('\r\n').every(line=>Buffer.byteLength(line)<=75));
  assert(!first.includes('\uFFFD'));
});

test('subscription advances its date window, including leap days', () => {
  const days=[];
  buildCalendarFeed(cfg,(_,date)=>{days.push(date);return null;},undefined,new Date('2027-06-01T12:00:00Z'));
  assert.equal(days[0],'2026-01-01');
  assert.equal(days.at(-1),'2029-12-31');
  assert(days.includes('2028-02-29'));
});
