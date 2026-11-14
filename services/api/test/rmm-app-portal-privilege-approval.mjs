import test from 'node:test'
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {checkBusinessReason,checkDecisionReason,approvalNeedsManualReview} from '../src/appPortalApprovalModel.js'
test('approval-required requests refuse missing or empty business reasons',()=>{
  for(const reason of [undefined,null,'','  ','Too short']) assert.ok(checkBusinessReason(reason))
  assert.equal(checkBusinessReason('I need this approved installer for customer support.'),null)
  assert.ok(checkBusinessReason('a'.repeat(2001)))
  assert.equal(checkBusinessReason('a'.repeat(2000)),null)
})
test('approval and denial require a substantive decision note',()=>{
  assert.ok(checkDecisionReason(''))
  assert.ok(checkDecisionReason('short'))
  assert.equal(checkDecisionReason('Approved for this managed device and revision.'),null)
  assert.ok(checkDecisionReason('a'.repeat(2001)))
})
test('uncertain dispatch is not returned to pending automatically',()=>{
  assert.equal(approvalNeedsManualReview('approved'),true)
  assert.equal(approvalNeedsManualReview('pending'),false)
  const src=readFileSync(new URL('../src/rmmAppPortal.js',import.meta.url),'utf8')
  assert.ok(src.includes("status='approved',decided_by_user_id"))
  assert.ok(src.includes("status='pending' RETURNING id"))
  assert.ok(src.includes("return c.json({error:'Approval recorded but installation delivery is uncertain"))
  assert.ok(src.includes("if (checkBusinessReason(businessReason))"))
  assert.ok(src.includes("if (checkDecisionReason(decisionNote))"))
  assert.ok(src.includes("revision.source_type==='catalogue'"))
  assert.ok(src.includes("assignment.intent === 'approval_required'"))
})
test('Windows desktop form collects business reason through authenticated Named Pipe',()=>{
  const main=readFileSync(new URL('../../../native/app-portal/Hi5Central.AppPortal/MainWindow.axaml.cs',import.meta.url),'utf8')
  const dialog=readFileSync(new URL('../../../native/app-portal/Hi5Central.AppPortal/ApprovalReasonDialog.cs',import.meta.url),'utf8')
  const broker=readFileSync(new URL('../../../native/app-portal/Hi5Central.AppPortal/Broker/WindowsNamedPipeAppPortalBroker.cs',import.meta.url),'utf8')
  const agent=readFileSync(new URL('../../../native/agent/Agent/chatpass_agent/src/platform/windows/windows_service.cpp',import.meta.url),'utf8')
  assert.ok(main.includes('ApprovalReasonDialog.ShowAsync'))
  assert.ok(main.includes('_broker.InstallAsync(card.Id, justification)'))
  assert.ok(dialog.includes('MinimumCharacters = 20'))
  assert.ok(dialog.includes('MaximumCharacters = 2000'))
  assert.ok(broker.includes('writer.WriteString("reason"'))
  assert.ok(agent.includes('body["identity"] = AppPortalClientIdentity(pipe)'))
  assert.ok(agent.includes('body["reason"] = reason.substr(0, 2000)'))
})
test('admin UI displays request reason and collects explicit reviewer note',()=>{
  const ui=readFileSync(new URL('../../../apps/rmm/src/features/rmm/RmmAppPortal.jsx',import.meta.url),'utf8')
  assert.ok(ui.includes('row.reason?.trim()'))
  assert.ok(ui.includes('setApprovalDecision'))
  assert.ok(ui.includes('decisionNote.trim()'))
  assert.ok(ui.includes("decideAppPortalRequest(requestId,decision,decisionNote.trim())"))
})
