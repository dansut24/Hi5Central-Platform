#!/usr/bin/env node
import {startReleasePublicationRelay} from './releasePublicationRelay.mjs'

const args=process.argv.slice(2)
if(args.some(arg=>!['--once','--preflight','--reconcile-only'].includes(arg)))
  throw Error('Use --preflight, --once, --reconcile-only, or omit flags for persistent relay.')
if(args.includes('--reconcile-only')&&args.includes('--preflight'))
  throw Error('Reconciliation and credential preflight must be separate.')
const result=await startReleasePublicationRelay({
  databaseUrlFile:process.env.DEV_DATABASE_URL_FILE,
  publicationTokenFile:process.env.RELEASE_PUBLICATION_TOKEN_FILE,
  allowedSha:process.env.RELEASE_PUBLICATION_ALLOWED_SHA,
  authority:process.env.CENTRAL_RELEASE_AUTHORITY_URL,
  preflight:args.includes('--preflight'),
  once:args.includes('--once')||args.includes('--reconcile-only'),
  reconcileOnly:args.includes('--reconcile-only'),
})
if(args.includes('--preflight')&&result.status==='preflight_pass')
  console.log('RELEASE_PUBLICATION_RELAY_PREFLIGHT_PASS sha='+result.allowedSha)
