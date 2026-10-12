import { randomUUID } from 'node:crypto';
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import net from 'node:net';
import { controllerDecision as decide, receiverReady, restartDelay } from '../src/managed-supervisor.mjs';

const target=randomUUID();
const controllerDecision = value => decide(value, { threadId: target, model: 'gpt-6-luna' });
const journal=()=>({threadId:target,model:'gpt-6-luna',transport:'codex-exec',cliProbe:{stage:'completed'},phase:'waiting',active:null});
const healthy=()=>({running:true,mode:'local-queue',ownerBound:true,accountConfigured:true,normalReceptionActivated:true,
  receive:{successfulPolls:1,lastFailure:null,lastSuccessAt:new Date().toISOString()}});
async function until(read,predicate,timeout=10000){const end=Date.now()+timeout;while(Date.now()<end){try{const value=await read();if(predicate(value))return value;}catch{}await pause(40);}throw new Error('test_timeout');}
async function fixture(t){
 const dir=await mkdtemp('/tmp/wxm-'),appDir=join(dir,'app'),stateDir=join(dir,'state');
 await mkdir(join(appDir,'src'),{recursive:true,mode:0o700});await mkdir(stateDir,{mode:0o700});
 const config=join(dir,'config.json');
 await writeFile(config,JSON.stringify({threadId:target,model:'gpt-6-luna',appDir,stateDir,node:process.execPath,codex:'/usr/bin/true',python:'/usr/bin/true',pdftoppm:'/usr/bin/true'}),{mode:0o600});
 await writeFile(join(stateDir,'native-codex.json'),JSON.stringify(journal()),{mode:0o600});
 const children=[];
 t.after(async()=>{for(const child of children){if(child.exitCode==null&&child.signalCode==null){child.kill('SIGTERM');await until(async()=>child.exitCode!=null||child.signalCode!=null,x=>x,15000);}}await rm(dir,{recursive:true,force:true});});
 const start=role=>{const child=spawn(process.execPath,[fileURLToPath(new URL('../src/managed-supervisor.mjs',import.meta.url)),role,config],{stdio:['ignore','pipe','pipe']});children.push(child);return child;};
 const status=role=>readFile(join(stateDir,'launchd',role+'-status.json'),'utf8').then(JSON.parse);
 return {dir,appDir,stateDir,start,status};
}

test('restart backoff is bounded and uncertain/model-policy/approval states never auto-submit',()=>{
 assert.deepEqual([0,1,2,3,8].map(restartDelay),[5000,10000,20000,40000,300000]);
 assert.equal(controllerDecision(journal()).allowed,true);
 for(const stage of ['submitting','running','reply_sending','wechat_unconfirmed'])assert.equal(controllerDecision({...journal(),active:{stage}}).allowed,false);
 for(const reason of ['native_auth_required','exec_user_action_required','wechat_send_unconfirmed'])assert.equal(controllerDecision({...journal(),phase:'paused',pauseReason:reason}).allowed,false);
 assert.equal(controllerDecision({...journal(),phase:'paused',pauseReason:'native_thread_active_writer'}).allowed,true);
 assert.equal(controllerDecision({...journal(),model:'different'}).allowed,false);
 assert.equal(receiverReady(healthy()),true);assert.equal(receiverReady({...healthy(),receive:{successfulPolls:0}}),false);
 assert.equal(receiverReady({...healthy(),receive:{successfulPolls:1,lastFailure:{kind:'timeout'},lastSuccessAt:new Date().toISOString()}}),false);
});

test('supervisor retries a crashed fake poller after backoff and excludes a duplicate supervisor',{timeout:20000},async t=>{
 const f=await fixture(t);
 await writeFile(join(f.appDir,'src/main.mjs'),`import{appendFileSync}from'node:fs';appendFileSync(process.env.CODEX_WECHAT_STATE+'.starts',process.pid+'\\n');setTimeout(()=>process.exit(77),100);`,{mode:0o600});
 f.start('poller');
 const s=await until(()=>f.status('poller'),s=>s.childStarts>=2,12000);
 const count=await until(()=>readFile(join(f.stateDir,'state.json.starts'),'utf8').then(s=>s.trim().split('\n').length),x=>x===2,2000);
 assert.equal(count,2);
 const duplicate=f.start('poller');let output='';duplicate.stdout.on('data',c=>output+=c);
 await until(async()=>duplicate.exitCode,x=>x!==null,4000);
 assert.equal(duplicate.exitCode,0);assert.ok(output.includes('duplicate_supervisor_refused'));
 assert.equal((await readFile(join(f.stateDir,'state.json.starts'),'utf8')).trim().split('\n').length,2);
});

test('controller waits for a healthy queue then recovers an idle fake-child crash without model calls',{timeout:25000},async t=>{
 const f=await fixture(t);let ready=false;
 await writeFile(join(f.appDir,'src/exec.mjs'),`import{appendFileSync}from'node:fs';appendFileSync(process.env.CODEX_WECHAT_STATE+'.starts',process.pid+'\\n');process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);`,{mode:0o600});
 const server=net.createServer(socket=>{socket.on('data',()=>socket.end(JSON.stringify({ok:true,result:ready?healthy():{...healthy(),receive:{successfulPolls:0}}})+'\n'));});
 await new Promise(r=>server.listen(join(f.stateDir,'local-queue.sock'),r));t.after(()=>new Promise(r=>server.close(r)));
 f.start('controller');await until(()=>f.status('controller'),s=>s.phase==='waiting_receiver');
 assert.equal((await f.status('controller')).childStarts,0);ready=true;
 const first=await until(()=>f.status('controller'),s=>s.phase==='running',8000);
 await until(()=>readFile(join(f.stateDir,'state.json.starts'),'utf8'),s=>s.includes(String(first.childPid)),2000);
 process.kill(first.childPid,'SIGKILL');
 const next=await until(()=>f.status('controller'),s=>s.phase==='running'&&s.childStarts===2,10000);
 await until(()=>readFile(join(f.stateDir,'state.json.starts'),'utf8').then(s=>s.trim().split('\n').length),x=>x===2,2000);
 assert.notEqual(next.childPid,first.childPid);
 assert.equal((await readFile(join(f.stateDir,'state.json.starts'),'utf8')).trim().split('\n').length,2);
});

test('authentication pause keeps the managed job alive without starting a child',{timeout:5000},async t=>{
 const f=await fixture(t);
 await writeFile(join(f.stateDir,'native-codex.json'),JSON.stringify({...journal(),phase:'paused',pauseReason:'native_auth_required'}),{mode:0o600});
 const child=f.start('controller');const s=await until(()=>f.status('controller'),s=>s.phase==='blocked');
 assert.equal(s.childStarts,0);assert.equal(s.manualRestartRequired,true);
 assert.equal(child.exitCode,null);assert.equal(child.signalCode,null);
});
