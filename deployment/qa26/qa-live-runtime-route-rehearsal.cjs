#!/usr/bin/env node
const cp=require('node:child_process'),crypto=require('node:crypto');
const sha='4a363cf9054b0b3667fd450f36e354b704ec2166';
const host='h5c-managed-qa26.hi5central.com',peer='h5c-custom-qa26.hi5central.com';
const stamp=Date.now(),key='qa-live-runtime-cas-'+stamp,vol='hi5central_qa_live_route_rollback_backups';
const watch='h5c-qa-runtime-watch-'+stamp;
const dig=x=>crypto.createHash('sha256').update(x).digest('hex');
const docker=(args,input=null,timeout=35000)=>cp.execFileSync('docker',args,{encoding:'utf8',input,maxBuffer:18e6,timeout});
const req=url=>cp.execFileSync('curl',['-fsS','--max-time','12',url],{encoding:'utf8',timeout:15000});
const json=url=>JSON.parse(req(url));
const check=(ok,reason)=>{if(!ok)throw Error(reason)};
const getAdmin=()=>docker(['exec','hi5central-web','wget','-qO-','http://127.0.0.1:2019/config/']);
const sourceMounted=()=>docker(['exec','hi5central-web','cat','/etc/caddy/Caddyfile']);
const sourceDisk=()=>docker(['run','--rm','--network','none','--mount','type=bind,source=/opt/hi5central/deployment/Caddyfile,target=/target/Caddyfile,readonly','busybox:1.36','cat','/target/Caddyfile']);
const state=()=>JSON.parse(docker(['exec','hi5central-certified-release-planner','node','-e',
  'const {Client}=require("pg");(async()=>{let c=new Client({connectionString:process.env.DATABASE_URL});await c.connect();let a=await c.query("SELECT paused FROM platform_release_rollout_control WHERE singleton=true");let b=await c.query("SELECT COUNT(*)::int AS n FROM tenant_release_rollout_jobs WHERE status=ANY($1)",[["running","scheduled"]]);console.log(JSON.stringify({paused:a.rows[0].paused,active:b.rows[0].n}));await c.end()})()']));
const put=(k,contents)=>docker(['run','--rm','-i','--network','none','--mount','type=volume,source='+vol+',target=/backup','busybox:1.36','sh','-c','umask 077; cat > /backup/'+k],contents);
const get=k=>docker(['run','--rm','--network','none','--mount','type=volume,source='+vol+',target=/backup,readonly','busybox:1.36','cat','/backup/'+k]);
const reload=(payload,name)=>{
  const command='umask 077; cat > /tmp/'+name+'.json && caddy reload --config /tmp/'+name+'.json';
  return docker(['exec','-i','hi5central-web','sh','-c',command],payload,60000);
};
const findRoutes=c=>c.apps.http.servers.srv0.routes.find(r=>r.match?.some(x=>x.host?.includes('*.hi5central.com')))?.handle?.[0]?.routes;
function beforeRead(){
 const s=state();check(s.paused===true&&s.active===0,'Global rollout pause/queue changed.');
 const mounted=sourceMounted(),disk=sourceDisk();
 check(dig(mounted)==='21657cd198a1e1da167083faad432ac7f66ecd964190b5d75c18acb7fda4e050','Mounted QA base drifted.');
 check(dig(disk)==='8a04056fc756cff98c71030a1404cede32ef85252ff1ea012f7e86c1515df1b3','Persisted QA base drifted.');
 const m=json('https://'+host+'/release-manifest.json').sha;
 const p=json('https://'+peer+'/release-manifest.json').sha;
 const shared=json('https://api.hi5central.com/api/v1/updates/version').sha;
 check(m==='f51d2e634e450e03214f10d845f90f73f7b2d506'&&p===m,'QA Live frontend baseline changed.');
 check(shared==='2199e58a540ff912cccdbd137fdfbb9e8d48f3c5','Shared Live API baseline changed.');
 return {m,p,shared,mounted:dig(mounted),disk:dig(disk)};
}
let backup=null,armed=false,restored=false,watchStarted=false;
const before=beforeRead(),started=Date.now();
console.log('QA_LIVE_REHEARSAL_PRECHECK_PASS '+JSON.stringify({paused:true,noActiveJobs:true,baselineSha:before.m,sharedApi:before.shared.slice(0,12)}));
try{
 const raw=getAdmin();const active=JSON.parse(raw);
 const mountedCandidate=sourceMounted();
 const marker='    # Isolated QA onboarding recovery frontend; other customers untouched.';
 check(mountedCandidate.split(marker).length===2,'Unexpected mounted gateway anchor.');
 const pair='hi5pool-live-'+sha.slice(0,12);
 const block=[
 '    @h5cQaRuntimeDemo host '+host,
 '    handle @h5cQaRuntimeDemo {',
 '      @h5cQaRuntimeDemoApi path /api/*',
 '      handle @h5cQaRuntimeDemoApi {',
 '        reverse_proxy '+pair+'-api:3001',
 '      }',
 '      handle {',
 '        reverse_proxy '+pair+'-web:80',
 '      }',
 '    }'
 ].join('\n')+'\n';
 const preview=mountedCandidate.replace(marker,block+marker);
 const adapted=JSON.parse(docker(['exec','-i','hi5central-web','caddy','adapt','--config','/dev/stdin','--adapter','caddyfile'],preview));
 const m=findRoutes(adapted);
 const target=m.find(r=>r.match?.some(x=>x.host?.length===1&&x.host[0]===host));
 check(target,'Exact QA Live route could not be adapted.');
 check(JSON.stringify(target).includes(pair+'-api:3001')&&JSON.stringify(target).includes(pair+'-web:80'),'API/Web route pair mismatch.');
 const candidate=structuredClone(active);const rows=findRoutes(candidate);
 const index=rows.findIndex(r=>r.match?.some(x=>x.host?.includes(host)&&x.host.includes(peer)));
 check(index>=0&&!rows.some(r=>r.match?.some(x=>x.host?.length===1&&x.host[0]===host)),'Trusted QA route insertion location missing.');
 rows.splice(index,0,target);
 const inverse=structuredClone(candidate);findRoutes(inverse).splice(index,1);
 check(JSON.stringify(inverse)===JSON.stringify(active),'Non-QA Caddy runtime route changed in candidate.');
 const revised=JSON.stringify(candidate);
 const val=docker(['exec','-i','hi5central-web','sh','-c','umask 077; cat >/tmp/qa-cas-check-'+stamp+'.json && caddy validate --config /tmp/qa-cas-check-'+stamp+'.json'],revised,45000);
 check(val.includes('Valid configuration'),'Caddy rejected scoped runtime candidate.');
 put(key+'.json',raw);
 check(dig(get(key+'.json'))===dig(raw),'Independent persistent JSON backup checksum failed.');
 backup=raw;
 const watcherCommand='sleep 210; if [ ! -e /backup/'+key+'.done ]; then cat /backup/'+key+'.json | docker exec -i hi5central-web sh -c "umask 077; cat >/tmp/qa-watchdog-restore-'+stamp+'.json && caddy reload --config /tmp/qa-watchdog-restore-'+stamp+'.json" >/dev/null 2>&1 || true; fi';
 docker(['run','-d','--rm','--name',watch,'--network','none','--mount','type=volume,source='+vol+',target=/backup','--mount','type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock','docker:27-cli','sh','-c',watcherCommand]);
 watchStarted=true;armed=true;
 check(dig(getAdmin())===dig(raw),'Caddy runtime configuration changed while preparing QA activation.');
 check(state().paused===true&&state().active===0,'Global deployment control no longer safe.');
 reload(revised,'h5c-qa-runtime-'+stamp);
 console.log('QA_LIVE_RUNTIME_SWITCH_ATTEMPT '+JSON.stringify({tenant:host,sha:sha.slice(0,12)}));
 const deadline=Date.now()+15000;
 let verified=false;
 while(Date.now()<deadline){
  try{
   const api=json('https://'+host+'/api/v1/updates/version').sha;
   const manifest=json('https://'+host+'/release-manifest.json').sha;
   const config=req('https://'+host+'/runtime-config.js');
   verified=api===sha&&manifest===sha&&config.includes('apiUrl: "" || window.location.origin');
   if(verified)break;
  }catch{}
  cp.execFileSync('sleep',['1']);
 }
 check(verified,'Target QA API/web versions did not become healthy.');
 check(json('https://'+peer+'/release-manifest.json').sha===before.p,'Custom QA peer was altered.');
 check(json('https://api.hi5central.com/api/v1/updates/version').sha===before.shared,'Shared Live API was altered.');
 check(req('https://'+host+'/login').toLowerCase().includes('html'),'Managed login unavailable.');
 const sess=cp.spawnSync('curl',['-sS','--max-time','10','-o','/dev/null','-w','%{http_code}','https://'+host+'/api/v1/auth/session'],{encoding:'utf8',timeout:13000}).stdout;
 check(sess.trim()==='401','QA Managed session boundary invalid.');
 const deny=cp.spawnSync('curl',['-sS','--max-time','10','-o','/dev/null','-w','%{http_code}','https://h5c-managed-qa26-uat.hi5central.com/login'],{encoding:'utf8',timeout:13000}).stdout;
 check(deny.trim()==='404','Managed UAT must remain forbidden.');
 console.log('QA_LIVE_SCOPED_RUNTIME_PROOF_PASS '+JSON.stringify({targetVersion:sha,peerUnchanged:true,sharedApiUnchanged:true,authProtected:true,managedUatDenied:true,durationMs:Date.now()-started}));
 reload(raw,'h5c-qa-runtime-restore-'+stamp);
 const backHost=json('https://'+host+'/release-manifest.json').sha;
 const backPeer=json('https://'+peer+'/release-manifest.json').sha;
 check(backHost===before.m&&backPeer===before.p,'Live rollback did not fully restore peer and canary.');
 check(dig(sourceMounted())===before.mounted&&dig(sourceDisk())===before.disk,'Protected mounted/persistent source changed unexpectedly.');
 check(dig(getAdmin())===dig(raw),'Runtime JSON did not restore checksum exactly.');
 restored=true;
 put(key+'.done','verified restore '+new Date().toISOString());
 armed=false;
 docker(['stop','-t','1',watch]);watchStarted=false;
 console.log('QA_LIVE_RUNTIME_ROLLBACK_PASS '+JSON.stringify({backup:vol+'/'+key+'.json',durationMs:Date.now()-started,unchangedSources:true,persistentRouteActivation:false}));
}catch(e){
 console.error('QA_LIVE_RUNTIME_REHEARSAL_ERROR '+String(e.message||e).slice(0,300));
 if(armed&&backup){
   try{reload(backup,'h5c-qa-runtime-emergency-'+stamp);if(json('https://'+host+'/release-manifest.json').sha===before.m){restored=true;put(key+'.done','restored-after-error '+new Date().toISOString());armed=false;console.error('QA_LIVE_RUNTIME_EMERGENCY_ROLLBACK_PASS');}}catch(err){console.error('QA_LIVE_RUNTIME_EMERGENCY_ROLLBACK_FAILED '+String(err.message).slice(0,140));}
 }
 process.exitCode=1;
}finally{
 if(watchStarted&&!armed)try{docker(['stop','-t','1',watch]);}catch{}
 if(armed)console.error('QA_LIVE_RUNTIME_WATCHDOG_ARMED_FOR_AUTORESTORE '+watch);
}
