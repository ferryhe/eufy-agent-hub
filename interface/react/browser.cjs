const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chromium}=require('@playwright/test'); const {createServer}=require('../server.cjs');
const {fixture}=require('../agent/fixture.cjs');
const {JobService}=require('../../jobs/service.cjs');
const {RecordingTools}=require('../../agent/tools.cjs');
const {cli}=require('../../cli/test-helper.cjs');
test('Chromium M1 shell uses the resident fixture without persistence or route interception',async t=>{const root=fs.mkdtempSync(path.join(os.tmpdir(),'eufy-pw-'));let logins=0;const session={authenticated:false,state:{phase:'login_required',devices:[],diagnostics:[],message:'请登录'},isAuthenticated(){return this.authenticated},async restore(){this.state={phase:'login_required',devices:[],diagnostics:[],message:'登录已过期，请重新登录。',messageI18n:{key:'service.auth.expired'}}},async login(d){logins++;if(d.email==='fail@test')throw new Error('login failed');this.state={phase:'tfa',devices:[],diagnostics:[],message:'验证码已发送',messageI18n:{key:'service.auth.codeSent'}}},async verify(c){if(c==='captcha'){this.state={phase:'captcha',captcha:'data:image/png;base64,iVBORw0KGgo=',devices:[],diagnostics:[],message:'请输入图片验证码'};return}if(c==='bad'){this.state={phase:'tfa',devices:[],diagnostics:[],message:'验证码不正确',messageI18n:{key:'service.auth.codeIncorrect'}};return}this.authenticated=true;this.state={phase:'connected',devices:[{serial:'fixture'}],diagnostics:[],message:'已登录',messageI18n:{key:'service.devices.loaded',params:{country:'CA',count:1}}}},async refresh(){this.state={...this.state,diagnostics:['inventory'],diagnosticsI18n:[{key:'service.devices.loadFailed',params:{country:'CA'}}],message:'读取失败',messageI18n:{key:'service.devices.loadFailed',params:{country:'CA'}}};return},fail(){this.state={phase:'login_required',devices:[],diagnostics:[],message:'登录失败',messageI18n:{key:'service.auth.loginFailed'}}},logout(){this.authenticated=false;this.state={phase:'login_required',devices:[],diagnostics:[],message:'已登出'}},close(){}};const srv=createServer({port:0,session,recordings:{close(){}},outputRoot:root});
  await new Promise(r=>srv.start(r));const origin=`http://127.0.0.1:${srv.address().port}`;let browser;t.after(async()=>{if(browser)await browser.close();
  await new Promise(r=>srv.close(r));
  await srv.shutdown();fs.rmSync(root,{recursive:true,force:true})});browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});const logs=[];page.on('console',m=>logs.push(m.text()));page.on('pageerror',e=>logs.push(e.message));for(const [route,name] of [['settings','Settings'],['jobs','Export task center'],['live','Live'],['recordings','Sign in']]){await page.goto(`${origin}/app/${route}`);
  await page.getByRole('heading',{name}).waitFor()}const html=await (await page.request.get(origin+'/app/')).text();const asset=/src=\"(\/app\/assets\/[^\"]+\.js)\"/.exec(html)[1];const bundle=await (await page.request.get(origin+asset)).text();
  assert.equal(/eufy-security-client|OPENAI_API_KEY|\/v1\/chat\/completions/.test(bundle),false);
  assert.equal((await page.request.get(origin+'/api/v1/contract')).status(),200);
  assert.equal((await page.request.get(origin+'/api/v1/jobs/no/artifacts/no')).status(),404);
  await page.goto(origin+'/app/recordings');
  await page.getByLabel('Email').fill('fail@test');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button',{name:'Sign in'}).click();
  await page.getByText(/Could not complete login/i).waitFor();
  await page.getByLabel('Email').fill('x@test');
  await page.getByLabel('Password').fill('secret');
  await page.getByRole('button',{name:'Sign in'}).click();
  await page.getByLabel('Verification code').fill('bad');
  await page.getByRole('button',{name:'Verification code'}).click();
  await page.getByText(/incorrect/i).waitFor();
  assert.match(page.url(),/recordings/);
  await page.getByLabel('Verification code').fill('captcha');
  await page.getByRole('button',{name:'Verification code'}).click();
  await page.getByAltText('CAPTCHA challenge').waitFor();
  await page.getByLabel('Verification code').fill('123456');
  await page.getByRole('button',{name:'Verification code'}).click();
  await page.getByRole('button',{name:'Refresh inventory'}).waitFor();
  await page.getByRole('button',{name:'Refresh inventory'}).click();
  await page.getByRole('status').getByText(/device discovery failed/i).waitFor();
  await page.getByRole('button',{name:'Sign out'}).click();const logoutDialog=page.getByRole('alertdialog');
  await logoutDialog.waitFor();
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Close');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Sign out');
  await page.waitForTimeout(1400);
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Sign out');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Close');
  await page.keyboard.press('Escape');
  assert.equal(await logoutDialog.count(),0);
  await page.waitForFunction(()=>document.activeElement?.textContent==='Sign out');
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Sign out');
  await page.getByRole('button',{name:'Sign out'}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'Close'}).click();
  await page.waitForFunction(()=>document.activeElement?.textContent==='Sign out');
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Sign out');
  await page.getByRole('button',{name:'Sign out'}).click();
  await page.getByRole('alertdialog').getByRole('button',{name:'Sign out'}).click();
  await page.getByRole('heading',{name:'Sign in'}).waitFor();
  assert.equal(logins,2);const stored=await page.evaluate(()=>[...Object.keys(localStorage).map(k=>k+'='+localStorage.getItem(k)),...Object.keys(sessionStorage).map(k=>k+'='+sessionStorage.getItem(k))].join('&'));
  assert.equal(stored.includes('secret'),false);
  assert.equal(stored.includes('bad'),false);
  assert.equal(page.url().includes('secret'),false);
  assert.equal(logs.join('\n').includes('secret'),false);
  await page.getByRole('button',{name:'Open navigation'}).click();
  await page.getByRole('button',{name:'Live'}).click();
  assert.match(page.url(),/\/app\/live/);
  await page.goBack();
  await page.getByRole('heading',{name:'Sign in'}).waitFor();
  assert.equal(await page.locator('.sheet-sidebar').count(),0);
  await page.getByRole('button',{name:'Open navigation'}).focus();
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(()=>Boolean(document.querySelector('.sidebar')?.contains(document.activeElement))),false);const menu=page.getByRole('button',{name:'Open navigation'});
  await menu.focus();
  await page.keyboard.press('Enter');
  await page.locator('.sheet-sidebar').waitFor();
  assert.equal(await page.evaluate(()=>document.querySelector('.sheet-sidebar')?.contains(document.activeElement)),true);
  await page.keyboard.press('Escape');
  await page.waitForFunction(()=>!document.querySelector('.sheet-sidebar'));
  assert.equal(await page.locator('.sheet-sidebar').count(),0);
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Open navigation');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Open navigation');
  await page.keyboard.press('Enter');
  await page.locator('.sheet-sidebar').getByRole('button',{name:'Close'}).click();
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Open navigation');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Open navigation');
  await page.keyboard.press('Enter');
  await page.locator('.sheet-sidebar').waitFor();
  assert.equal(await page.evaluate(()=>document.querySelector('.sheet-sidebar')?.contains(document.activeElement)),true);
  await page.getByRole('button',{name:'Assistant'}).click();const dialog=page.getByRole('dialog',{name:'Assistant'});
  await dialog.waitFor();const assistantClose=dialog.getByRole('button',{name:'Close'});assert.equal(await assistantClose.isVisible(),true);assert.equal(await assistantClose.isEnabled(),true);const closeBox=await assistantClose.boundingBox();assert.ok(closeBox&&closeBox.x>=0&&closeBox.y>=0&&closeBox.x+closeBox.width<=390&&closeBox.y+closeBox.height<=844);assert.equal(await page.getByRole('button',{name:'Open navigation'}).count(),0);assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Close');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(()=>document.activeElement?.textContent),'Close');
  await page.keyboard.press('Escape');
  assert.equal(await dialog.count(),0);
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Open navigation');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Open navigation');
  await page.keyboard.press('Enter');
  await page.getByRole('button',{name:'Assistant'}).click();
  await page.getByRole('dialog',{name:'Assistant'}).getByRole('button',{name:'Close'}).click();
  await page.waitForFunction(()=>document.activeElement?.getAttribute('aria-label')==='Open navigation');
  assert.equal(await page.evaluate(()=>document.activeElement?.getAttribute('aria-label')),'Open navigation');
  await page.setViewportSize({width:1440,height:900});
  await page.goto(origin+'/app/settings');
  await page.getByRole('heading',{name:'Settings'}).waitFor();const before=await page.locator('.sidebar').evaluate(e=>e.getBoundingClientRect().width);
  await page.locator('.collapse').click();
  assert.ok(await page.locator('.sidebar').evaluate(e=>e.getBoundingClientRect().width)<before);
  assert.equal(logs.some(x=>/secret|bad|captcha|123456/i.test(x)),false);});
test('Chromium shows restored and expired resident sessions without a login replay',async t=>{for(const [valid,phrase] of [[true,'Connected'],[false,'Sign in']]){const root=fs.mkdtempSync(path.join(os.tmpdir(),'eufy-pw-restore-'));let restoreCalls=0,loginCalls=0;const session={authenticated:valid,state:{phase:valid?'connected':'login_required',devices:[],diagnostics:[],message:valid?'connected':'expired',messageI18n:{key:valid?'service.devices.empty':'service.auth.expired',params:{country:'CA'}}},isAuthenticated(){return this.authenticated},async restore(){restoreCalls++},async login(){loginCalls++},async refresh(){if(valid)throw Object.assign(new Error('expired'),{i18n:{key:'service.auth.expired'}})},fail(error){this.authenticated=false;this.state={phase:'login_required',devices:[],diagnostics:[],message:'expired',messageI18n:error.i18n}},close(){}};const srv=createServer({port:0,session,recordings:{close(){}},outputRoot:root});
  await new Promise(r=>srv.start(r));let b;try{b=await chromium.launch({headless:true});const page=await b.newPage();
  await page.goto(`http://127.0.0.1:${srv.address().port}/app/recordings`);
  await page.getByRole('heading',{name:phrase}).waitFor();
  assert.equal(session.authenticated,valid);
  assert.equal(restoreCalls,1);
  assert.equal(loginCalls,0);
  await page.getByRole('status').getByText(valid?/empty device list/i:/session has expired/i).waitFor();if(valid){await page.getByRole('button',{name:'Refresh inventory'}).click();
  await page.getByRole('heading',{name:'Sign in'}).waitFor();
  await page.getByRole('status').getByText(/session has expired/i).waitFor()}}finally{if(b)await b.close();
  await new Promise(r=>srv.close(r));
  await srv.shutdown();fs.rmSync(root,{recursive:true,force:true})}}});
test('Chromium preserves explicit language, tolerates denied storage, and localizes later reachability failure',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'eufy-pw-pref-'));
  const session={authenticated:false,state:{phase:'login_required',devices:[],diagnostics:[],message:'登录'},close(){}};
  const srv=createServer({port:0,session,recordings:{close(){}},outputRoot:root});
  await new Promise(r=>srv.start(r));const origin=`http://127.0.0.1:${srv.address().port}`;let browser;
  t.after(async()=>{if(browser)await browser.close();await new Promise(r=>srv.close(r));await srv.shutdown();fs.rmSync(root,{recursive:true,force:true})});
  browser=await chromium.launch({headless:true});
  const en=await browser.newContext({locale:'zh-CN'});await en.addInitScript(()=>localStorage.setItem('eufy-agent-hub.language','en'));
  const page=await en.newPage();await page.goto(origin+'/app/recordings');await page.getByRole('heading',{name:'Sign in'}).waitFor();
  assert.equal(await page.getByLabel('Language').inputValue(),'en');assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');
  await page.evaluate(()=>dispatchEvent(new Event('languagechange')));assert.equal(await page.getByLabel('Language').inputValue(),'en');
  await page.reload();assert.equal(await page.getByLabel('Language').inputValue(),'en');
  await page.getByLabel('Language').selectOption('zh-CN');await page.route('**/status',route=>route.abort());
  await page.waitForFunction(()=>document.body.textContent?.includes('无法连接本地服务。'));await en.close();
  const denied=await browser.newContext({locale:'zh-CN'});await denied.addInitScript(()=>Object.defineProperty(window,'localStorage',{get(){throw new Error('denied')}}));
  const deniedPage=await denied.newPage();await deniedPage.goto(origin+'/app/recordings');await deniedPage.getByRole('heading',{name:'登录'}).waitFor();
  assert.equal(await deniedPage.getByLabel('语言').inputValue(),'auto');assert.equal(await deniedPage.evaluate(()=>document.documentElement.lang),'zh-CN');
  assert.equal(await deniedPage.evaluate(()=>document.documentElement.classList.contains('dark')),false);await denied.close();
});
test('Chromium auto preference follows browser languagechange',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'eufy-pw-auto-'));
  const srv=createServer({port:0,session:{authenticated:false,state:{phase:'login_required',devices:[]},close(){}},recordings:{close(){}},outputRoot:root});
  await new Promise(r=>srv.start(r));const origin=`http://127.0.0.1:${srv.address().port}`;let browser;
  t.after(async()=>{if(browser)await browser.close();await new Promise(r=>srv.close(r));await srv.shutdown();fs.rmSync(root,{recursive:true,force:true})});
  browser=await chromium.launch({headless:true});const context=await browser.newContext();
  await context.addInitScript(()=>{Object.defineProperty(window,'__locale',{value:'zh-CN',writable:true});Object.defineProperty(navigator,'languages',{get:()=>[window.__locale],configurable:true});Object.defineProperty(navigator,'language',{get:()=>window.__locale,configurable:true})});
  const page=await context.newPage();await page.goto(origin+'/app/recordings');
  await page.getByRole('heading',{name:'登录'}).waitFor();assert.equal(await page.getByLabel('语言').inputValue(),'auto');assert.equal(await page.evaluate(()=>document.documentElement.lang),'zh-CN');
  await page.evaluate(()=>{window.__locale='en';dispatchEvent(new Event('languagechange'))});
  await page.getByRole('heading',{name:'Sign in'}).waitFor();assert.equal(await page.getByLabel('Language').inputValue(),'auto');assert.equal(await page.evaluate(()=>document.documentElement.lang),'en');
});

test('Chromium task center restores resident jobs, pages with GET, confirms cancellation and reuses a lost retry identity',async t=>{
  const output=path.join(__dirname,'../../output');fs.mkdirSync(output,{recursive:true});const directory=fs.mkdtempSync(path.join(output,'eufy-react-jobs-'));
  const jobsRoot=path.join(directory,'jobs'),window={version:1,input:{day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'},normalized:{start:'2026-08-27T20:30:00.000Z',end:'2026-08-27T20:31:00.000Z',timezone:'America/Toronto'}};
  const seed=new JobService({outputRoot:jobsRoot,worker:async()=>({outcome:'complete',coverageVerified:true,validation:{passed:true}})});
  const old=seed.submit({requestId:'resident-before-restart',homeBaseId:'base',input:{serial:'CAMERA001',window}});await seed.whenIdle();
  fs.writeFileSync(old.metadataPath,JSON.stringify({...JSON.parse(fs.readFileSync(old.metadataPath)),state:'running',stage:'capture',progress:.4,result:null,error:null}));
  let release;const gate=new Promise(resolve=>{release=resolve});const f=await fixture({directory,gate});let browser;t.after(async()=>{release();if(browser)await browser.close();await f.close();fs.rmSync(directory,{recursive:true,force:true})});
  const agent=new RecordingTools({baseUrl:f.url,statePath:path.join(directory,'agent-client.json')}),receipt=await agent.ranges({device:'CAMERA001',day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'});assert.ok(receipt.id);
  const submittedByCli=await cli(['--url',f.url,'--json','recordings','export','--request-id','client-cli','--serial','CAMERA001','--day','2026-08-27','--start','16:30','--end','16:31','--timezone','America/Toronto']);assert.equal(submittedByCli.code,0,submittedByCli.stderr);const first=submittedByCli.value.job;
  const submittedByAgent=await agent.submit({receiptId:receipt.id});const second=submittedByAgent.job;assert.equal(first.state,'queued');assert.equal(second.state,'queued');
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});const methods=[];page.on('request',request=>{const route=new URL(request.url()).pathname;if(route.startsWith('/api/v1/jobs'))methods.push(request.method())});
  await page.goto(f.url+'/app/jobs');await page.getByRole('heading',{name:'Export task center'}).waitFor();await page.getByRole('button',{name:/Inspect task resident-before-restart/}).waitFor();assert.equal(await page.locator('.task-table tbody tr').count(),3);
  assert.equal(f.calls.capture,1);await page.reload();await page.getByRole('button',{name:`Inspect task ${second.requestId}`}).waitFor();assert.equal(await page.locator('.task-table tbody tr').count(),3);assert.equal(f.calls.capture,1,'reload only lists retained tasks');
  const filterStart=methods.length;await page.getByLabel('Rows per page').selectOption('1');await page.getByRole('button',{name:'Apply filters'}).focus();await page.keyboard.press('Enter');await page.getByRole('button',{name:'Next page'}).waitFor();await page.getByRole('button',{name:'Next page'}).focus();await page.keyboard.press('Enter');await page.waitForTimeout(100);
  await page.getByLabel('Rows per page').selectOption('25');await page.getByLabel('State').selectOption('running');await page.getByLabel('Camera serial').fill('CAMERA001');await page.getByRole('button',{name:'Apply filters'}).click();await page.getByRole('button',{name:/Inspect task client-cli/}).waitFor();assert.equal(await page.locator('.task-table tbody tr').count(),1);assert.ok(methods.slice(filterStart).length);assert.ok(methods.slice(filterStart).every(method=>method==='GET'));
  await page.getByLabel('State').selectOption('');await page.getByLabel('Camera serial').fill('');await page.getByRole('button',{name:'Apply filters'}).click();await page.getByRole('button',{name:/Inspect task resident-before-restart/}).focus();await page.keyboard.press('Enter');const details=page.getByRole('region',{name:'Task details'});await details.getByText(/Interrupted.*explicit retry required/).waitFor();
  const retryBodies=[];let drop=true;await page.route('**/api/v1/jobs/*/retry',async route=>{retryBodies.push(JSON.parse(route.request().postData()));if(drop){drop=false;await route.fetch();return route.abort()}return route.continue()});
  await details.getByRole('button',{name:'Retry task'}).focus();await page.keyboard.press('Enter');await details.getByText(/Local service unavailable/).waitFor();await details.getByRole('button',{name:'Retry task'}).click();await page.waitForFunction(()=>document.querySelectorAll('.task-table tbody tr').length===4);assert.equal(retryBodies.length,2);assert.equal(retryBodies[0].requestId,retryBodies[1].requestId);assert.notEqual(retryBodies[0].requestId,old.requestId);
  await page.getByRole('button',{name:/Inspect task client-cli/}).click();await details.getByRole('button',{name:'Cancel task'}).click();await details.getByText(/Stopping.*waiting for cleanup/).waitFor();assert.equal(await details.getByRole('button',{name:'Retry task'}).count(),0);
  release();await details.getByText('Cancelled',{exact:true}).waitFor({timeout:10000});assert.equal(await details.getByRole('button',{name:'Retry task'}).isVisible(),true);assert.equal((await (await fetch(`${f.url}/api/v1/jobs/${old.jobId}`)).json()).job.error.code,'JOB_INTERRUPTED');
  await page.setViewportSize({width:1440,height:900});await page.reload();await page.getByRole('button',{name:`Inspect task ${second.requestId}`}).waitFor();assert.equal(await page.locator('.task-table tbody tr').count(),4);assert.equal(f.calls.capture,3);await page.getByRole('button',{name:`Inspect task ${second.requestId}`}).click();await details.getByText(/Complete.*verified/).first().waitFor();assert.equal(await details.getByRole('button',{name:'Retry task'}).count(),0);await page.getByLabel('Language').selectOption('zh-CN');await page.getByRole('heading',{name:'导出任务中心'}).waitFor();
});

for(const sourceState of ['failed','cancelled'])test(`Chromium task center keeps one linked retry after lost response under the ${sourceState} filter`,async t=>{
  const output=path.join(__dirname,'../../output');fs.mkdirSync(output,{recursive:true});const directory=fs.mkdtempSync(path.join(output,`eufy-react-retry-${sourceState}-`));const jobsRoot=path.join(directory,'jobs');
  const window={version:1,input:{day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'},normalized:{start:'2026-08-27T20:30:00.000Z',end:'2026-08-27T20:31:00.000Z',timezone:'America/Toronto'}};
  const seed=new JobService({outputRoot:jobsRoot,worker:async()=>({outcome:'failed',error:{code:'FIXTURE_FAILED',message:'fixture failure'}})}),source=seed.submit({requestId:`source-${sourceState}`,homeBaseId:'base',input:{serial:'CAMERA001',window}});if(sourceState==='cancelled')seed.cancelQueued(source.jobId);await seed.whenIdle();
  let release;const gate=new Promise(resolve=>{release=resolve});const f=await fixture({directory,gate});let browser;t.after(async()=>{release();if(browser)await browser.close();await f.close();fs.rmSync(directory,{recursive:true,force:true})});browser=await chromium.launch({headless:true});const page=await browser.newPage();
  await page.goto(f.url+'/app/jobs');await page.getByLabel('State').selectOption(sourceState);await page.getByRole('button',{name:'Apply filters'}).click();await page.getByRole('button',{name:`Inspect task source-${sourceState}`}).click();const details=page.getByRole('region',{name:'Task details'}),bodies=[];let drop=true;
  await page.route('**/api/v1/jobs/*/retry',async route=>{bodies.push(JSON.parse(route.request().postData()));if(drop){drop=false;await route.fetch();return route.abort()}return route.continue()});
  await details.getByRole('button',{name:'Retry task'}).click();await details.getByText(/Local service unavailable/).waitFor();await details.getByRole('button',{name:'Retry task'}).click();await page.waitForTimeout(1500);
  const repeated=details.getByRole('button',{name:'Retry task'});if(await repeated.count())await repeated.click();await page.waitForTimeout(200);
  const listed=await (await fetch(f.url+'/api/v1/jobs?pageSize=100')).json(),linked=listed.jobs.filter(job=>job.retryOfJobId===source.jobId);assert.equal(linked.length,1,`one ${sourceState} action must create one linked job`);assert.equal(new Set(linked.map(job=>job.requestId)).size,1);assert.equal(bodies[0].requestId,bodies[1].requestId);assert.equal(await page.getByLabel('State').inputValue(),'');
  await page.reload();await page.getByRole('button',{name:`Inspect task ${linked[0].requestId}`}).waitFor();assert.equal(await page.getByRole('region',{name:'Task details'}).getByRole('button',{name:'Retry task'}).count(),0);assert.equal((await (await fetch(f.url+'/api/v1/jobs?pageSize=100')).json()).jobs.filter(job=>job.retryOfJobId===source.jobId).length,1);
});

test('Chromium task center switches registered media by selected job and preserves one job player while polling',async t=>{
  const f=await fixture();let browser;t.after(async()=>{if(browser)await browser.close();await f.close()});
  const input={serial:'CAMERA001',day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'};
  const submit=async requestId=>{const response=await fetch(f.url+'/api/v1/exports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,...input})});assert.ok(response.ok);return (await response.json()).job};
  const finish=async job=>{while(!['succeeded','failed','cancelled'].includes(job.state)){await new Promise(resolve=>setTimeout(resolve,20));job=(await (await fetch(`${f.url}/api/v1/jobs/${job.jobId}`)).json()).job}return job};
  const first=await finish(await submit('artifact-owner-one')),second=await finish(await submit('artifact-owner-two'));
  const firstArtifact=first.artifacts.find(artifact=>artifact.playable&&artifact.validated),secondArtifact=second.artifacts.find(artifact=>artifact.playable&&artifact.validated);
  assert.ok(firstArtifact);assert.ok(secondArtifact);assert.equal(firstArtifact.id,secondArtifact.id);assert.equal(firstArtifact.name,secondArtifact.name);assert.notEqual(firstArtifact.url,secondArtifact.url);
  browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(f.url+'/app/jobs');
  const details=page.locator('.task-details');await page.getByRole('button',{name:'Inspect task artifact-owner-one'}).click();await details.locator('.job-card h3').filter({hasText:first.jobId}).waitFor();
  const video=details.locator('video'),download=details.locator('.clip a');assert.equal(await video.getAttribute('src'),firstArtifact.url);assert.equal(await download.getAttribute('href'),`${firstArtifact.url}?download`);await video.evaluate(element=>{element.dataset.owner='first'});
  await page.getByRole('button',{name:'Inspect task artifact-owner-two'}).click();await details.locator('.job-card h3').filter({hasText:second.jobId}).waitFor();
  assert.equal(await video.getAttribute('src'),secondArtifact.url);assert.equal(await download.getAttribute('href'),`${secondArtifact.url}?download`);assert.equal(await video.getAttribute('data-owner'),null);
  await video.evaluate(element=>{element.dataset.sameJob='preserved';element.playbackRate=1.5});await page.getByLabel('Language').selectOption('zh-CN');await page.getByRole('heading',{name:'导出任务中心'}).waitFor();await page.waitForTimeout(1400);
  assert.equal(await video.getAttribute('data-same-job'),'preserved');assert.equal(await video.evaluate(element=>element.playbackRate),1.5);assert.equal(await video.getAttribute('src'),secondArtifact.url);assert.equal(await download.getAttribute('href'),`${secondArtifact.url}?download`);
});

test('Chromium task center exposes loading, empty and resident error states',async t=>{
  const f=await fixture();let browser;t.after(async()=>{if(browser)await browser.close();await f.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage();let first=true,fail=false;
  await page.route(url=>new URL(url).pathname==='/api/v1/jobs',async route=>{if(first){first=false;await new Promise(resolve=>setTimeout(resolve,250))}if(fail)return route.abort();return route.continue()});
  await page.goto(f.url+'/app/jobs');await page.getByText('Loading tasks…').waitFor();await page.getByText('No retained export tasks match these filters.').waitFor();fail=true;await page.reload();await page.getByText(/Local service unavailable/).waitFor();
});

test('Chromium recording workbench keeps one durable intent and separates event and continuous results at 390 and 1440',async t=>{
  const output=path.join(__dirname,'../../output');fs.mkdirSync(output,{recursive:true});
  const directory=fs.mkdtempSync(path.join(output,'eufy-react-workbench-'));
  const legacyDirectory=path.join(directory,'CAMERA001_2026-08-27');fs.mkdirSync(legacyDirectory);
  const legacyMedia=path.join(legacyDirectory,'saved.mp4');fs.writeFileSync(legacyMedia,'registered legacy media');
  fs.writeFileSync(path.join(legacyDirectory,'manifest.json'),JSON.stringify({device:'Synthetic camera',serial:'CAMERA001',timezone:'America/Toronto',clips:[{
    file:legacyMedia,bytes:23,start:'2026-08-27T20:30:00.000Z',end:'2026-08-27T20:30:03.000Z',recordId:'saved',timezone:'America/Toronto',coverage:null,
  }]}));
  let eventRows=[{record_id:7,start_time:new Date('2026-08-27T20:30:00.000Z'),end_time:new Date('2026-08-27T20:30:03.000Z')}];
  const eventCalls=[];let eventDownloads=0;
  const recordings={close(){},status:{device:'Synthetic camera'},async listWindow(serial,window){eventCalls.push({serial,window});return eventRows},
    async download(){eventDownloads++;throw new Error('Synthetic event download failure')}};
  const fixtureOptions={directory,recordings,partial:true,delay:1200};const f=await fixture(fixtureOptions);
  let dropExportResponse=true;
  const original=f.server.listeners('request')[0];f.server.removeListener('request',original);
  f.server.on('request',(req,res)=>{
    if(dropExportResponse&&req.method==='POST'&&new URL(req.url,f.url).pathname==='/api/v1/exports'){
      const end=res.end.bind(res);res.end=chunk=>{if(res.statusCode===202){dropExportResponse=false;res.destroy();return res}return end(chunk)};
    }
    return original(req,res);
  });
  let browser;
  t.after(async()=>{if(browser)await browser.close();await f.close();fs.rmSync(directory,{recursive:true,force:true})});
  browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}});
  const submissions=[],rangeRequests=[];page.on('request',request=>{if(request.method()!=='POST')return;const route=new URL(request.url()).pathname;
    if(route==='/api/v1/exports')submissions.push(JSON.parse(request.postData()));if(route.endsWith('/recording-ranges'))rangeRequests.push(JSON.parse(request.postData()))});
  await page.goto(f.url+'/app/recordings');await page.getByRole('heading',{name:'Recording workbench'}).waitFor();
  await page.getByLabel('Exact camera').selectOption('CAMERA001');
  await page.getByLabel('Date').fill('2026-11-01');await page.getByLabel('Start time').fill('01:30');await page.getByLabel('End time').fill('02:00');
  await page.getByRole('button',{name:'Check continuous availability'}).click();await page.getByText(/local time is ambiguous or does not exist/i).waitFor();
  await page.getByLabel('Date').fill('2026-08-27');await page.getByLabel('Start time').fill('16:30');await page.getByLabel('End time').fill('16:31');
  await page.getByLabel('End time').fill('16:00');await page.getByRole('button',{name:'Check continuous availability'}).click();await page.getByText(/Split a cross-midnight request into two same-day windows/).waitFor();await page.getByLabel('End time').fill('16:31');
  const findEvents=page.getByRole('button',{name:'Find event recordings'});await findEvents.focus();await page.keyboard.press('Enter');await page.getByText('1 event recording found.').waitFor();
  assert.equal(eventCalls.length,1);assert.equal(eventCalls[0].serial,'CAMERA001');assert.deepEqual(eventCalls[0].window.input,{day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'});
  assert.match(await page.getByRole('region',{name:'Event recordings',exact:true}).textContent(),/separate from continuous availability/i);
  await page.getByRole('button',{name:'Export this event recording'}).click();await page.getByText('Synthetic event download failure').waitFor();assert.equal(eventDownloads,1);
  eventRows=[];await page.getByRole('button',{name:'Find event recordings'}).click();await page.getByText(/No event recordings.*does not determine continuous/i).waitFor();
  fixtureOptions.offline=true;await page.getByRole('button',{name:'Check continuous availability'}).click();
  await page.getByText(/recording device could not be reached/i).waitFor();fixtureOptions.offline=false;
  await page.getByRole('button',{name:'Retry'}).last().click();
  await page.getByRole('region',{name:'Continuous recording'}).getByText(/Service window:/).waitFor();
  assert.deepEqual(rangeRequests.at(-1),{day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'});
  await page.getByRole('button',{name:'Export requested continuous window'}).click();
  await page.getByRole('button',{name:'Check continuous availability'}).click();await page.getByText(/resident is busy with another operation/i).waitFor();
  await page.getByText('Partial — playable footage is not complete',{exact:true}).waitFor({timeout:15000});
  assert.ok(submissions.length>=1);const firstRequestId=submissions[0].requestId;assert.equal(submissions.every(item=>item.requestId===firstRequestId),true);
  await page.reload();await page.getByRole('heading',{name:'Recording workbench'}).waitFor();
  await page.getByText('Partial — playable footage is not complete',{exact:true}).waitFor({timeout:15000});
  assert.equal(submissions.every(item=>item.requestId===firstRequestId),true);
  let stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('eufy-agent-hub.recording-workbench')));
  assert.equal(stored.intent.requestId,firstRequestId);assert.ok(stored.intent.jobId);assert.deepEqual(stored.jobIds,[stored.intent.jobId]);
  const persistedJob=await (await page.request.get(`${f.url}/api/v1/jobs/${stored.intent.jobId}`)).json();
  assert.equal(persistedJob.job.serial,'CAMERA001');assert.deepEqual(persistedJob.job.window.input,{day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'});
  const recoveryRequests=submissions.length;await page.evaluate(()=>{const state=JSON.parse(localStorage.getItem('eufy-agent-hub.recording-workbench'));delete state.intent.jobId;state.intent.submitted=true;state.jobIds=[];localStorage.setItem('eufy-agent-hub.recording-workbench',JSON.stringify(state))});
  await page.reload();await page.getByText('Partial — playable footage is not complete',{exact:true}).waitFor({timeout:15000});
  assert.equal(submissions.length,recoveryRequests+1);assert.equal(submissions.at(-1).requestId,firstRequestId);stored=await page.evaluate(()=>JSON.parse(localStorage.getItem('eufy-agent-hub.recording-workbench')));assert.ok(stored.intent.jobId);
  const video=page.locator(`[data-job="${stored.intent.jobId}"] video`);await video.waitFor();
  await video.evaluate(element=>{element.dataset.identity='stable-video';Object.defineProperty(element,'currentTime',{value:17,writable:true,configurable:true});window.__workbenchVideo=element});
  await page.getByLabel('Language').selectOption('zh-CN');await page.getByText('部分 — 可播放不等于完整',{exact:true}).waitFor();
  assert.equal(await video.evaluate(element=>element===window.__workbenchVideo&&element.currentTime===17),true);
  await page.getByLabel('结束时间').fill('16:32');await page.getByRole('button',{name:'检查连续录像范围'}).click();
  await page.getByRole('button',{name:'导出请求的连续录像时段'}).click();await page.getByText(/必须明确确认新的导出意图/).waitFor();
  fixtureOptions.partial=false;await page.getByLabel(/我确认设备或时间已更改/).check();await page.getByRole('button',{name:'导出请求的连续录像时段'}).click();
  await page.locator('[data-status]').filter({hasText:'完整 — 覆盖与解码已校验'}).waitFor({timeout:15000});
  assert.notEqual(submissions.at(-1).requestId,firstRequestId);
  const beforeReload=submissions.length;await page.reload();await page.locator('[data-status]').filter({hasText:'完整 — 覆盖与解码已校验'}).waitFor({timeout:15000});
  await page.waitForTimeout(1400);assert.equal(submissions.length,beforeReload,'known terminal jobs are observed, not retried');assert.equal(f.calls.capture,2);
  assert.equal(await page.getByLabel('确切摄像头').evaluate(element=>element.getBoundingClientRect().right<=element.parentElement.getBoundingClientRect().right),true);
  assert.equal(await page.locator('body').evaluate(element=>element.scrollWidth<=element.clientWidth),true);
  await page.setViewportSize({width:1440,height:900});await page.getByRole('heading',{name:'录像工作台'}).waitFor();
  assert.equal(await page.locator('body').evaluate(element=>element.scrollWidth<=element.clientWidth),true);
  const savedHref=await page.getByRole('link',{name:/下载已保存的事件录像/}).getAttribute('href');assert.match(savedHref,/^\/recordings\/media\//);
  const savedResponse=await page.request.get(f.url+savedHref,{headers:{Range:'bytes=0-4'}});assert.equal(savedResponse.status(),206);
  f.expire();await page.getByRole('heading',{name:'登录',exact:true}).waitFor({timeout:5000});
  assert.equal(await page.locator('[data-job]').count(),2);assert.equal(await page.getByRole('link',{name:/下载已保存的事件录像/}).isVisible(),true);
});

test('Chromium recording workbench clears only recovered job polling errors',async t=>{
  const f=await fixture();let browser;t.after(async()=>{if(browser)await browser.close();await f.close()});
  const input={serial:'CAMERA001',day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'};
  const submit=async requestId=>{const response=await fetch(f.url+'/api/v1/exports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,...input})});assert.ok(response.ok);return (await response.json()).job};
  const finish=async job=>{while(!['succeeded','failed','cancelled'].includes(job.state)){await new Promise(resolve=>setTimeout(resolve,20));job=(await (await fetch(`${f.url}/api/v1/jobs/${job.jobId}`)).json()).job}return job};
  const first=await finish(await submit('poll-recovery-one')),second=await finish(await submit('poll-recovery-two'));
  browser=await chromium.launch({headless:true});const page=await browser.newPage();
  await page.addInitScript(({input,first,second})=>localStorage.setItem('eufy-agent-hub.recording-workbench',JSON.stringify({version:1,intent:{requestId:first.requestId,input,submitted:true,jobId:first.jobId},jobIds:[first.jobId,second.jobId]})),{input,first,second});
  let failFirst=true,failSecond=false,secondFailures=0;
  await page.route('**/api/v1/jobs/*',route=>{const id=new URL(route.request().url()).pathname.split('/').at(-1);if(id===first.jobId&&failFirst){failFirst=false;return route.abort()}if(id===second.jobId&&failSecond){secondFailures++;return route.abort()}return route.continue()});
  await page.goto(f.url+'/app/recordings');await page.getByText(/Local service unavailable/).waitFor();
  await page.locator(`[data-job="${first.jobId}"]`).waitFor();await page.waitForFunction(()=>!document.body.textContent.includes('Local service unavailable'));
  assert.equal(await page.locator('[data-job]').count(),2);
  failSecond=true;await page.getByText(/Local service unavailable/).waitFor();await page.waitForTimeout(1400);
  assert.ok(secondFailures>=1);assert.equal(await page.getByText(/Local service unavailable/).count(),1,'another job success must not clear an unresolved polling error');
  failSecond=false;await page.waitForFunction(()=>!document.body.textContent.includes('Local service unavailable'));assert.equal(await page.locator('[data-job]').count(),2);
  await page.getByLabel('End time').fill('16:32');await page.getByRole('button',{name:'Check continuous availability'}).click();await page.getByRole('button',{name:'Export requested continuous window'}).click();
  await page.getByText(/must explicitly confirm a new export intent/i).waitFor();await page.waitForTimeout(1400);assert.equal(await page.getByText(/must explicitly confirm a new export intent/i).count(),1,'successful polling must preserve submission errors');
});

test('Chromium recording workbench retries definite export rejection only after an explicit action',async t=>{
  const f=await fixture();let browser;t.after(async()=>{if(browser)await browser.close();await f.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage();
  let reject=true;const posts=[];await page.route('**/api/v1/exports',route=>{posts.push(JSON.parse(route.request().postData()));return reject?route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'SERVICE_BUSY',message:'The resident is busy with another operation'}})}):route.continue()});
  await page.goto(f.url+'/app/recordings');await page.getByLabel('Date').fill('2026-08-27');await page.getByLabel('Start time').fill('16:30');await page.getByLabel('End time').fill('16:31');
  await page.getByRole('button',{name:'Check continuous availability'}).click();await page.getByRole('button',{name:'Export requested continuous window'}).click();await page.getByText(/resident is busy with another operation/i).waitFor();
  const rejected=await page.evaluate(()=>JSON.parse(localStorage.getItem('eufy-agent-hub.recording-workbench')));assert.equal(rejected.intent.submitted,false);const requestId=rejected.intent.requestId;
  reject=false;await page.reload();await page.getByRole('heading',{name:'Recording workbench'}).waitFor();await page.waitForTimeout(1500);assert.equal(posts.length,1,'reload must not resubmit a definite rejection');
  await page.getByRole('button',{name:'Check continuous availability'}).click();await page.getByRole('button',{name:'Export requested continuous window'}).click();await page.locator('[data-job]').waitFor();
  assert.equal(posts.length,2);assert.equal(posts[1].requestId,requestId);assert.equal(f.calls.capture,1);
});

test('Chromium recording workbench serializes each job poll while other jobs continue',async t=>{
  const f=await fixture();let browser;t.after(async()=>{if(browser)await browser.close();await f.close()});
  const input={serial:'CAMERA001',day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'};
  const submit=async requestId=>{const response=await fetch(f.url+'/api/v1/exports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,...input})});return (await response.json()).job};
  const finish=async job=>{while(!['succeeded','failed','cancelled'].includes(job.state)){await new Promise(resolve=>setTimeout(resolve,20));job=(await (await fetch(`${f.url}/api/v1/jobs/${job.jobId}`)).json()).job}return job};
  const first=await finish(await submit('serialized-one')),second=await finish(await submit('serialized-two'));
  browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.addInitScript(({input,first,second})=>localStorage.setItem('eufy-agent-hub.recording-workbench',JSON.stringify({version:1,intent:{requestId:first.requestId,input,submitted:true,jobId:first.jobId},jobIds:[first.jobId,second.jobId]})),{input,first,second});
  let releaseFailure,releaseSuccess;const failureGate=new Promise(resolve=>{releaseFailure=resolve}),successGate=new Promise(resolve=>{releaseSuccess=resolve});let mode='hold-failure',firstCalls=0,secondCalls=0;
  await page.route('**/api/v1/jobs/*',async route=>{const id=new URL(route.request().url()).pathname.split('/').at(-1);if(id===second.jobId){secondCalls++;return route.continue()}if(id!==first.jobId)return route.continue();firstCalls++;
    if(mode==='hold-failure'){mode='steady';await failureGate;return route.abort()}if(mode==='hold-success'){mode='fail';await successGate;return route.continue()}if(mode==='fail')return route.abort();return route.continue()});
  await page.goto(f.url+'/app/recordings');await page.waitForTimeout(1500);assert.equal(firstCalls,1,'overlapping callers must share the first in-flight job request');assert.ok(secondCalls>=2,'another job must continue polling independently');
  releaseFailure();await page.getByText(/Local service unavailable/).waitFor();await page.waitForFunction(()=>!document.body.textContent.includes('Local service unavailable'));await page.locator(`[data-job="${first.jobId}"]`).waitFor();
  mode='hold-success';for(let count=0;mode==='hold-success'&&count<100;count++)await new Promise(resolve=>setTimeout(resolve,20));assert.equal(mode,'fail');const heldCalls=firstCalls;await page.waitForTimeout(1400);assert.equal(firstCalls,heldCalls,'a delayed success must remain the only in-flight read for its job');
  releaseSuccess();await page.getByText(/Local service unavailable/).waitFor();await page.waitForTimeout(1400);assert.equal(await page.getByText(/Local service unavailable/).count(),1);assert.equal(await page.locator(`[data-job="${first.jobId}"]`).count(),1);
  mode='steady';await page.waitForFunction(()=>!document.body.textContent.includes('Local service unavailable'));
});

test('Chromium recording workbench explicitly refreshes an existing intent error',async t=>{
  const f=await fixture();let browser;t.after(async()=>{if(browser)await browser.close();await f.close()});const input={serial:'CAMERA001',day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'};
  const response=await fetch(f.url+'/api/v1/exports',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId:'explicit-refresh',...input})}),job=(await response.json()).job;
  browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.addInitScript(({input,job})=>localStorage.setItem('eufy-agent-hub.recording-workbench',JSON.stringify({version:1,intent:{requestId:job.requestId,input,submitted:true,jobId:job.jobId},jobIds:[job.jobId]})),{input,job});
  let failJob=false,posts=0;page.on('request',request=>{if(request.method()==='POST'&&new URL(request.url()).pathname==='/api/v1/exports')posts++});await page.route('**/api/v1/jobs/*',route=>failJob?route.abort():route.continue());
  await page.goto(f.url+'/app/recordings');await page.locator(`[data-job="${job.jobId}"]`).waitFor();await page.getByLabel('End time').fill('16:32');await page.getByRole('button',{name:'Check continuous availability'}).click();await page.getByRole('button',{name:'Export requested continuous window'}).click();
  await page.getByText(/must explicitly confirm a new export intent/i).waitFor();await page.waitForTimeout(1400);assert.equal(await page.getByText(/must explicitly confirm a new export intent/i).count(),1,'background polls must preserve submission errors');
  await page.getByLabel('End time').fill('16:31');await page.getByRole('button',{name:'Check continuous availability'}).click();failJob=true;await page.getByText(/Local service unavailable/).waitFor();await page.getByRole('button',{name:'Export requested continuous window'}).click();
  assert.equal(await page.getByText(/already has a durable export task/i).count(),0,'a failed explicit refresh must not claim success');assert.equal(await page.getByText(/must explicitly confirm a new export intent/i).count(),1);
  failJob=false;await page.getByRole('button',{name:'Export requested continuous window'}).click();await page.getByText(/already has a durable export task/i).waitFor();
  assert.equal(await page.getByText(/must explicitly confirm a new export intent/i).count(),0);assert.equal(posts,0,'an existing-intent refresh must not submit another export');
});

test('Chromium recording workbench distinguishes ambiguous, missing and failed device discovery',async t=>{
  let browser;const owned=[];t.after(async()=>{if(browser)await browser.close();for(const f of owned)await f.close()});browser=await chromium.launch({headless:true});
  const ambiguous=await fixture({devices:[{device_sn:'CAMERA001',device_name:'Repeated'},{device_sn:'CAMERA002',device_name:'Repeated'}]});owned.push(ambiguous);
  const page=await browser.newPage();await page.goto(ambiguous.url+'/app/recordings');await page.getByText(/Choose one exact camera/).waitFor();
  const read=ambiguous.session.api.getDevsListDecrypted.bind(ambiguous.session.api);ambiguous.session.api.getDevsListDecrypted=async()=>{throw new Error('fixture discovery failure')};
  await page.getByRole('button',{name:'Retry'}).click();await page.getByText(/Device discovery failed or is incomplete/).waitFor();
  ambiguous.session.api.getDevsListDecrypted=read;await page.getByRole('button',{name:'Retry'}).click();await page.getByText(/account completeness is unknown/).waitFor();
  const missing=await fixture({devices:[]});owned.push(missing);const empty=await browser.newPage();await empty.goto(missing.url+'/app/recordings');
  await empty.getByText(/No recording camera was returned/).waitFor();
});

test('Chromium recording workbench reports empty devices only after an authenticated successful load',async t=>{
  let browser;const owned=[];t.after(async()=>{if(browser)await browser.close();for(const f of owned)await f.close()});browser=await chromium.launch({headless:true});
  const signedOut=await fixture({loggedOut:true,devices:[]});owned.push(signedOut);const loggedOut=await browser.newPage();await loggedOut.goto(signedOut.url+'/app/recordings');
  await loggedOut.getByRole('heading',{name:'Sign in'}).waitFor();assert.equal(await loggedOut.getByText(/No recording camera was returned/).count(),0);
  const missing=await fixture({devices:[]});owned.push(missing);const page=await browser.newPage();await page.addInitScript(()=>localStorage.setItem('eufy-agent-hub.recording-workbench',JSON.stringify({version:1,intent:{requestId:'recording-known',input:{serial:'CAMERA001',day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'},submitted:true,jobId:'known'},jobIds:[]})));
  await page.goto(missing.url+'/app/recordings');await page.getByText(/selected camera is no longer in the resident inventory/i).waitFor();
  assert.equal(await page.getByText(/No recording camera was returned/).count(),0);
});

test('Chromium recording workbench invalidates a stale device after discovery failure and restores it on retry',async t=>{
  const f=await fixture();let browser;t.after(async()=>{if(browser)await browser.close();await f.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage();
  await page.goto(f.url+'/app/recordings');await page.getByText(/Synthetic camera · CAMERA001 · HomeBase/).waitFor();
  const read=f.session.api.getDevsListDecrypted.bind(f.session.api);f.session.api.getDevsListDecrypted=async()=>{throw new Error('fixture discovery failure')};
  await page.getByRole('button',{name:'Retry'}).click();await page.getByText(/Device discovery failed or is incomplete/).waitFor();
  assert.equal(await page.getByText(/Synthetic camera · CAMERA001 · HomeBase/).count(),0);
  assert.equal(await page.getByRole('button',{name:'Find event recordings'}).isDisabled(),true);
  assert.equal(await page.getByRole('button',{name:'Check continuous availability'}).isDisabled(),true);
  f.session.api.getDevsListDecrypted=read;await page.getByRole('button',{name:'Retry'}).click();await page.getByText(/account completeness is unknown/).waitFor();
  await page.getByText(/Synthetic camera · CAMERA001 · HomeBase/).waitFor();assert.equal(await page.getByRole('button',{name:'Check continuous availability'}).isEnabled(),true);
});

test('Chromium recording workbench invalidates a stale range after same-window failure and restores it on retry',async t=>{
  const options={};const f=await fixture(options);let browser;t.after(async()=>{if(browser)await browser.close();await f.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage();
  await page.goto(f.url+'/app/recordings');await page.getByText(/Synthetic camera · CAMERA001 · HomeBase/).waitFor();
  await page.getByLabel('Date').fill('2026-08-27');await page.getByLabel('Start time').fill('16:30');await page.getByLabel('End time').fill('16:31');
  const region=page.getByRole('region',{name:'Continuous recording'});await region.getByRole('button',{name:'Check continuous availability'}).click();await region.getByText(/Service window:/).waitFor();
  options.offline=true;await region.getByRole('button',{name:'Check continuous availability'}).click();await region.getByText(/recording device could not be reached/i).waitFor();
  assert.equal(await region.getByText(/Service window:/).count(),0);assert.equal(await region.getByRole('button',{name:'Export requested continuous window'}).count(),0);
  options.offline=false;await region.getByRole('button',{name:'Retry'}).click();await region.getByText(/Service window:/).waitFor();assert.equal(await region.getByRole('button',{name:'Export requested continuous window'}).isEnabled(),true);
});

test('Chromium recording workbench binds event results to the confirmed device and window',async t=>{
  const calls=[],recordings={close(){},status:{device:'Synthetic camera'},async listWindow(serial,window){calls.push({serial,window});return [{record_id:calls.length,start_time:new Date('2026-08-27T20:30:00.000Z'),end_time:new Date('2026-08-27T20:30:03.000Z')}]},async download(){throw new Error('Synthetic event download failure')}};
  const f=await fixture({devices:[{device_sn:'CAMERA001',device_name:'Camera A'},{device_sn:'CAMERA002',device_name:'Camera B'}],recordings});let browser;
  t.after(async()=>{if(browser)await browser.close();await f.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(f.url+'/app/recordings');
  const region=page.getByRole('region',{name:'Event recordings',exact:true});await page.getByLabel('Exact camera').selectOption('CAMERA001');
  await page.getByLabel('Date').fill('2026-08-27');await page.getByLabel('Start time').fill('16:30');await page.getByLabel('End time').fill('16:31');
  await region.getByRole('button',{name:'Find event recordings'}).click();await region.getByText('1 event recording found.').waitFor();
  await region.getByRole('button',{name:'Export this event recording'}).click();await region.getByText('Synthetic event download failure').waitFor();assert.equal(await region.getByRole('button',{name:'Export this event recording'}).count(),1);
  await page.getByLabel('Exact camera').selectOption('CAMERA002');await region.getByText(/query event recordings again/i).waitFor();
  assert.equal(await region.getByRole('button',{name:'Export this event recording'}).count(),0);assert.equal(await region.getByText('1 event recording found.').count(),0);
  await region.getByRole('button',{name:'Find event recordings'}).click();await region.getByText('1 event recording found.').waitFor();assert.equal(calls.at(-1).serial,'CAMERA002');
  await page.getByLabel('End time').fill('16:32');await region.getByText(/query event recordings again/i).waitFor();assert.equal(await region.getByRole('button',{name:'Export this event recording'}).count(),0);
  await region.getByRole('button',{name:'Find event recordings'}).click();await region.getByText('1 event recording found.').waitFor();assert.equal(calls.at(-1).window.input.end,'16:32');
  const read=f.session.api.getDevsListDecrypted.bind(f.session.api);f.session.api.getDevsListDecrypted=async()=>{throw new Error('fixture discovery failure')};
  await page.getByRole('button',{name:'Retry'}).click();await page.getByText(/Device discovery failed or is incomplete/).waitFor();await region.getByText(/query event recordings again/i).waitFor();assert.equal(await region.getByRole('button',{name:'Export this event recording'}).count(),0);
  f.session.api.getDevsListDecrypted=read;await page.getByRole('button',{name:'Retry'}).click();await page.getByText(/Camera B · CAMERA002 · HomeBase/).waitFor();
  await region.getByRole('button',{name:'Find event recordings'}).click();await region.getByText('1 event recording found.').waitFor();
  f.expire();await page.getByRole('heading',{name:'Sign in',exact:true}).waitFor({timeout:5000});await region.getByText(/query event recordings again/i).waitFor();assert.equal(await region.getByRole('button',{name:'Export this event recording'}).count(),0);
});

test('Chromium recording workbench does not turn an asynchronous event failure into a confirmed empty result',async t=>{
  let failing=true;const recordings={close(){},status:{device:'Synthetic camera'},async listWindow(){if(failing)throw new Error('Synthetic async event failure');return []},async download(){}};
  const f=await fixture({recordings});let browser;t.after(async()=>{if(browser)await browser.close();await f.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(f.url+'/app/recordings');
  const region=page.getByRole('region',{name:'Event recordings',exact:true});await page.getByLabel('Date').fill('2026-08-27');await page.getByLabel('Start time').fill('16:30');await page.getByLabel('End time').fill('16:31');
  await region.getByRole('button',{name:'Find event recordings'}).click();await region.getByText('Synthetic async event failure').waitFor();
  assert.equal(await region.getByText(/No event recordings in this window/).count(),0);assert.equal(await region.getByRole('button',{name:'Find event recordings'}).isEnabled(),true);
  failing=false;await region.getByRole('button',{name:'Find event recordings'}).click();await region.getByText(/No event recordings in this window/).waitFor();
});

test('Chromium recording workbench keeps an overdue event query busy until a confirmed empty result arrives',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve});const recordings={close(){},status:{device:'Synthetic camera'},async listWindow(){await gate;return []},async download(){}};
  const f=await fixture({recordings});let browser;t.after(async()=>{release();if(browser)await browser.close();await f.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(f.url+'/app/recordings');
  const region=page.getByRole('region',{name:'Event recordings',exact:true});await page.getByLabel('Date').fill('2026-08-27');await page.getByLabel('Start time').fill('16:30');await page.getByLabel('End time').fill('16:31');
  await region.getByRole('button',{name:'Find event recordings'}).click();await region.getByRole('button',{name:'Find event recordings'}).waitFor({timeout:12000});
  try{assert.equal(await region.getByText(/No event recordings in this window/).count(),0)}finally{release()}
  await region.getByText(/No event recordings in this window/).waitFor({timeout:5000});
});

test('Chromium recording workbench rejects a stale same-id event row across two local pages',async t=>{
  let activeSerial;const downloads=[];const recordings={close(){},status:{device:'Synthetic camera'},
    async listWindow(serial){activeSerial=serial;return [{record_id:7,start_time:new Date('2026-08-27T20:30:00.000Z'),end_time:new Date('2026-08-27T20:31:00.000Z')}]},
    async download(){downloads.push(activeSerial);throw new Error(`Synthetic download ${activeSerial}`)}};
  const f=await fixture({devices:[{device_sn:'CAMERA001',device_name:'Camera A'},{device_sn:'CAMERA002',device_name:'Camera B'}],recordings});let browser;
  t.after(async()=>{if(browser)await browser.close();await f.close()});browser=await chromium.launch({headless:true});const pageA=await browser.newPage(),pageB=await browser.newPage();
  const prepare=async(page,serial)=>{await page.goto(f.url+'/app/recordings');await page.getByLabel('Exact camera').selectOption(serial);await page.getByLabel('Date').fill('2026-08-27');await page.getByLabel('Start time').fill('16:30');await page.getByLabel('End time').fill('16:31')};
  await prepare(pageA,'CAMERA001');const regionA=pageA.getByRole('region',{name:'Event recordings',exact:true});await regionA.getByRole('button',{name:'Find event recordings'}).click();await regionA.getByText('1 event recording found.').waitFor();
  const aStatus=await (await pageA.request.get(f.url+'/recordings/status')).json();await pageA.route('**/recordings/status',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(aStatus)}));
  await prepare(pageB,'CAMERA002');const regionB=pageB.getByRole('region',{name:'Event recordings',exact:true});await regionB.getByRole('button',{name:'Find event recordings'}).click();await regionB.getByText('1 event recording found.').waitFor();
  const rejected=pageA.waitForResponse(response=>new URL(response.url()).pathname==='/recordings/download'&&response.request().method()==='POST');
  await regionA.getByRole('button',{name:'Export this event recording'}).click();assert.equal((await rejected).status(),409);assert.deepEqual(downloads,[]);
  await regionA.getByText(/Query recordings for this device first/i).waitFor();
  await pageA.unroute('**/recordings/status');await regionA.getByRole('button',{name:'Find event recordings'}).click();await regionA.getByText('1 event recording found.').waitFor();
  await regionA.getByRole('button',{name:'Export this event recording'}).click();await regionA.getByText('Synthetic download CAMERA001').waitFor();assert.deepEqual(downloads,['CAMERA001']);
});
