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
  const query = parseWindow({serial:'CAMERA123',day:'2026-08-27',start:'16:30',end:'16:50'});
  const { window, coverage, ...legacy } = query;
  assert.deepEqual(legacy, {
    serial: 'CAMERA123', day: '2026-08-27', start: 1787862600000, end: 1787863800000, timezone: 'America/Toronto',
  });
  assert.equal(coverage, null);
  assert.equal(window.normalized.start, new Date(query.start).toISOString());
});

test('explicit caller timezone controls query instants', () => {
  const query = parseWindow({serial:'CAMERA123', day:'2026-08-27', start:'16:30', end:'16:50', timezone:'Asia/Shanghai'});
  assert.equal(new Date(query.start).toISOString(), '2026-08-27T08:30:00.000Z');
  assert.equal(query.timezone, 'Asia/Shanghai');
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

test('HTTP queries expose defaults and persist each export context across restart and mixed zones', async t => {
  const { EventEmitter } = require('node:events');
  const { PassThrough } = require('node:stream');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(),'eufy-window-route-'));
  t.after(() => fs.rmSync(directory,{recursive:true,force:true}));
  t.mock.method(require('node:child_process'), 'spawn', (_program, args) => {
    const child = new EventEmitter(); child.stderr = new PassThrough(); child.stdout = new PassThrough();
    if (args.at(-1) !== '-') fs.writeFileSync(args.at(-1),'fake mp4');
    process.nextTick(() => child.emit('close',0));
    return child;
  });
  for (const file of ['./legacy-recording-routes.cjs','../capabilities/recordings/export.cjs']) delete require.cache[require.resolve(file)];
  t.after(() => { for (const file of ['./legacy-recording-routes.cjs','../capabilities/recordings/export.cjs']) delete require.cache[require.resolve(file)]; });
  const { installRecordingRoutes } = require('./legacy-recording-routes.cjs');
  const windows = [];
  const recordings = {
    status:{device:'Fixture camera'},
    async listWindow(_serial, window) {
      windows.push(window);
      return [{record_id:windows.length,start_time:new Date(window.normalized.start),end_time:new Date(window.normalized.end)}];
    },
    async download(recordId, outputDir, window) {
      fs.mkdirSync(outputDir,{recursive:true});
      const prefix = path.join(outputDir,String(recordId));
      fs.writeFileSync(prefix + '.json',JSON.stringify({complete:true,window,metadata:{videoCodec:0,videoFPS:15},
        record:{record_id:recordId,device_sn:'CAMERA123',start_time:window.normalized.start,end_time:window.normalized.end}}));
      fs.writeFileSync(prefix + '.audio','');
      return {prefix};
    },
  };
  const session = {authenticated:true,state:{phase:'connected'}};
  const server = http.createServer((_req,res)=>res.end());
  const routes = installRecordingRoutes(server,session,{recordings,outputRoot:directory,defaultTimezone:'Asia/Shanghai'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>new Promise(resolve=>server.close(resolve)));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const post = async (route,data) => {
    const response = await fetch(origin + route,{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(data)});
    assert.equal(response.status,202,JSON.stringify(await response.clone().json()));
    for (let i=0; i<100 && routes.state.busy; i++) await new Promise(resolve=>setTimeout(resolve,5));
    assert.equal(routes.state.busy,false);
    return response.json();
  };
  assert.equal((await (await fetch(origin + '/recordings/status')).json()).timezone,'Asia/Shanghai');
  const base = {serial:'CAMERA123',day:'2026-08-27',start:'16:30',end:'16:50'};
  const accepted = await post('/recordings/query',base);
  assert.equal(accepted.timezone,'Asia/Shanghai');
  assert.equal(accepted.window.input.timezone,null);
  assert.equal(accepted.window.normalized.start,'2026-08-27T08:30:00.000Z');
  assert.deepEqual(windows[0],accepted.window);
  assert.equal(routes.state.records[0].timezone,'Asia/Shanghai');
  await post('/recordings/download',{recordId:'1'});
  assert.equal(routes.state.saved[0].timezone,'Asia/Shanghai');
  await post('/recordings/query',{...base,timezone:'Europe/London'});
  await post('/recordings/download',{recordId:'2'});
  const manifest = JSON.parse(fs.readFileSync(path.join(directory,'CAMERA123_2026-08-27','manifest.json')));
  assert.equal(manifest.timezone,null);
  assert.deepEqual(manifest.clips.map(clip=>clip.timezone),['Asia/Shanghai','Europe/London']);
  assert.deepEqual(manifest.clips[0].window,accepted.window);
  assert.equal(manifest.clips[0].coverage,null);
  const restarted = http.createServer((_req,res)=>res.end());
  const restored = installRecordingRoutes(restarted,session,{recordings,outputRoot:directory,defaultTimezone:'UTC'});
  assert.deepEqual(restored.state.saved.map(clip=>clip.timezone).sort(),['Asia/Shanghai','Europe/London'].sort());
  assert.deepEqual(restored.state.saved.find(clip=>clip.recordId==='1').window,accepted.window);
  const invalid = await fetch(origin + '/recordings/query',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({...base,timezone:'invalid/zone'})});
  assert.equal(invalid.status,400);
  assert.equal((await invalid.json()).errorI18n.key,'service.recordings.invalidTimezone');
});
