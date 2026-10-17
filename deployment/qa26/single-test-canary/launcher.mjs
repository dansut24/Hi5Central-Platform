#!/usr/bin/env node
import {readFileSync,statSync} from 'node:fs'
import {qaTestBuildSha,requireQaTestJob} from '../../services/api/src/qaSixTestCohort.js'
const id=process.env.H5C_SINGLE_TEST_CANARY_JOB_ID
if(process.argv.slice(2).length!==1||process.argv[2]!=='--once'
  ||process.env.H5C_SINGLE_TEST_CANARY_JOB_ID!==id
  ||process.env.RELEASE_GATEWAY!=='test'
  ||!process.env.RELEASE_QA_TENANT_SLUGS
  ||process.env.RELEASE_WORKER_ID!=='single-test-canary-20261016'
  ||process.env.DATABASE_URL)
  throw Error('Dedicated canary launcher rejects other jobs, environments or DB env injection.')
requireQaTestJob({jobId:id,slug:process.env.RELEASE_QA_TENANT_SLUGS,
  environment:'test',buildSha:qaTestBuildSha})
const source=process.env.DATABASE_URL_FILE
if(source!=='/run/secrets/qa_canary_db_url')
  throw Error('Only the provisioned, read-only credential file is allowed.')
const st=statSync(source)
if(!st.isFile()||st.mode&0o077)throw Error('Private canary DB credential file is not restricted.')
const value=readFileSync(source,'utf8').trim()
const url=new URL(value)
if(!['postgres:','postgresql:'].includes(url.protocol)
  ||url.hostname!=='hi5central-postgres'||url.port!=='5432'
  ||url.username!=='hi5_release_qa_canary'||url.pathname!=='/hi5central')
  throw Error('Dedicated database connection identity mismatch.')
process.env.DATABASE_URL=value
await import('../../services/api/src/tenantReleaseExecutor.mjs')
