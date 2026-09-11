const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { LocalEufySession } = require('../auth/session.cjs');
const { LocalContinuousRecordings } = require('./continuous.cjs');
const { assessCompleteness } = require('./continuous-completeness.cjs');
const { createServer } = require('../../interface/server.cjs');

const REQUEST = Object.freeze({
  cameraName:'Drive Way',cameraModel:'T8600',stationModel:'T8030',timezone:'America/Toronto',
  localBegin:'2026-08-27T16:30:00-04:00',localEnd:'2026-08-27T16:50:00-04:00',
  begin:1787862600,end:1787863800,
});

function hash(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file,'r'), buffer = Buffer.alloc(1024*1024);
  try {
    let count;
    while ((count = fs.readSync(fd,buffer,0,buffer.length,null))) hash.update(buffer.subarray(0,count));
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function writeEvidence(directory, capture, decode) {
  const completeness = assessCompleteness(capture, {decode});
  const artifacts = {};
  for (const name of ['frames.bin','frames.json','timed.ts','playback.mp4']) {
    const file = path.join(directory,name);
    if (fs.existsSync(file)) artifacts[name] = {bytes:fs.statSync(file).size,sha256:hash(file)};
  }
  const evidence = {recordedAt:new Date().toISOString(),request:REQUEST,node:process.version,
    // Frame payloads, account IDs, serial numbers and LAN addresses stay out of this report.
    ranges:capture.ranges.map(({start_time,stop_time})=>({start_time,stop_time})),
    segments:capture.segments,completeness,artifacts,
    hardwareAccepted:false,hardwareGate:'Requires retained 20-minute hardware capture, full decode, timestamp preservation review and device/firmware evidence.'};
  fs.writeFileSync(path.join(directory,'evidence.json'),JSON.stringify(evidence,null,2));
  return evidence;
}

function startEvidenceCapture(directory, {port = 3188, session = new LocalEufySession(),
  service = new LocalContinuousRecordings(session), onReady = () => {}} = {}) {
  if (Number(port) === 3187) throw new Error('Port 3187 is reserved for the existing service');
  const server = createServer({port,session,outputRoot:path.join(directory,'unused-event-output')});
  const cancellation = new AbortController();
  let timer, running = false, cancelled = false, rejectCompletion;
  const completion = new Promise((resolve,reject)=>{
    rejectCompletion = reject;
    server.once('error',reject);
    server.start(()=>{
      onReady(`http://127.0.0.1:${server.address().port}`);
      timer = setInterval(async ()=>{
        if (running || !session.authenticated || session.state.phase !== 'connected') return;
        try {
          const status = await fetch(`http://127.0.0.1:${server.address().port}/status`).then(response=>response.json());
          if (cancelled || running || status.busy) return;
          running = true; clearInterval(timer);
          // Close the login page before playback, so this session cannot start another operation.
          server.close();
          const cameras = session.state.devices.filter(device=>device.name === REQUEST.cameraName && device.model === REQUEST.cameraModel);
          if (cameras.length !== 1) throw new Error('Expected exactly one Drive Way T8600 camera in the authenticated inventory');
          const capture = await service.captureRange(cameras[0].serial,REQUEST.begin,REQUEST.end,directory,{signal:cancellation.signal});
          resolve(writeEvidence(directory,capture));
        } catch (error) { reject(error); }
        finally { if (running) service.close(); }
      },250);
    });
  });
  completion.finally(()=>{ clearInterval(timer); if (server.listening) server.close(); }).catch(()=>{});
  return {server,completion,stop:()=>{
    if (cancelled) return;
    cancelled = true; clearInterval(timer);
    cancellation.abort(new Error('Continuous capture cancelled'));
    service.close();
    if (!running) rejectCompletion(new Error('Validation cancelled before capture'));
  }};
}

function verifyEvidence(directory, ffmpeg = process.env.EUFY_FFMPEG || 'ffmpeg') {
  const capture = JSON.parse(fs.readFileSync(path.join(directory,'frames.json'),'utf8'));
  if (capture.begin !== REQUEST.begin || capture.end !== REQUEST.end) throw new Error('This runner verifies only the authorized 20-minute window');
  const version = spawnSync(ffmpeg,['-version'],{encoding:'utf8',windowsHide:true});
  const result = spawnSync(ffmpeg,['-hide_banner','-nostdin','-v','error','-xerror',
    '-i',path.join(directory,'playback.mp4'),'-map','0:v:0','-map','0:a?',
    '-progress','pipe:1','-f','null','-'],{encoding:'utf8',windowsHide:true,timeout:60*60*1000,maxBuffer:8*1024*1024});
  fs.writeFileSync(path.join(directory,'decode.stderr.log'),result.stderr || result.error?.message || '');
  fs.writeFileSync(path.join(directory,'decode.progress.log'),result.stdout || '');
  const progress = Object.fromEntries((result.stdout || '').trim().split(/\r?\n/).map(line=>line.split('=')));
  const decode = {status:result.status === 0 && progress.progress === 'end' && Number(progress.frame) > 0 ? 'passed' : 'failed',
    full:true,videoFrames:Number(progress.frame) || 0,durationMs:Number(progress.out_time_us)/1000 || 0,
    exitCode:result.status,ffmpegVersion:(version.stdout || '').split(/\r?\n/)[0]};
  return writeEvidence(directory,capture,decode);
}

if (require.main === module) {
  const [command,directory] = process.argv.slice(2);
  if (!['capture','verify'].includes(command) || !directory) {
    console.log('Usage: node capabilities/recordings/continuous-evidence.cjs capture|verify <new-private-directory>');
    process.exitCode = 1;
  } else if (command === 'capture') {
    const runner = startEvidenceCapture(path.resolve(directory),{port:Number(process.env.EUFY_VALIDATION_PORT || 3188),
      onReady:url=>console.log(`Sign in normally at ${url}. The retained authorized 20-minute window will then be queried and captured. Stop with Ctrl+C.`)});
    process.once('SIGINT',runner.stop); process.once('SIGTERM',runner.stop);
    runner.completion.then(evidence=>{
      console.log(`Capture: ${evidence.completeness.status}. Local report: ${path.resolve(directory,'evidence.json')}`);
      process.exit(evidence.completeness.status === 'failed' ? 1 : 2);
    },()=>{ console.error('Validation could not complete. Check the local login page or private capture diagnostics; no hardware pass recorded.'); process.exit(1); });
  } else {
    try {
      const evidence = verifyEvidence(path.resolve(directory));
      console.log(`Assessed result: ${evidence.completeness.status}; hardware acceptance still requires evidence review.`);
      process.exitCode = evidence.completeness.status === 'complete' ? 0 : evidence.completeness.status === 'partial' ? 2 : 1;
    } catch { console.error('Could not verify local capture artifacts. No hardware pass recorded.'); process.exitCode = 1; }
  }
}

module.exports = { REQUEST, startEvidenceCapture, verifyEvidence, writeEvidence };
