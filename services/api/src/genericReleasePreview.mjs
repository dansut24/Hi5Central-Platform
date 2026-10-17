#!/usr/bin/env node
/**
 * Local or container control-plane generic scheduler DRY RUN.
 * No transaction writes, credential output, job creation or route activation.
 * Usage: DATABASE_URL=... node services/api/src/genericReleasePreview.mjs --sha SHA
 */
import pg from 'pg'
import {previewGenericCertifiedRelease} from './genericReleaseDiscovery.js'

const args=process.argv.slice(2)
if(args.length!==2||args[0]!=='--sha'||!/^[a-f0-9]{40}$/.test(args[1]))
 throw Error('Usage: --sha <exact approved 40-character release SHA>')
if(!/^postgres(?:ql)?:\/\//.test(process.env.DATABASE_URL||''))
 throw Error('Real PostgreSQL connection is required; never display DATABASE_URL')
const pool=new pg.Pool({connectionString:process.env.DATABASE_URL,
 max:1,connectionTimeoutMillis:5000,idleTimeoutMillis:10000})
const client=await pool.connect()
try{
 await client.query('BEGIN READ ONLY')
 await client.query("SET LOCAL statement_timeout='60000ms'")
 const result=await previewGenericCertifiedRelease(client,{sha:args[1]})
 console.log(JSON.stringify({type:'generic_release_preview',readOnly:true,
  globallyPaused:(await client.query(
   'SELECT paused FROM platform_release_rollout_control WHERE singleton=true'
  )).rows[0]?.paused,...result},null,2))
 await client.query('ROLLBACK')
}catch(error){
 await client.query('ROLLBACK').catch(()=>{})
 console.error(JSON.stringify({type:'generic_release_preview_error',
  code:error.code||'PREVIEW_FAILED',message:String(error.message).slice(0,350)}))
 process.exitCode=1
}finally{client.release();await pool.end()}
