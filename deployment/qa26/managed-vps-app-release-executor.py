#!/usr/bin/env python3
"""Native Ubuntu-only, *opt-in* immutable API/ITSM release executor.

This is reviewed source, NOT an installed or enabled service. The legacy
hi5central-release-operator container handles a different queue and MUST NOT
be repurposed or enabled for Production promotion.

Preflight: python3 managed-vps-app-release-executor.py preflight
Activation: separately authorise, install and configure an exclusive systemd
service with HI5_ENABLE_SHARED_PROD_APP_RELEASES=yes. No Caddy, RMM, Postgres
or Redis containers are recreated by this executor.
"""
import argparse
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import time
from datetime import datetime, timezone
from urllib.request import Request, urlopen
from urllib.parse import urlsplit

ROOT=Path(os.getenv('HI5_DEPLOY_ROOT','/opt/hi5central')).resolve()
API_URL=os.getenv('RELEASE_CONTROL_API_URL','https://api.hi5central.com').rstrip('/')
TOKEN_FILE=Path(os.getenv('RELEASE_OPERATOR_TOKEN_FILE',str(ROOT/'deployment/private/release-operator.token')))
BACKUPS=ROOT/'deployment/backups/application-releases'
PINS=ROOT/'deployment/app-release-image-pins'
SHA=re.compile(r'^[a-f0-9]{40}$')
UUID=re.compile(r'^[a-f0-9-]{36}$')
SERVICES={
 'dev':('hi5central-dev-control-server-1','hi5central-dev-itsm-web-1','hi5central-dev-postgres-1','dev-api'),
 'uat':('hi5central-uat-control-server-1','hi5central-uat-itsm-web-1','hi5central-uat-postgres-1','uat-api'),
 'live':('hi5central-api','hi5central-prod-itsm','hi5central-postgres','api'),
}
CAPABILITY='api-itsm-live-backup-rollback'
WORKER_ID='managed-vps-api-itsm-v1'
IMAGE='ghcr.io/dansut24/hi5central-platform-'
TOKEN=None

def run(*args,input=None):
  r=subprocess.run(list(args),input=input,stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,check=False)
  if r.returncode:
    raise RuntimeError('Command failed: '+str(args[:2])+'; '+r.stderr.decode(errors='replace')[-300:])
  return r.stdout.decode().strip()

def log(value):
  print(datetime.now(timezone.utc).isoformat(timespec='seconds'),value,file=sys.stderr,flush=True)

def operator_request(path,body):
  if TOKEN is None:raise RuntimeError('Operator token not configured')
  if urlsplit(API_URL).scheme!='https' or urlsplit(API_URL).hostname!='api.hi5central.com':
    raise RuntimeError('Release authority must be the canonical HTTPS API')
  encoded=json.dumps(body,separators=(',',':')).encode()
  request=Request(API_URL+path,data=encoded,method='POST',headers={
    'Authorization':'Bearer '+TOKEN,'Content-Type':'application/json'})
  with urlopen(request,timeout=35) as response:
    return json.load(response)

def inspect(name):
  result=json.loads(run('docker','inspect',name))
  if len(result)!=1:raise RuntimeError('Expected exactly one existing container')
  return result[0]

def observed(env):
  first,second,_,host=SERVICES[env]
  values=[]
  for name,service in ((first,'api'),(second,'itsm')):
    info=inspect(name)
    if info['State'].get('Health',{}).get('Status')!='healthy':
      raise RuntimeError(env+' '+service+' container is not healthy')
    sha=(info.get('Config',{}).get('Labels') or {}).get('org.opencontainers.image.revision','')
    if not SHA.fullmatch(sha):
      raise RuntimeError(env+' '+service+' has no verifiable immutable revision label')
    values.append(sha)
  with urlopen('https://'+host+'.hi5central.com/health',timeout=12) as response:
    if response.status!=200:raise RuntimeError(env+' API public health check failed')
  return tuple(values)

def compose_identity(env):
  if env not in ('uat','live'):raise RuntimeError('Only existing shared UAT/Live runtime pools are supported')
  api_name,web_name,_,_=SERVICES[env]
  first,second=inspect(api_name),inspect(web_name)
  a,b=(first.get('Config',{}).get('Labels') or {}),(second.get('Config',{}).get('Labels') or {})
  project=a.get('com.docker.compose.project')
  if project!=b.get('com.docker.compose.project'):
    raise RuntimeError('API/ITSM project labels differ')
  if project!=('hi5central-uat' if env=='uat' else 'deployment'):
    raise RuntimeError('Unexpected Docker Compose project')
  expected=('control-server','itsm-web') if env=='uat' else ('api','itsm')
  if (a.get('com.docker.compose.service'),b.get('com.docker.compose.service'))!=expected:
    raise RuntimeError('Unexpected API/ITSM Compose service names')
  raw=a.get('com.docker.compose.project.config_files','')
  if not raw or b.get('com.docker.compose.project.config_files')!=raw:
    raise RuntimeError('Missing/inconsistent running Compose layer provenance')
  values=[]
  for item in raw.split(','):
    source=Path(item.strip()).resolve()
    if not source.is_relative_to(ROOT) or not source.is_file() or not item.startswith(str(ROOT)+'/'):
      raise RuntimeError('Disallowed or missing runtime Compose file')
    if not source.is_relative_to(PINS):
      values.append(source)
  if len(values)<2 or len(values)!=len(set(values)):
    raise RuntimeError('Invalid or duplicate Compose layer list')
  if env=='uat':
    must={'compose.yml','compose.managed-edge.yml','compose.sandbox-itsm.yml',
      'compose.sandbox.yml','compose.qa26-sandbox-runtime-policy.yml'}
    if not must.issubset({x.name for x in values}):
      raise RuntimeError('UAT critical sandbox and background-worker Compose layers missing')
  else:
    if not {'compose.runtime.yml','compose.prod.yml'}.issubset({x.name for x in values}):
      raise RuntimeError('Live application/Production Compose layers missing')
  return project,expected,values

def compose(env,lock_file=None):
  project,services,layers=compose_identity(env)
  cmd=['docker','compose','-p',project,'--project-directory',
       str(ROOT/'hi5central-deploy' if env=='uat' else ROOT/'deployment')]
  env_file=(ROOT/'hi5central-deploy/environments/uat.env' if env=='uat' else ROOT/'deployment/.env')
  if not env_file.is_file() or (env_file.stat().st_mode&0o077):
    raise RuntimeError('Protected '+env+' Compose .env file missing or insecure')
  cmd.extend(['--env-file',str(env_file)])
  for file in layers:cmd.extend(['-f',str(file)])
  if lock_file is not None:cmd.extend(['-f',str(lock_file)])
  return cmd,services

def pinned_path(env):return PINS/(env+'.yml')

def atomic_pin(env,revisions):
  if not all(SHA.fullmatch(v) for v in revisions):
    raise RuntimeError('Only immutable API/ITSM SHAs can be pinned')
  PINS.mkdir(mode=0o700,parents=True,exist_ok=True)
  a,b=('control-server','itsm-web') if env=='uat' else ('api','itsm')
  content=(f'services:\n  {a}:\n    image: {IMAGE}api:sha-{revisions[0]}\n'
           f'  {b}:\n    image: {IMAGE}itsm:sha-{revisions[1]}\n')
  target=pinned_path(env)
  temporary=target.with_suffix('.tmp')
  if temporary.exists():raise RuntimeError('Release image lock temporary file exists')
  with temporary.open('x') as out:out.write(content)
  temporary.chmod(0o600)
  temporary.replace(target)
  return target

def assert_official_images(revisions):
  if not all(SHA.fullmatch(value) for value in revisions) or revisions[0]!=revisions[1]:
    raise RuntimeError('API and ITSM must use the exact same immutable commit')
  for service,sha in zip(('api','itsm'),revisions):
    image=IMAGE+service+':sha-'+sha
    run('docker','pull',image)
    result=json.loads(run('docker','image','inspect',image))
    if len(result)!=1 or (result[0]['Config'].get('Labels') or {}).get('org.opencontainers.image.revision')!=sha:
      raise RuntimeError('Official '+service+' image revision label is unverified')

def save_backup(env,job_id):
  directory=BACKUPS/(env+'-'+datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+job_id[:8])
  directory.mkdir(mode=0o700,parents=True,exist_ok=False)
  _,_,layers=compose_identity(env)
  for path in layers:
    if not path.is_file():raise RuntimeError('Lost Compose layer while preparing backup')
    digest=hashlib.sha256(str(path).encode()).hexdigest()[:16]
    dest=directory/('config-'+digest)
    dest.write_bytes(path.read_bytes())
    dest.chmod(0o600)
  previous=pinned_path(env)
  if previous.exists():
    (directory/'previous-image-pins.yml').write_bytes(previous.read_bytes())
    (directory/'previous-image-pins.yml').chmod(0o600)
  database=SERVICES[env][2]
  dump=directory/'postgres.dump'
  with dump.open('wb') as output:
    proc=subprocess.run(['docker','exec',database,'sh','-c',
      'exec pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc --no-owner --no-acl'],
      stdout=output,stderr=subprocess.PIPE)
  dump.chmod(0o600)
  if proc.returncode or dump.stat().st_size<1024:
    raise RuntimeError('Postgres backup creation failed; refuse deployment')
  with dump.open('rb') as stream:
    valid=subprocess.run(['docker','exec','-i',database,'pg_restore','--list'],
      stdin=stream,stdout=subprocess.DEVNULL,stderr=subprocess.PIPE)
  if valid.returncode:raise RuntimeError('Postgres backup integrity validation failed')
  (directory/'SHA256SUM').write_text(hashlib.sha256(dump.read_bytes()).hexdigest()+'\n')
  (directory/'SHA256SUM').chmod(0o600)
  log('Verified '+env+' database and Compose backup (operator-held, retained)')
  return directory

def report(env,status,revisions,release_ref='',detail=''):
  operator_request('/api/platform-operator/v1/deployments/report',{
    'environment':env,'status':status,'apiSha':revisions[0],
    'itsmSha':revisions[1],'releaseRef':release_ref,'detail':detail[:900]})

def heartbeat():
  reply=operator_request('/api/platform-operator/v1/deployments/executor-heartbeat',
    {'workerId':WORKER_ID,'capability':CAPABILITY})
  if not reply.get('acknowledged'):raise RuntimeError('Central release executor heartbeat rejected')

def verify_prerequisites():
  if os.getenv('HI5_ENABLE_SHARED_PROD_APP_RELEASES')!='yes':
    raise RuntimeError('Dedicated shared Production executor is deliberately disabled')
  if not TOKEN_FILE.is_file() or (TOKEN_FILE.stat().st_mode&0o077):
    raise RuntimeError('Release operator token is missing or not protected')
  if not PINS.is_relative_to(ROOT):
    raise RuntimeError('Release images lock directory must be inside deployment root')
  run('docker','compose','version')
  # Fail before claiming jobs if active runtime provenance or labels are bad.
  for env in ('uat','live'):
    cmd,_=compose(env)
    run(*cmd,'config','--quiet')
    observed(env)
  BACKUPS.mkdir(mode=0o700,parents=True,exist_ok=True)
  if not os.access(BACKUPS,os.W_OK):raise RuntimeError('Backup directory is not writable')

def deploy(job):
  uid=str(job.get('id','')).lower()
  source=str(job.get('fromEnvironment',''))
  target=str(job.get('toEnvironment',''))
  approved=(str(job.get('apiSha','')),str(job.get('itsmSha','')))
  release_ref=str(job.get('releaseRef') or '')
  if not UUID.fullmatch(uid):
    raise RuntimeError('Invalid job identifier')
  if (source,target) not in (('uat','live'),('dev','uat')):
    raise RuntimeError('Unsupported release transition')
  if observed(source)!=approved:
    raise RuntimeError('Source no longer serves the reviewed API and ITSM build')
  current=observed(target)
  if current==approved:
    report(target,'verified',approved,release_ref,'Already installed and healthy')
    return 'succeeded'
  assert_official_images(approved)
  backup=save_backup(target,uid)
  cmd,services=compose(target)
  report(target,'deploying',current,release_ref,'Verified pre-deployment backup')
  try:
    overlay=atomic_pin(target,approved)
    cmd,services=compose(target,overlay)
    run(*cmd,'config','--quiet')
    # Never start RMM, Admin, Caddy or database services during this update.
    if target=='live':
      run(*cmd,'run','--rm','--no-deps','api','node','dist/migrate.mjs')
    else:
      run(*cmd,'run','--rm','--no-deps','control-server','node','dist/migrate.mjs')
    for name in services:
      run(*cmd,'up','-d','--no-deps','--no-build','--pull','never','--wait',
        '--wait-timeout','180',name)
    if observed(target)!=approved:
      raise RuntimeError('Host image/public API health attestation mismatch')
    report(target,'verified',approved,release_ref,'Exact approved SHA installed and host-verified')
    return 'succeeded'
  except Exception as error:
    log('Application deployment failed; starting image-only rollback: '+str(error)[:220])
    try:
      overlay=atomic_pin(target,current)
      rollback,services=compose(target,overlay)
      run(*rollback,'config','--quiet')
      for name in services:
        run(*rollback,'up','-d','--no-deps','--no-build','--pull','never','--wait',
          '--wait-timeout','180',name)
      if observed(target)!=current:
        raise RuntimeError('Restored images do not match host-attested baseline')
      report(target,'rolled_back',current,release_ref,'Image rollback verified; DB backup retained')
      return 'rolled_back'
    except Exception as rollback_error:
      report(target,'failed',current,release_ref,'Operator/manual recovery required; backup retained')
      raise RuntimeError('Deployment and rollback failed: '+str(rollback_error)) from error

def run_once():
  reply=operator_request('/api/platform-operator/v1/deployments/claim',{})
  job=reply.get('job')
  if not job:return
  uid=str(job.get('id',''))
  log('Claimed approved application release job '+uid[:12])
  try:
    result=deploy(job)
    operator_request('/api/platform-operator/v1/deployments/jobs/'+uid+'/complete',
      {'status':result})
  except Exception as error:
    log('Deployment job failed; details recorded for review')
    operator_request('/api/platform-operator/v1/deployments/jobs/'+uid+'/complete',
      {'status':'failed','error':str(error)[:1000]})

def main():
  global TOKEN
  parser=argparse.ArgumentParser()
  parser.add_argument('action',choices=['preflight','watch','once'])
  args=parser.parse_args()
  # Even preflight is read-only; it never claims jobs or mutates services.
  if args.action=='preflight':
    for env in ('uat','live'):
      cmd,services=compose(env)
      run(*cmd,'config','--quiet')
      log(env+' image-service composition validated: '+','.join(services))
      try:log(env+' host-observed revisions: '+','.join(observed(env)))
      except Exception as error:log(env+' readiness BLOCKED: '+str(error))
    return
  verify_prerequisites()
  TOKEN=TOKEN_FILE.read_text().strip()
  if len(TOKEN)<32:raise RuntimeError('Operator service credential invalid')
  lock=ROOT/'deployment/app-release-executor.lock'
  with lock.open('a+') as file:
    fcntl.flock(file.fileno(),fcntl.LOCK_EX|fcntl.LOCK_NB)
    while True:
      verify_prerequisites()
      heartbeat()  # Only report readiness while safe and actually running.
      run_once()
      if args.action=='once':break
      time.sleep(30)

if __name__=='__main__':
  try:main()
  except Exception as error:
    log('Executor not ready: '+str(error)[:280])
    sys.exit(2)
