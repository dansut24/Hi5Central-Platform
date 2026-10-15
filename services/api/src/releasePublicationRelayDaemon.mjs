#!/usr/bin/env node
import {startReleasePublicationRelay} from './releasePublicationRelay.mjs'

const args=process.argv.slice(2)
if(args.some(arg=>!['--once','--preflight'].includes(arg)))
  throw Error('Use --preflight or --once, or omit flags for a persistent relay.')
const result=await startReleasePublicationRelay({
  databaseUrlFile:process.env.DEV_DATABASE_URL_FILE,
  operatorTokenFile:process.env.RELEASE_OPERATOR_TOKEN_FILE,
  allowedSha:process.env.RELEASE_PUBLICATION_ALLOWED_SHA,
  authority:process.env.CENTRAL_RELEASE_AUTHORITY_URL,
  preflight:args.includes('--preflight'),
  once:args.includes('--once'),
})
if(args.includes('--preflight')&&result.status==='preflight_pass')
  console.log('RELEASE_PUBLICATION_RELAY_PREFLIGHT_PASS sha='+result.allowedSha)
