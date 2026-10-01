const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { chromium } = require('@playwright/test');

const packageRoot = process.env.EUFY_PACKAGE_ROOT;
const packaged = relative => path.join(packageRoot || '.', relative);
const node = packageRoot && packaged('runtime/node/node.exe');
const python = packageRoot && packaged('runtime/python/python.exe');
const ffmpeg = packageRoot && packaged('runtime/ffmpeg/ffmpeg.exe');

test('extracted package serves synthetic H.264/AAC event and continuous MP4s to Chromium',{skip:!packageRoot}, async t => {
  assert.equal(path.resolve(process.execPath), path.resolve(node), 'the test must run with packaged Node');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'eufy-ac4-package-'));
  let server, browser;
  t.after(async()=>{if(browser)await browser.close();if(server){await new Promise(resolve=>server.close(resolve));await server.shutdown()}fs.rmSync(root,{recursive:true,force:true})});
  const eventsRoot = path.join(root, 'recordings', 'events');
  const jobsRoot = path.join(root, 'recordings', 'continuous-jobs');
  const media = path.join(root, 'synthetic-h264-aac.mp4');
  fs.mkdirSync(eventsRoot, { recursive: true });
  fs.mkdirSync(jobsRoot, { recursive: true });
  execFileSync(ffmpeg, ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x240:rate=30',
    '-f','lavfi','-i','sine=frequency=880:sample_rate=48000','-t','4','-c:v','libx264','-pix_fmt','yuv420p',
    '-c:a','aac','-b:a','128k','-movflags','+faststart','-shortest',media], { stdio: 'inherit' });

  const probe = path.join(root, 'probe.py');
  fs.writeFileSync(probe, `import av, json, sys\ncounts={"video":0,"audio":0}\nwith av.open(sys.argv[1]) as container:\n    codecs={s.type:s.codec_context.name for s in container.streams}\n    for frame in container.decode():\n        counts["video" if isinstance(frame, av.VideoFrame) else "audio"]+=1\nassert counts["video"] > 0 and counts["audio"] > 0\nprint(json.dumps({"pyav":av.__version__,"libraries":av.library_versions,"codecs":codecs,"frames":counts}, sort_keys=True))\n`);
  const pyav = JSON.parse(execFileSync(python, ['-B', probe, media], { encoding: 'utf8' }));

  const eventDirectory = path.join(eventsRoot, 'CAMERA01_2026-08-27');
  const eventMedia = path.join(eventDirectory, 'event.mp4');
  fs.mkdirSync(eventDirectory);fs.copyFileSync(media, eventMedia);
  fs.writeFileSync(path.join(eventDirectory, 'manifest.json'), JSON.stringify({device:'Synthetic camera',serial:'CAMERA01',timezone:'America/Toronto',clips:[{
    recordId:'event-1',start:'2026-08-27T20:30:00.000Z',end:'2026-08-27T20:30:04.000Z',bytes:fs.statSync(eventMedia).size,file:eventMedia,
    window:{version:1,input:{day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'},normalized:{start:'2026-08-27T20:30:00.000Z',end:'2026-08-27T20:31:00.000Z',timezone:'America/Toronto'}}
  }]}));

  const { JobService } = require(packaged('jobs/service.cjs'));
  const { normalizeWindow } = require(packaged('capabilities/recordings/time-window.cjs'));
  const jobs = new JobService({ outputRoot: jobsRoot, worker: async ({ artifactsDir, registerArtifact }) => {
    const destination = path.join(artifactsDir, 'continuous.mp4');fs.copyFileSync(media, destination);registerArtifact('artifacts/continuous.mp4');
    return {outcome:'complete',coverageVerified:true,validation:{passed:true,decode:{status:'passed',full:true,videoFrames:pyav.frames.video,audioFrames:pyav.frames.audio}},
      coverage:{requestedMs:4000,coveredMs:4000},media:{path:'artifacts/continuous.mp4',playable:true},diagnostics:['synthetic_offline_fixture']};
  }});
  const submitted = jobs.submit({requestId:'synthetic-continuous',homeBaseId:'BASE0001',input:{serial:'CAMERA01',window:normalizeWindow({day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'})}});
  await jobs.whenIdle();assert.equal(jobs.get(submitted.jobId).state,'succeeded');

  const { DeviceType } = require(packaged('adapters/eufy'));
  const { queryDevice } = require(packaged('capabilities/devices/capabilities.cjs'));
  const { DeviceVerificationRepository } = require(packaged('capabilities/devices/verification-store.cjs'));
  const raw = [
    {device_sn:'BASE0001',device_name:'Synthetic Base',device_model:'T8030',device_type:DeviceType.HB3,local_ip:'192.0.2.1',main_sw_version:'b1',sec_sw_version:'b2'},
    {device_sn:'CAMERA01',device_name:'Synthetic camera',parent_sn:'BASE0001',device_model:'T8600',device_type:DeviceType.PROFESSIONAL_247,device_channel:0,main_sw_version:'c1',sec_sw_version:'c2'},
  ];
  const repository = new DeviceVerificationRepository(path.join(root, 'devices', 'verification.json'));
  repository.record({capability:'continuousPlaybackControls',status:'verified',scope:queryDevice(raw,'CAMERA01').verificationScope,reason:'synthetic_offline_fixture',
    evidence:[{source:'synthetic-offline-fixture',observedAt:'2026-10-01T00:00:00Z',outcome:'browser_media_and_controls'}],controls:{pauseResumeAtSpeed1:true,verifiedStartSpeeds:[1]}});
  const session = {api:{getDevsListDecrypted:async()=>({devices:raw})},authenticated:true,state:{phase:'connected',devices:[],diagnostics:[]},isAuthenticated(){return true},restore(){},close(){}};
  const { createServer } = require(packaged('interface/server.cjs'));
  server = createServer({port:0,dataRoot:root,session,recordings:{close(){}},outputRoot:eventsRoot,deviceRepository:repository,
    exports:{dataRoot:root,outputRoot:jobsRoot}});
  await new Promise((resolve,reject)=>{server.once('error',reject);server.start(resolve)});
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({headless:true,args:['--autoplay-policy=no-user-gesture-required']});
  const context = await browser.newContext({locale:'en'});
  await context.addInitScript(({jobId})=>{localStorage.setItem('eufy-agent-hub.language','en');localStorage.setItem('eufy-agent-hub.recording-workbench',JSON.stringify({version:1,jobIds:[jobId]}))},{jobId:submitted.jobId});
  const page = await context.newPage(), mediaResponses=[];
  page.on('response',response=>{const pathname=new URL(response.url()).pathname;if(pathname.includes('/recordings/media/')||pathname.includes('/artifacts/'))mediaResponses.push({pathname,status:response.status()})});
  await page.goto(origin+'/app/recordings');await page.getByRole('heading',{name:'Recording workbench'}).waitFor();
  await page.locator('video[src*="/recordings/media/"]').waitFor({timeout:10000});
  await page.locator(`article[data-job="${submitted.jobId}"] video`).waitFor({timeout:10000});

  const checkVideo = async locator => locator.evaluate(async video => {
    const audio = new AudioContext(), source = audio.createMediaElementSource(video), analyser = audio.createAnalyser();
    analyser.fftSize=256;source.connect(analyser);analyser.connect(audio.destination);await audio.resume();await video.play();
    const start=performance.now();while(video.currentTime<0.75&&performance.now()-start<10000)await new Promise(resolve=>setTimeout(resolve,50));
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight;const context=canvas.getContext('2d');context.drawImage(video,0,0);
    const pixels=context.getImageData(0,0,canvas.width,canvas.height).data,frequency=new Uint8Array(analyser.frequencyBinCount);analyser.getByteFrequencyData(frequency);
    let nonBlackRgb=false;for(let index=0;index<pixels.length;index+=4)if(pixels[index]||pixels[index+1]||pixels[index+2]){nonBlackRgb=true;break}
    const result={currentTime:video.currentTime,width:video.videoWidth,height:video.videoHeight,nonBlackRgb,audioBins:[...frequency].filter(value=>value>0).length};
    video.pause();source.disconnect();await audio.close();return result;
  });
  const event = await checkVideo(page.locator('video[src*="/recordings/media/"]'));
  const continuous = await checkVideo(page.locator(`article[data-job="${submitted.jobId}"] video`));
  for(const result of [event,continuous]){assert.ok(result.currentTime>=0.75,JSON.stringify(result));assert.deepEqual([result.width,result.height],[320,240]);assert.equal(result.nonBlackRgb,true);assert.ok(result.audioBins>0,JSON.stringify(result))}
  assert.ok(mediaResponses.some(item=>item.pathname.includes('/recordings/media/')&&[200,206].includes(item.status)),JSON.stringify(mediaResponses));
  assert.ok(mediaResponses.some(item=>item.pathname.includes('/artifacts/')&&[200,206].includes(item.status)),JSON.stringify(mediaResponses));
  t.diagnostic(JSON.stringify({boundary:'all identifiers, verification evidence, P2P-independent MP4s, event manifest, and continuous job are synthetic; Chromium is supplied by Playwright outside the package',
    node:process.version,chromium:browser.version(),ffmpeg:execFileSync(ffmpeg,['-version'],{encoding:'utf8'}).split(/\r?\n/)[0],pyav,event,continuous,mediaResponses}));
  await context.close();
});
