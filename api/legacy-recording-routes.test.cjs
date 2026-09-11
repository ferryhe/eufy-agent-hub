const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { torontoTime, parseWindow, serveMedia } = require('./legacy-recording-routes.cjs');

test('Toronto window handles summer, winter and invalid/ambiguous dates', () => {
  assert.equal(torontoTime('2026-08-27', '16:30'), 1787862600000);
  assert.equal(new Date(torontoTime('2026-01-27', '16:30')).toISOString(), '2026-01-27T21:30:00.000Z');
  for (const [day, time] of [['2026-02-30','16:30'],['2026-03-08','02:30'],['2026-11-01','01:30']]) assert.throws(() => torontoTime(day, time));
  assert.throws(() => parseWindow({serial:'CAMERA123',day:'2026-08-27',start:'16:50',end:'16:30'}));
  assert.deepEqual(parseWindow({serial:'CAMERA123',day:'2026-08-27',start:'16:30',end:'16:50'}), {
    serial: 'CAMERA123', day: '2026-08-27', start: 1787862600000, end: 1787863800000, timezone: 'America/Toronto',
  });
});

test('playback supports byte ranges and rejects out-of-range requests', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'eufy-media-test-'));
  const file = path.join(directory,'clip.mp4'); fs.writeFileSync(file,'0123456789');
  const server = http.createServer((req,res)=>serveMedia(req,res,file));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{ await new Promise(resolve=>server.close(resolve)); fs.rmSync(directory,{recursive:true,force:true}); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const full = await fetch(url); assert.equal(full.status,200); assert.equal(await full.text(),'0123456789');
  const part = await fetch(url,{headers:{Range:'bytes=2-5'}});
  assert.equal(part.status,206); assert.equal(await part.text(),'2345');
  const suffix = await fetch(url,{headers:{Range:'bytes=-3'}}); assert.equal(await suffix.text(),'789');
  const invalid = await fetch(url,{headers:{Range:'bytes=10-20'}}); assert.equal(invalid.status,416);
  const head = await fetch(url + '?download',{method:'HEAD'});
  assert.equal(head.headers.get('content-length'),'10');
  assert.match(head.headers.get('content-disposition'), /attachment/);
  assert.equal(await head.text(),'');
});
