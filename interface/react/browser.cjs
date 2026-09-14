const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {chromium}=require('@playwright/test'); const {createServer}=require('../server.cjs');
const {fixture}=require('../agent/fixture.cjs');
const {JobService}=require('../../jobs/service.cjs');
const {RecordingTools}=require('../../agent/tools.cjs');
const {cli}=require('../../cli/test-helper.cjs');
const {ScriptedModel,functionCall,assistantMessage,modelResponder}=require('@openai/agents/testing');
const {spawnSync}=require('node:child_process');
const {EventEmitter}=require('node:events');
const {window:agentWindow}=require('../agent/fixture.cjs');
const agentCall=(name,args,id=name)=>[functionCall(name,args,{callId:id})];
const lastAgentOutput=request=>{const result=request.input.filter(item=>item.type==='function_call_result').at(-1);return JSON.parse(typeof result.output==='string'?result.output:result.output.text)};
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

test('Chromium assistant-ui restores origin preferences and shares one registered job and player without poll side effects',async t=>{
  const output=path.join(__dirname,'../../output');fs.mkdirSync(output,{recursive:true});const directory=fs.mkdtempSync(path.join(output,'eufy-react-assistant-')),normalizedWindow={version:1,input:{day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'},normalized:{start:'2026-08-27T20:30:00.000Z',end:'2026-08-27T20:31:00.000Z',timezone:'America/Toronto'}};
  const seeded=new JobService({outputRoot:path.join(directory,'jobs'),worker:async({artifactsDir,registerArtifact})=>{fs.writeFileSync(path.join(artifactsDir,'video.mp4'),'registered synthetic media');registerArtifact('artifacts/video.mp4');return {outcome:'partial',media:{path:'artifacts/video.mp4',playable:true},validation:{passed:true},coverage:{requestedMs:60000,coveredMs:3000}}}}),playerJob=seeded.submit({requestId:'registered-player',homeBaseId:'base',input:{serial:'CAMERA001',window:normalizedWindow}});await seeded.whenIdle();
  let receiptId,jobId;const view=value=>({type:'',deviceIds:null,receiptId:null,jobId:null,artifactId:null,...value});
  const model=new ScriptedModel([
    agentCall('recording_ranges',agentWindow),modelResponder(({request})=>{receiptId=lastAgentOutput(request).id;return agentCall('recording_export',{receiptId})}),
    modelResponder(({request})=>{jobId=lastAgentOutput(request).job.jobId;return agentCall('workspace_present',{version:1,views:[view({type:'job-card',jobId}),view({type:'timeline',receiptId}),view({type:'device-list',deviceIds:['CAMERA001']})]})}),[assistantMessage('Synthetic workspace composed.')],
    modelResponder(()=>agentCall('job_artifacts',{jobId:playerJob.jobId})),modelResponder(({request})=>agentCall('workspace_present',{version:1,views:[view({type:'player',jobId:playerJob.jobId,artifactId:lastAgentOutput(request).videos[0].id}),view({type:'job-card',jobId}),view({type:'timeline',receiptId}),view({type:'device-list',deviceIds:['CAMERA001']})]})),[assistantMessage('Synthetic registered player is ready.')],
    agentCall('recording_ranges',{...agentWindow,device:'Repeated'}),[assistantMessage('Choose one camera serial before exporting.')],
  ]);
  const f=await fixture({model,partial:true,directory});let browser;t.after(async()=>{if(browser)await browser.close();await f.close();fs.rmSync(directory,{recursive:true,force:true})});browser=await chromium.launch({headless:true});const page=await browser.newPage({viewport:{width:390,height:844}}),requests=[];
  page.on('request',request=>{const route=new URL(request.url()).pathname;if(route.startsWith('/interface/agent/'))requests.push({route,method:request.method()})});
  await page.addInitScript(()=>{localStorage.setItem('eufy-agent-hub.language','en');localStorage.setItem('eufy-agent-hub.responseLocale','zh-CN');localStorage.setItem('eufy-agent-hub.draft','Export Synthetic camera on 2026-08-27 from 16:30 to 16:31 America/Toronto')});
  await page.goto(f.url+'/app/recordings');await page.getByRole('button',{name:'Open navigation'}).click();await page.getByRole('button',{name:'Assistant'}).click();const dialog=page.getByRole('dialog',{name:'Assistant'}),composer=dialog.getByLabel('Recording request');
  await dialog.waitFor();assert.equal(await dialog.getByLabel('Response language').inputValue(),'zh-CN');assert.match(await composer.inputValue(),/Export Synthetic camera/);await dialog.getByRole('button',{name:'Send'}).click();await dialog.getByText('Synthetic workspace composed.').waitFor({timeout:10000});assert.equal((await (await fetch(f.url+'/interface/agent/state')).json()).turns[0].locale,'zh-CN');
  let job;for(let count=0;count<100;count++){job=(await (await fetch(`${f.url}/api/v1/jobs/${jobId}`)).json()).job;if(['succeeded','failed','cancelled'].includes(job.state))break;await new Promise(resolve=>setTimeout(resolve,20))}assert.ok(job.jobId);
  await composer.fill('Show the registered player.');await dialog.getByRole('button',{name:'Send'}).click();await dialog.getByText('Synthetic registered player is ready.').waitFor();await dialog.getByRole('button',{name:'Close'}).click();
  const player=page.locator('[data-type="player"] video');await player.waitFor();await player.evaluate(element=>{element.dataset.identity='registered-player';element.currentTime=1.25});const playerView=page.locator('[data-type="player"]');await playerView.getByRole('button',{name:'Pin'}).click();await page.locator('[data-type="job-card"]').getByRole('button',{name:'Pin'}).click();await playerView.getByRole('button',{name:'Move down'}).click();const layout=await page.evaluate(()=>({viewport:document.documentElement.clientWidth,scrollWidth:document.documentElement.scrollWidth,headerClientWidth:document.querySelector('header').clientWidth,headerScrollWidth:document.querySelector('header').scrollWidth,workspace:[...document.querySelectorAll('#workspace-views .workspace-view')].map(element=>({type:element.dataset.type,right:element.getBoundingClientRect().right,width:element.getBoundingClientRect().width,scrollWidth:element.scrollWidth,clientWidth:element.clientWidth}))}));assert.equal(layout.headerScrollWidth<=layout.headerClientWidth,true,JSON.stringify(layout));assert.equal(layout.scrollWidth<=layout.viewport,true,JSON.stringify(layout));
  await page.getByLabel('Language').selectOption('zh-CN');await page.waitForTimeout(1700);assert.equal(await player.getAttribute('data-identity'),'registered-player');assert.equal(await player.evaluate(element=>element.currentTime),1.25);
  await page.getByRole('button',{name:'打开导航'}).click();await page.getByRole('button',{name:'助手'}).click();const zhDialog=page.getByRole('dialog',{name:'助手'});await zhDialog.getByText('Synthetic registered player is ready.').waitFor();assert.equal(await player.getAttribute('data-identity'),'registered-player');assert.equal(await player.evaluate(element=>element.currentTime),1.25);await zhDialog.getByLabel('录像请求').fill('Repeated camera 2026-08-27 16:30 to 16:31');await zhDialog.getByRole('button',{name:'发送'}).click();await zhDialog.getByText('Choose one camera serial before exporting.').waitFor();assert.equal(f.calls.capture,1);
  const before=model.calls.length;await zhDialog.getByRole('button',{name:'关闭'}).click();assert.equal(await player.getAttribute('data-identity'),'registered-player');assert.equal(await player.evaluate(element=>element.currentTime),1.25);const order=await page.locator('#workspace-views .workspace-view').evaluateAll(nodes=>nodes.map(node=>node.dataset.view));await page.reload();await page.locator('[data-type="player"] button[aria-pressed="true"]').waitFor();await page.waitForFunction(expected=>JSON.stringify([...document.querySelectorAll('#workspace-views .workspace-view')].map(node=>node.dataset.view))===JSON.stringify(expected),order);assert.deepEqual(await page.locator('#workspace-views .workspace-view').evaluateAll(nodes=>nodes.map(node=>node.dataset.view)),order);await page.waitForTimeout(1700);assert.equal(model.calls.length,before);assert.equal(f.calls.capture,1);assert.equal(requests.filter(item=>item.route==='/interface/agent/export').length,0);assert.ok(requests.filter(item=>item.route==='/interface/agent/state').every(item=>item.method==='GET'));
  await page.setViewportSize({width:1440,height:900});await page.getByRole('button',{name:/Assistant|助手/}).click();const restoredDialog=page.getByRole('dialog',{name:/Assistant|助手/});assert.equal(await restoredDialog.getByLabel(/Response language|回复语言/).inputValue(),'zh-CN');assert.equal((await (await fetch(f.url+'/interface/agent/state')).json()).turns.length,3);
  await page.goto(f.url+'/app/jobs');await page.getByRole('button',{name:new RegExp(`(?:Inspect task|查看任务) ${job.requestId}`)}).waitFor();assert.equal((await (await fetch(`${f.url}/api/v1/jobs/${jobId}`)).json()).job.requestId,job.requestId);
});

test('Chromium assistant-ui recovers a lost accepted reply, rejects TURN_BUSY, and keeps accepted work after model failure',async t=>{
  let release;const gate=new Promise(resolve=>{release=resolve});let receiptId,jobId;
  const model=new ScriptedModel([modelResponder(async()=>{await gate;return agentCall('recording_ranges',agentWindow)}),modelResponder(({request})=>{receiptId=lastAgentOutput(request).id;return agentCall('recording_export',{receiptId})}),modelResponder(({request})=>{jobId=lastAgentOutput(request).job.jobId;throw new Error('Synthetic model failure after acceptance')})]);
  const f=await fixture({model,delay:100});let browser;t.after(async()=>{release();if(browser)await browser.close();await f.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage();let drop=true;const bodies=[];
  await page.route('**/interface/agent/turn',async route=>{const body=JSON.parse(route.request().postData()||'{}');bodies.push(body);if(drop&&body.id!=='busy-probe'){drop=false;await route.fetch();return route.abort()}return route.continue()});
  await page.goto(f.url+'/app/recordings');await page.getByRole('button',{name:'Assistant'}).click();const dialog=page.getByRole('dialog',{name:'Assistant'}),composer=dialog.getByLabel('Recording request');await composer.fill('Export Synthetic camera on 2026-08-27 from 16:30 to 16:31 America/Toronto');
  await dialog.getByRole('button',{name:'Send'}).evaluate(button=>{button.click();button.click()});await dialog.getByText(/Assistant is working/).waitFor();assert.equal(await dialog.getByRole('button',{name:'Send'}).isDisabled(),true);
  const busy=await page.evaluate(async()=>{const response=await fetch('/interface/agent/turn',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:'busy-probe',text:'another request',locale:'en'})});return {status:response.status,body:await response.json()}});assert.equal(busy.status,409);assert.equal(busy.body.error.code,'TURN_BUSY');release();
  await dialog.getByText(/assistant could not finish this turn/i).waitFor({timeout:10000});await page.locator(`[data-job="${jobId}"]`).waitFor();const state=await (await fetch(f.url+'/interface/agent/state')).json();assert.equal(state.turns.length,1);assert.equal(state.jobs.filter(view=>view.job?.jobId===jobId).length,1);assert.equal(bodies.filter(body=>body.id!=='busy-probe').length,1);
  const calls=model.calls.length;await page.reload();await page.waitForTimeout(1700);assert.equal(model.calls.length,calls);assert.equal((await (await fetch(f.url+'/interface/agent/state')).json()).turns.length,1);await page.getByRole('button',{name:'Assistant'}).click();const restored=page.getByRole('dialog',{name:'Assistant'});await restored.getByText(/assistant could not finish this turn/i).waitFor();
  assert.equal(await restored.getByRole('button',{name:/edit|regenerate|cancel/i}).count(),0);assert.ok(receiptId);assert.ok(jobId);
});

test('Chromium assistant workspace exposes loading, empty, disconnect, and recovery while manual browsing stays available',async t=>{
  const f=await fixture({model:new ScriptedModel([])});let browser;t.after(async()=>{if(browser)await browser.close();await f.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage();let first=true,fail=false;
  await page.route('**/interface/agent/state*',async route=>{if(first){first=false;await new Promise(resolve=>setTimeout(resolve,250))}if(fail)return route.abort();return route.continue()});await page.goto(f.url+'/app/recordings');await page.getByText('Loading the resident conversation…').first().waitFor();await page.getByRole('button',{name:'Assistant'}).click();const dialog=page.getByRole('dialog',{name:'Assistant'});await dialog.getByText(/Ask for a camera, calendar date and time range/).waitFor();
  fail=true;await dialog.getByRole('button',{name:'Retry connection'}).waitFor({timeout:5000});assert.equal(await page.locator('#recording-workbench-title').count(),1);
  fail=false;await dialog.getByRole('button',{name:'Retry connection'}).click();await dialog.getByRole('button',{name:'Retry connection'}).waitFor({state:'detached'});assert.equal(await dialog.getByRole('button',{name:'Browse recordings'}).isEnabled(),true);
});

function h264AccessUnits(ffmpeg){
  const encoded=spawnSync(ffmpeg,['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=96x54:rate=5:duration=10','-an','-c:v','libx264','-preset','ultrafast','-tune','zerolatency','-x264-params','aud=1:repeat-headers=1:keyint=1:min-keyint=1:scenecut=0','-f','h264','pipe:1'],{windowsHide:true,maxBuffer:8*1024*1024});
  assert.equal(encoded.status,0,encoded.stderr?.toString());const bytes=encoded.stdout,starts=[];
  for(let i=0;i+5<bytes.length;i++){const size=bytes[i]===0&&bytes[i+1]===0&&bytes[i+2]===1?3:bytes[i]===0&&bytes[i+1]===0&&bytes[i+2]===0&&bytes[i+3]===1?4:0;if(size){if((bytes[i+size]&31)===9)starts.push(i);i+=size-1}}
  assert.ok(starts.length>=10,'synthetic H264 must contain repeated keyframe access units');
  return starts.map((start,index)=>Buffer.from(bytes.subarray(index?start:0,starts[index+1]||bytes.length)));
}

async function playbackBrowserFixture(t,units,{queryDelayMs=0,secondCamera=false,ackDelayMs={}}={}){
  const {P2PClientProtocol,DeviceType}=require('../../adapters/eufy');const {queryDevice}=require('../../capabilities/devices/capabilities.cjs');const {DeviceVerificationRepository}=require('../../capabilities/devices/verification-store.cjs');
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'eufy-browser-playback-')),raw=[
    {device_sn:'base',device_name:'Base',device_model:'T8030',device_type:DeviceType.HB3,local_ip:'192.0.2.1',main_sw_version:'b1',sec_sw_version:'b2'},
    {device_sn:'camera',device_name:'Synthetic camera A',parent_sn:'base',device_model:'T8600',device_type:DeviceType.PROFESSIONAL_247,device_channel:0,main_sw_version:'c1',sec_sw_version:'c2'},
    ...(secondCamera?[{device_sn:'camera-b',device_name:'Synthetic camera B',parent_sn:'base',device_model:'T8600',device_type:DeviceType.PROFESSIONAL_247,device_channel:1,main_sw_version:'c1',sec_sw_version:'c2'}]:[])];
  const session={api:{getDevsListDecrypted:async()=>({devices:raw})},authenticated:true,state:{phase:'connected'},isAuthenticated(){return this.authenticated},restore:async()=>{},close(){}};
  const repository=new DeviceVerificationRepository(path.join(root,'verification.json'));
  for(const serial of secondCamera?['camera','camera-b']:['camera']){const scope=queryDevice(raw,serial).verificationScope;
    repository.record({capability:'continuousPlaybackControls',status:'verified',scope,reason:'synthetic_browser_fixture',evidence:[{source:'synthetic-browser-fixture',observedAt:'2026-09-13',outcome:'commands_media'}],controls:{pauseResumeAtSpeed1:true,verifiedStartSpeeds:[1,2,4,16]}})}
  const events=[];let activeConnections=0,maxConnections=0,created=0,rejectRanges=0,activeControl;
  const createConnection=()=>{created++;const id=created;events.push(`create:${id}`);activeConnections++;maxConnections=Math.max(maxConnections,activeConnections);const p2p=new EventEmitter();let timer,index=0,begin=0,end=0,serial='camera',channel=0;
    Object.assign(p2p,{connected:true,deviceSNs:{},sendQueue:[],messageStates:new Map(),streamTimeouts:{streamDataWait:5000},currentMessageState:{1:{p2pStreaming:false,p2pStreamNotStarted:true,invalidStream:false,queuedData:new Map()}}});
    for(const method of ['startContinuousPlayback','stopContinuousPlayback','waitForStreamData','endStream','emitStreamStopEvent','setStreamTimeouts'])p2p[method]=P2PClientProtocol.prototype[method];
    p2p.isConnected=()=>p2p.connected;p2p.isCurrentlyStreaming=()=>p2p.currentMessageState[1].p2pStreaming;p2p.initializeMessageBuilder=p2p.initializeMessageState=p2p.initializeStream=p2p.closeEnergySavingDevice=()=>{};
    p2p.queryContinuousRecordings=(_serial,channel,start,stop)=>{begin=start;end=stop;const videos=rejectRanges?[]:[{start_time:start,stop_time:stop,file_path:'private-synthetic-path'}];if(rejectRanges)rejectRanges--;setTimeout(()=>p2p.emit('continuous recording ranges',channel,{begin_time:start,end_time:stop,videos}),queryDelayMs)};
    const stopPump=()=>{clearInterval(timer);timer=undefined};const pump=()=>{stopPump();timer=setInterval(()=>{const data=units[index++%units.length],timestamp=begin*1000+1000+index*100;p2p.waitForStreamData(1,true);p2p.emit('continuous playback frame',{kind:'video',channel,timestamp,keyFrame:true,data});p2p.currentMessageState[1].p2pStreamNotStarted=false},40)};
    p2p.sendCommandWithStringPayload=(command,customData)=>{const cmd=JSON.parse(command.value).data.cmd;events.push(`cmd:${id}:${cmd}`);const ack=()=>{p2p.emit('command',{command_type:6001,channel,return_code:0,customData});if(cmd===0){const {PassThrough}=require('node:stream');p2p.emit('livestream started',channel,{videoCodec:0},new PassThrough(),new PassThrough());pump()}else if(cmd===1)stopPump();else if(cmd===2)pump();else if(cmd===3)stopPump()};ackDelayMs[cmd]?setTimeout(ack,ackDelayMs[cmd]):queueMicrotask(ack)};
    const control={end:()=>{stopPump();p2p.emit('continuous playback frame',{kind:'video',channel,timestamp:end*1000,keyFrame:true,data:units[0]})},stall:stopPump};activeControl=control;
    p2p.close=async()=>{if(!p2p.connected)return;stopPump();p2p.connected=false;p2p.continuousPlayback=undefined;p2p.currentMessageState[1].p2pStreaming=false;activeConnections--;events.push(`closed:${id}`);if(activeControl===control)activeControl=undefined;p2p.emit('close')};
    return {userId:'private-synthetic-account',station:{p2pSession:p2p,getSerial:()=> 'base',getModel:()=> 'T8030'},camera:{getSerial:()=>serial,getModel:()=> 'T8600',getStationSerial:()=> 'base',getChannel:()=>channel},connect:async requested=>{serial=requested;channel=serial==='camera-b'?1:0;events.push(`connect:${id}:${serial}`)},close:async()=>{}}};
  const server=createServer({port:0,session,recordings:{close(){}},outputRoot:root,deviceRepository:repository,playback:{createConnection},createRanges:()=>({close(){},async listRange(_serial,start,stop){return {videos:[{start_time:start,stop_time:stop}]}}})});await new Promise(resolve=>server.start(resolve));
  t.after(async()=>{const shutdown=server.shutdown();server.closeAllConnections?.();server.close();await shutdown;fs.rmSync(root,{recursive:true,force:true})});
  return {url:`http://127.0.0.1:${server.address().port}`,server,events,created:()=>created,maxConnections:()=>maxConnections,
    rejectNextRange:()=>{rejectRanges++},end:()=>activeControl?.end(),stall:()=>activeControl?.stall()};
}

test('Chromium status polling does not reload device inventory until explicit refresh',async t=>{
  const f=await playbackBrowserFixture(t,[]);let browser;t.after(async()=>{if(browser)await browser.close()});browser=await chromium.launch({headless:true});
  const page=await browser.newPage();let statusPolls=0,deviceFetches=0;
  await page.route(url=>new URL(url).pathname==='/status',async route=>{const response=await route.fetch(),body=await response.json();body.devices=[{revision:++statusPolls}];await route.fulfill({response,json:body})});
  await page.route('**/api/v1/session/refresh',route=>route.fulfill({status:200,contentType:'application/json',body:'{}'}));
  page.on('request',request=>{if(new URL(request.url()).pathname==='/api/v1/devices')deviceFetches++});
  await page.goto(f.url+'/app/recordings');await page.getByLabel('Exact camera').locator('option').nth(1).waitFor({state:'attached'});await page.waitForTimeout(300);const initialFetches=deviceFetches;await page.waitForTimeout(3000);
  assert.ok(statusPolls>=2);assert.ok(initialFetches>=1);assert.equal(deviceFetches,initialFetches);
  const refreshed=page.waitForRequest(request=>new URL(request.url()).pathname==='/api/v1/devices');await page.getByRole('button',{name:'Refresh inventory'}).click();await refreshed;await page.waitForTimeout(1500);
  assert.equal(deviceFetches,initialFetches+1);
});

test('real FFmpeg playback reaches Chromium canvas at 390/1440 with pause, resume, bounded seek and close',{skip:!process.env.EUFY_FFMPEG},async t=>{
  const units=h264AccessUnits(process.env.EUFY_FFMPEG),f=await playbackBrowserFixture(t,units,{queryDelayMs:1500});let browser;t.after(async()=>{if(browser)await browser.close()});browser=await chromium.launch({headless:true});
  for(const setup of [{width:1440,height:900,locale:'en',labels:{date:'Date',start:'Start time',end:'End time',check:'Check continuous availability',play:'Play selected timestamp',pause:'Pause preview',resume:'Resume preview',seek:'Seek to selected timestamp',close:'Close preview',source:'Source received position',gap:'This exact preview window is not inside one recording. No older footage was substituted.',controlCode:'CONTROL_CONNECTION_LOST',controlError:'The HomeBase connection was lost and the preview was closed. Check the device connection.'}},{width:390,height:844,locale:'zh-CN',labels:{date:'日期',start:'开始时间',end:'结束时间',check:'检查连续录像范围',play:'播放所选时间',pause:'暂停预览',resume:'继续预览',seek:'跳转到所选时间',close:'关闭预览',source:'源接收位置',gap:'该预览时间窗口未完整落在一条录像内，且没有替换成更早录像。',controlCode:'CONTROL_TIMEOUT',controlError:'HomeBase 未在时限内确认播放控制，预览已关闭。'}}]){
    t.diagnostic(`playback viewport ${setup.width} start`);
    const context=await browser.newContext({viewport:{width:setup.width,height:setup.height},locale:setup.locale});await context.addInitScript(locale=>localStorage.setItem('eufy-agent-hub.language',locale),setup.locale);const page=await context.newPage();await page.goto(f.url+'/app/recordings');await page.getByRole('heading',{name:setup.locale==='en'?'Recording workbench':'录像工作台'}).waitFor();
    await page.getByLabel(setup.labels.date).fill('2026-08-27');await page.getByLabel(setup.labels.start).fill('16:30');await page.getByLabel(setup.labels.end).fill('16:31');await page.getByRole('button',{name:setup.labels.check}).click();const play=page.getByRole('button',{name:setup.labels.play});await page.waitForFunction(label=>[...document.querySelectorAll('button')].some(button=>button.textContent===label&&!button.disabled),setup.labels.play);await play.focus();assert.equal(await page.evaluate(()=>document.activeElement?.textContent),setup.labels.play);await play.click();
    try{await page.getByText(setup.labels.source,{exact:false}).waitFor({timeout:20000})}catch{assert.fail(await page.locator('body').innerText())}t.diagnostic(`playback viewport ${setup.width} first frame`);const canvas=page.locator('.historical-player canvas');const first=await canvas.evaluate(element=>({image:element.toDataURL(),box:element.getBoundingClientRect().toJSON()}));assert.ok(first.image.length>1000);assert.ok(first.box.right<=setup.width+1,JSON.stringify(first.box));
    const firstText=await page.locator('.playback-observation').innerText();assert.match(firstText,/\d+ ms/);const firstSequence=Number(/(?:Displayed frame|已显示帧)\s*(\d+)/.exec(firstText)[1]);
    await page.getByRole('button',{name:setup.labels.pause}).click();await page.getByRole('button',{name:setup.labels.resume}).waitFor();t.diagnostic(`playback viewport ${setup.width} paused`);const frozen=await canvas.evaluate(element=>element.toDataURL()),frozenText=await page.locator('.playback-observation').innerText();await page.waitForTimeout(5200);assert.equal(await canvas.evaluate(element=>element.toDataURL()),frozen);assert.equal(await page.locator('.playback-observation').innerText(),frozenText);
    await page.getByRole('button',{name:setup.labels.resume}).click();try{await page.waitForFunction(({firstSequence,source})=>{const text=document.querySelector('.playback-observation')?.textContent||'';const match=new RegExp(`(?:Displayed frame|已显示帧)\\s*(\\d+)`).exec(text);return text.includes(source)&&Number(match?.[1])>firstSequence},{firstSequence,source:setup.labels.source},{timeout:20000})}catch{assert.fail(await page.locator('body').innerText())}t.diagnostic(`playback viewport ${setup.width} resumed`);
    const oldSession=await page.evaluate(()=>JSON.parse(localStorage.getItem('eufy-agent-hub.playback-intent')).sessionId);await page.getByLabel(setup.labels.start).fill('16:31');await page.getByLabel(setup.labels.end).fill('16:32');await page.waitForFunction(label=>![...document.querySelectorAll('button')].find(button=>button.textContent===label)?.disabled,setup.labels.seek);await page.getByRole('button',{name:setup.labels.seek}).click();assert.deepEqual(await canvas.evaluate(element=>({pixels:[...element.getContext('2d').getImageData(0,0,element.width,element.height).data].some(Boolean),dataset:{...element.dataset}})),{pixels:false,dataset:{}});assert.equal(await page.locator('.playback-observation').count(),0);try{await page.waitForFunction(old=>{try{const value=JSON.parse(localStorage.getItem('eufy-agent-hub.playback-intent'));return value.operation==='seek'&&value.sessionId&&value.sessionId!==old}catch{return false}},oldSession,{timeout:20000})}catch{assert.fail(await page.locator('.historical-player').innerText())}await page.waitForFunction(()=>document.querySelector('.playback-observation')?.textContent?.includes('2026-08-27T20:31:'),undefined,{timeout:20000});
    t.diagnostic(`playback viewport ${setup.width} sought`);const closeRoute='**/api/v1/playback-sessions/*/close';await page.route(closeRoute,route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:{code:setup.labels.controlCode,message:setup.labels.controlCode}})}));await page.getByRole('button',{name:setup.labels.close}).click();await page.getByText(setup.labels.controlError,{exact:true}).waitFor();assert.deepEqual(await canvas.evaluate(element=>({...element.dataset})),{});await page.unroute(closeRoute);await page.getByRole('button',{name:setup.labels.close}).click();await page.getByRole('button',{name:setup.labels.play}).waitFor();
    await page.getByRole('button',{name:setup.labels.check}).click();await page.waitForFunction(label=>![...document.querySelectorAll('button')].find(button=>button.textContent===label)?.disabled,setup.labels.play);await play.click();await page.waitForFunction(()=>Boolean(document.querySelector('.historical-player canvas')?.dataset.sourceReceivedPositionMs),undefined,{timeout:20000});f.rejectNextRange();await page.getByLabel(setup.labels.start).fill('16:32');await page.getByLabel(setup.labels.end).fill('16:33');await page.waitForFunction(label=>![...document.querySelectorAll('button')].find(button=>button.textContent===label)?.disabled,setup.labels.seek);await page.getByRole('button',{name:setup.labels.seek}).click();assert.equal(await page.locator('.playback-observation').count(),0);assert.deepEqual(await canvas.evaluate(element=>({...element.dataset})),{});await page.getByText(setup.labels.gap,{exact:true}).waitFor({timeout:20000});assert.equal(await page.locator('.playback-observation').count(),0);await page.getByRole('button',{name:setup.labels.play}).waitFor();assert.equal((await (await fetch(f.url+'/api/v1/session')).json()).busy,false);await context.close();t.diagnostic(`playback viewport ${setup.width} closed`);
  }
  assert.equal(f.maxConnections(),1);assert.equal(f.created(),8);for(let i=1;i<f.created();i++)assert.ok(f.events.indexOf(`closed:${i}`)<f.events.indexOf(`create:${i+1}`),JSON.stringify(f.events));
});

test('Chromium reconciles clean and failed playback EOF without retaining pixels or labels',{skip:!process.env.EUFY_FFMPEG},async t=>{
  const f=await playbackBrowserFixture(t,h264AccessUnits(process.env.EUFY_FFMPEG));let browser;t.after(async()=>{if(browser)await browser.close()});browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:900,height:800},locale:'en'});await context.addInitScript(()=>localStorage.setItem('eufy-agent-hub.language','en'));const page=await context.newPage();await page.goto(f.url+'/app/recordings');
  await page.getByLabel('Date').fill('2026-08-27');await page.getByLabel('Start time').fill('16:30');await page.getByLabel('End time').fill('16:31');await page.getByRole('button',{name:'Check continuous availability'}).click();const canvas=page.locator('.historical-player canvas'),play=page.getByRole('button',{name:'Play selected timestamp'});
  const start=async()=>{await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(button=>button.textContent==='Play selected timestamp')?.disabled);await play.click();await page.waitForFunction(()=>Boolean(document.querySelector('.historical-player canvas')?.dataset.sourceReceivedPositionMs),undefined,{timeout:20000})};
  const assertCleared=async()=>{await page.locator('.playback-observation').waitFor({state:'detached'});assert.deepEqual(await canvas.evaluate(element=>({...element.dataset})),{});assert.equal(await canvas.evaluate(element=>element.getContext('2d').getImageData(0,0,element.width,element.height).data.some(Boolean)),false)};
  await start();const firstSession=await canvas.getAttribute('data-session-id');f.end();await page.waitForFunction(id=>{const button=[...document.querySelectorAll('button')].find(item=>item.textContent==='Play selected timestamp');return button&&!button.disabled&&!document.querySelector('.playback-observation')&&document.querySelector('.historical-player canvas')?.dataset.sessionId!==id},firstSession,{timeout:20000});await assertCleared();
  await start();f.stall();await page.getByText('No decodable frame arrived within the preview time limit. The requested window was not replaced.',{exact:true}).waitFor({timeout:20000});await assertCleared();assert.equal(f.created(),2);await context.close();
});

test('Chromium locks playback to one camera until close, then permits the second camera',{skip:!process.env.EUFY_FFMPEG},async t=>{
  const f=await playbackBrowserFixture(t,h264AccessUnits(process.env.EUFY_FFMPEG),{secondCamera:true});let browser;t.after(async()=>{if(browser)await browser.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage();await page.goto(f.url+'/app/recordings');const camera=page.getByLabel('Exact camera'),canvas=page.locator('.historical-player canvas');
  const prepare=async serial=>{await camera.selectOption(serial);await page.getByLabel('Date').fill('2026-08-27');await page.getByLabel('Start time').fill('16:30');await page.getByLabel('End time').fill('16:31');await page.getByRole('button',{name:'Check continuous availability'}).click();await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(button=>button.textContent==='Play selected timestamp')?.disabled);await page.getByRole('button',{name:'Play selected timestamp'}).click();await page.waitForFunction(()=>Boolean(document.querySelector('.historical-player canvas')?.dataset.sourceReceivedPositionMs),undefined,{timeout:20000})};
  await prepare('camera');assert.equal(await camera.isDisabled(),true);assert.equal(await camera.inputValue(),'camera');assert.equal(f.events.some(event=>event.endsWith(':camera-b')),false);assert.equal(await page.getByText(/Synthetic camera A · camera · HomeBase/).count(),1);
  await page.getByRole('button',{name:'Close preview'}).click();await page.waitForFunction(()=>!document.querySelector('select[disabled]'));await prepare('camera-b');assert.equal(await camera.inputValue(),'camera-b');assert.equal(await page.getByText(/Synthetic camera B · camera-b · HomeBase/).count(),1);assert.ok(f.events.some(event=>event.endsWith(':camera-b')));await page.getByRole('button',{name:'Close preview'}).click();assert.equal(f.maxConnections(),1);assert.ok(f.events.indexOf('closed:1')<f.events.indexOf('create:2'));await browser.close();browser=undefined;
});

test('Chromium recovery synchronizes playback camera A without changing export intent B',{skip:!process.env.EUFY_FFMPEG},async t=>{
  const f=await playbackBrowserFixture(t,h264AccessUnits(process.env.EUFY_FFMPEG),{secondCamera:true,queryDelayMs:300});let browser;t.after(async()=>{if(browser)await browser.close()});browser=await chromium.launch({headless:true});const session=await (await fetch(f.url+'/api/v1/session')).json(),window={day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'},exportStore={version:1,intent:{requestId:'export-camera-b',input:{serial:'camera-b',...window},submitted:false,jobId:'known-camera-b-job'},jobIds:['known-camera-b-job']};
  const create=requestId=>fetch(f.url+'/api/v1/playback-sessions',{method:'POST',headers:{Origin:f.url,'Content-Type':'application/json'},body:JSON.stringify({requestId,residentEpoch:session.residentEpoch,media:true,speed:1,serial:'camera',...window})}).then(async response=>{const body=await response.json();assert.equal(response.status,201,JSON.stringify(body));return body.playback});
  for(const mode of ['pending','succeeded']){const requestId=`recover-camera-a-${mode}`,creating=create(requestId);if(mode==='pending'){let observed=false;for(let count=0;count<50&&!observed;count++){const response=await fetch(`${f.url}/api/v1/playback-requests/${requestId}?residentEpoch=${session.residentEpoch}`,{headers:{Origin:f.url}});if(response.ok)observed=(await response.json()).request.state==='pending';else await new Promise(resolve=>setTimeout(resolve,10))}assert.equal(observed,true)}else await creating;
    const context=await browser.newContext();await context.addInitScript(({store,playback})=>{localStorage.setItem('eufy-agent-hub.language','en');localStorage.setItem('eufy-agent-hub.recording-workbench',JSON.stringify(store));localStorage.setItem('eufy-agent-hub.playback-intent',JSON.stringify(playback))},{store:exportStore,playback:{requestId,residentEpoch:session.residentEpoch,operation:'create',input:{serial:'camera',...window}}});const page=await context.newPage(),media=[];page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/media'))media.push(request.url())});await page.goto(f.url+'/app/recordings');const camera=page.getByLabel('Exact camera');await page.waitForFunction(()=>[...document.querySelectorAll('select')].some(select=>select.value==='camera'));await page.getByText(/Synthetic camera A · camera · HomeBase base · channel 0/).waitFor();assert.equal(await camera.isDisabled(),true);await page.getByRole('button',{name:'Open recovered preview'}).waitFor({timeout:10000});const playback=await creating;assert.equal(media.length,0);assert.deepEqual(await page.locator('.historical-player canvas').evaluate(element=>({...element.dataset})),{});assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('eufy-agent-hub.recording-workbench'))),exportStore);
    await page.getByRole('button',{name:'Open recovered preview'}).click();await page.waitForFunction(id=>document.querySelector('.historical-player canvas')?.dataset.sessionId===id,playback.sessionId,{timeout:20000});assert.equal(await page.locator('.historical-player canvas').getAttribute('data-request-id'),requestId);assert.equal(media.length,1);assert.equal(f.events.some(event=>event.endsWith(':camera-b')),false);assert.equal(f.maxConnections(),1);await page.getByRole('button',{name:'Close preview'}).click();await page.waitForFunction(async()=>!(await (await fetch('/api/v1/session')).json()).busy);assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('eufy-agent-hub.recording-workbench'))),exportStore);await context.close()}
  assert.equal(f.created(),2);
});

test('Chromium recovery rejects a playback scope that disagrees with its saved camera',{skip:!process.env.EUFY_FFMPEG},async t=>{
  const f=await playbackBrowserFixture(t,h264AccessUnits(process.env.EUFY_FFMPEG),{secondCamera:true});let browser;t.after(async()=>{if(browser)await browser.close()});browser=await chromium.launch({headless:true});const session=await (await fetch(f.url+'/api/v1/session')).json(),window={day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'},requestId='recover-scope-mismatch',response=await fetch(f.url+'/api/v1/playback-sessions',{method:'POST',headers:{Origin:f.url,'Content-Type':'application/json'},body:JSON.stringify({requestId,residentEpoch:session.residentEpoch,media:true,speed:1,serial:'camera',...window})}),playback=(await response.json()).playback,context=await browser.newContext();assert.equal(response.status,201);
  await context.addInitScript(({requestId,residentEpoch,window})=>{localStorage.setItem('eufy-agent-hub.language','en');localStorage.setItem('eufy-agent-hub.recording-workbench',JSON.stringify({version:1,intent:{requestId:'export-camera-b',input:{serial:'camera-b',...window},submitted:false},jobIds:[]}));localStorage.setItem('eufy-agent-hub.playback-intent',JSON.stringify({requestId,residentEpoch,operation:'create',input:{serial:'camera',...window}}))},{requestId,residentEpoch:session.residentEpoch,window});const page=await context.newPage(),media=[];page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/media'))media.push(request.url())});await page.route(`**/api/v1/playback-sessions/${playback.sessionId}`,async route=>{const upstream=await route.fetch(),body=await upstream.json();body.playback.verificationScope.serial='camera-b';await route.fulfill({response:upstream,json:body})});await page.goto(f.url+'/app/recordings');await page.waitForFunction(()=>[...document.querySelectorAll('select')].some(select=>select.value==='camera'));await page.getByText('The device, HomeBase, firmware or channel changed. Check availability again.',{exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Open recovered preview'}).count(),0);assert.equal(media.length,0);assert.deepEqual(await page.locator('.historical-player canvas').evaluate(element=>({...element.dataset})),{});await page.getByRole('button',{name:'Close preview'}).click();await context.close();assert.equal(f.created(),1);
});

test('Chromium releases only definitive dead create recovery identities in English and Chinese',async t=>{
  const f=await playbackBrowserFixture(t,[],{secondCamera:true});let browser;t.after(async()=>{if(browser)await browser.close()});browser=await chromium.launch({headless:true});const session=await (await fetch(f.url+'/api/v1/session')).json(),window={day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'};
  const exportStore={version:1,intent:{requestId:'export-camera-b',input:{serial:'camera-b',...window},submitted:false,jobId:'export-b-job'},jobIds:['export-b-job']};
  const cases=[
    {locale:'en',residentEpoch:'expired-resident',requestId:'expired-en',message:'The resident restarted. Check availability again before opening this preview.',missingCamera:false},
    {locale:'zh-CN',residentEpoch:'expired-resident',requestId:'expired-zh',message:'本地服务已重启，请重新检查录像范围后再打开预览。',missingCamera:true},
    {locale:'en',residentEpoch:session.residentEpoch,requestId:'missing-en',message:'The saved preview request is no longer available on this resident.',missingCamera:true},
    {locale:'zh-CN',residentEpoch:session.residentEpoch,requestId:'missing-zh',message:'此本地服务已没有保存的预览请求。',missingCamera:false},
  ];
  for(const item of cases){const context=await browser.newContext({locale:item.locale});await context.addInitScript(({locale,store,playback})=>{if(sessionStorage.getItem('playback-recovery-seeded'))return;sessionStorage.setItem('playback-recovery-seeded','1');localStorage.setItem('eufy-agent-hub.language',locale);localStorage.setItem('eufy-agent-hub.recording-workbench',JSON.stringify(store));localStorage.setItem('eufy-agent-hub.playback-intent',JSON.stringify(playback))},{locale:item.locale,store:exportStore,playback:{requestId:item.requestId,residentEpoch:item.residentEpoch,operation:'create',input:{serial:'camera',...window}}});const page=await context.newPage(),requests=[];page.on('request',request=>requests.push({method:request.method(),path:new URL(request.url()).pathname}));
    if(item.missingCamera)await page.route(/\/api\/v1\/devices$/,async route=>{const upstream=await route.fetch(),body=await upstream.json();body.devices=body.devices.filter(device=>device.serial!=='camera');await route.fulfill({response:upstream,json:body})});
    await page.goto(f.url+'/app/recordings');await page.getByText(item.message,{exact:true}).waitFor();const camera=page.getByLabel(item.locale==='en'?'Exact camera':'确切摄像头');await page.waitForFunction(label=>{const control=[...document.querySelectorAll('label')].find(item=>item.textContent?.includes(label))?.querySelector('select');return Boolean(control&&!control.disabled)},item.locale==='en'?'Exact camera':'确切摄像头');assert.equal(await page.evaluate(()=>localStorage.getItem('eufy-agent-hub.playback-intent')),null);assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('eufy-agent-hub.recording-workbench'))),exportStore);assert.deepEqual(await page.locator('.historical-player canvas').evaluate(element=>({...element.dataset})),{});assert.equal(await page.locator('.historical-player canvas').evaluate(element=>element.getContext('2d').getImageData(0,0,element.width,element.height).data.some(Boolean)),false);if(item.missingCamera)await camera.selectOption('camera-b');
    assert.equal(requests.some(request=>request.method==='POST'&&(request.path==='/api/v1/playback-sessions'||request.path.endsWith('/seek'))),false);assert.equal(requests.some(request=>request.path.endsWith('/media')),false);await page.waitForTimeout(200);const recoveryReads=requests.filter(request=>request.path.includes(`/playback-requests/${item.requestId}`)).length;await page.reload();await page.waitForTimeout(300);assert.equal(requests.filter(request=>request.path.includes(`/playback-requests/${item.requestId}`)).length,recoveryReads);assert.equal(await page.evaluate(()=>localStorage.getItem('eufy-agent-hub.playback-intent')),null);assert.deepEqual(await page.evaluate(()=>JSON.parse(localStorage.getItem('eufy-agent-hub.recording-workbench'))),exportStore);await context.close()}
  assert.equal(f.created(),0);
});

test('Chromium keeps a non-definitive recovery identity locked without replaying media',async t=>{
  const f=await playbackBrowserFixture(t,[],{secondCamera:true});let browser;t.after(async()=>{if(browser)await browser.close()});browser=await chromium.launch({headless:true});const session=await (await fetch(f.url+'/api/v1/session')).json(),window={day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'},context=await browser.newContext();
  await context.addInitScript(({residentEpoch,window})=>{localStorage.setItem('eufy-agent-hub.language','en');localStorage.setItem('eufy-agent-hub.playback-intent',JSON.stringify({requestId:'uncertain-request',residentEpoch,operation:'create',input:{serial:'camera',...window}}))},{residentEpoch:session.residentEpoch,window});const page=await context.newPage(),media=[];page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/media'))media.push(request.url())});await page.route('**/api/v1/playback-requests/uncertain-request*',route=>route.fulfill({status:504,contentType:'application/json',body:JSON.stringify({error:{code:'CONTROL_TIMEOUT',message:'CONTROL_TIMEOUT'}})}));await page.goto(f.url+'/app/recordings');await page.getByText('The HomeBase did not confirm the playback control in time, so the preview was closed.',{exact:true}).waitFor();assert.equal(await page.getByLabel('Exact camera').isDisabled(),true);assert.ok(await page.evaluate(()=>localStorage.getItem('eufy-agent-hub.playback-intent')));assert.equal(media.length,0);assert.equal(f.created(),0);await context.close();
});

test('Chromium retains an active old owner when a saved seek request or replacement session is missing',{skip:!process.env.EUFY_FFMPEG},async t=>{
  const f=await playbackBrowserFixture(t,h264AccessUnits(process.env.EUFY_FFMPEG),{secondCamera:true});let browser;t.after(async()=>{if(browser)await browser.close()});browser=await chromium.launch({headless:true});const session=await (await fetch(f.url+'/api/v1/session')).json(),window={day:'2026-08-27',start:'16:30',end:'16:31',timezone:'America/Toronto'};
  for(const item of [{requestId:'missing-seek',message:'The saved preview request is no longer available on this resident.'},{requestId:'missing-replacement-request',missingSessionId:'missing-replacement-session',message:'This preview session is no longer available. Check the selected timestamp again.'}]){const response=await fetch(f.url+'/api/v1/playback-sessions',{method:'POST',headers:{Origin:f.url,'Content-Type':'application/json'},body:JSON.stringify({requestId:`old-owner-${item.requestId}`,residentEpoch:session.residentEpoch,media:true,speed:1,serial:'camera',...window})}),old=(await response.json()).playback;assert.equal(response.status,201);
    const context=await browser.newContext();await context.addInitScript(({residentEpoch,window,fromSessionId,requestId})=>{localStorage.setItem('eufy-agent-hub.language','en');localStorage.setItem('eufy-agent-hub.playback-intent',JSON.stringify({requestId,residentEpoch,operation:'seek',fromSessionId,input:{serial:'camera',...window}}))},{residentEpoch:session.residentEpoch,window,fromSessionId:old.sessionId,requestId:item.requestId});const page=await context.newPage(),media=[];page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/media'))media.push(request.url())});if(item.missingSessionId)await page.route(`**/api/v1/playback-requests/${item.requestId}*`,route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({request:{requestId:item.requestId,residentEpoch:session.residentEpoch,operation:'seek',state:'succeeded',fromSessionId:old.sessionId,sessionId:item.missingSessionId,cleanupComplete:false,error:null}})}));await page.goto(f.url+'/app/recordings');await page.getByText(item.message,{exact:true}).waitFor();assert.equal(await page.getByLabel('Exact camera').isDisabled(),true);assert.equal(await page.getByRole('button',{name:'Close preview'}).count(),1);assert.equal(media.length,0);assert.ok(await page.evaluate(()=>localStorage.getItem('eufy-agent-hub.playback-intent')));await page.getByRole('button',{name:'Close preview'}).click();await page.getByRole('button',{name:'Play selected timestamp'}).waitFor();assert.equal((await (await fetch(f.url+'/api/v1/session')).json()).busy,false);await context.close()}
  assert.equal(f.created(),2);
});

test('Chromium reload recovers only active playback and rejects succeeded requests with terminal sessions',{skip:!process.env.EUFY_FFMPEG},async t=>{
  const f=await playbackBrowserFixture(t,h264AccessUnits(process.env.EUFY_FFMPEG));let browser;t.after(async()=>{if(browser)await browser.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage(),media=[];page.on('request',request=>{if(new URL(request.url()).pathname.endsWith('/media'))media.push(request.url())});await page.goto(f.url+'/app/recordings');
  const start=async()=>{await page.getByLabel('Date').fill('2026-08-27');await page.getByLabel('Start time').fill('16:30');await page.getByLabel('End time').fill('16:31');await page.getByRole('button',{name:'Check continuous availability'}).click();await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(button=>button.textContent==='Play selected timestamp')?.disabled);await page.getByRole('button',{name:'Play selected timestamp'}).click();await page.waitForFunction(()=>Boolean(document.querySelector('.historical-player canvas')?.dataset.sourceReceivedPositionMs),undefined,{timeout:20000})};
  await start();const activeMedia=media.length,createdAfterActive=f.created();await page.reload();await page.waitForFunction(()=>localStorage.getItem('eufy-agent-hub.playback-intent')===null,undefined,{timeout:20000});assert.equal(await page.getByRole('button',{name:'Open recovered preview'}).count(),0);assert.equal(media.length,activeMedia);assert.equal(f.created(),createdAfterActive);
  await start();const saved=await page.evaluate(()=>localStorage.getItem('eufy-agent-hub.playback-intent'));f.stall();await page.getByText('No decodable frame arrived within the preview time limit. The requested window was not replaced.',{exact:true}).waitFor({timeout:20000});await page.evaluate(value=>localStorage.setItem('eufy-agent-hub.playback-intent',value),saved);const failedMedia=media.length,createdAfterFailure=f.created();await page.reload();await page.getByText('No decodable frame arrived within the preview time limit. The requested window was not replaced.',{exact:true}).waitFor({timeout:20000});assert.equal(await page.getByRole('button',{name:'Open recovered preview'}).count(),0);assert.equal(await page.evaluate(()=>localStorage.getItem('eufy-agent-hub.playback-intent')),null);assert.equal(media.length,failedMedia);assert.equal(f.created(),createdAfterFailure);await browser.close();browser=undefined;
});

test('Chromium keeps pause and resume EOF terminal across both control completion orders',{skip:!process.env.EUFY_FFMPEG},async t=>{
  const f=await playbackBrowserFixture(t,h264AccessUnits(process.env.EUFY_FFMPEG),{ackDelayMs:{1:500}});let browser;t.after(async()=>{if(browser)await browser.close()});browser=await chromium.launch({headless:true});const page=await browser.newPage(),canvas=page.locator('.historical-player canvas');await page.goto(f.url+'/app/recordings');await page.getByLabel('Date').fill('2026-08-27');await page.getByLabel('Start time').fill('16:30');await page.getByLabel('End time').fill('16:31');await page.getByRole('button',{name:'Check continuous availability'}).click();
  const start=async()=>{await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(button=>button.textContent==='Play selected timestamp')?.disabled);await page.getByRole('button',{name:'Play selected timestamp'}).click();await page.waitForFunction(()=>Boolean(document.querySelector('.historical-player canvas')?.dataset.sourceReceivedPositionMs),undefined,{timeout:20000})};
  const terminal=async()=>{await page.waitForFunction(()=>{const play=[...document.querySelectorAll('button')].find(button=>button.textContent==='Play selected timestamp');return play&&!play.disabled&&!document.querySelector('.playback-observation')},undefined,{timeout:20000});assert.deepEqual(await canvas.evaluate(element=>({...element.dataset})),{});assert.equal(await canvas.evaluate(element=>element.getContext('2d').getImageData(0,0,element.width,element.height).data.some(Boolean)),false);assert.equal(await page.evaluate(()=>localStorage.getItem('eufy-agent-hub.playback-intent')),null)};
  await start();await page.getByRole('button',{name:'Pause preview'}).click();for(let count=0;count<20&&!f.events.includes('cmd:1:1');count++)await page.waitForTimeout(10);assert.ok(f.events.includes('cmd:1:1'));f.end();await terminal();
  await start();await page.getByRole('button',{name:'Pause preview'}).click();await page.getByRole('button',{name:'Resume preview'}).waitFor();await page.getByRole('button',{name:'Resume preview'}).click();await page.waitForFunction(()=>![...document.querySelectorAll('button')].find(button=>button.textContent==='Pause preview')?.disabled,undefined,{timeout:20000});f.end();await terminal();assert.equal(f.maxConnections(),1);await browser.close();browser=undefined;
});
