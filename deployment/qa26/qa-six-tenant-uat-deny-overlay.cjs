const fs=require('fs'),crypto=require('crypto');
const before=fs.readFileSync(process.argv[2],'utf8');
const originalSha='126c2c3a0ca0390028394c1c680578dfbced9bbf6d1faf7d870fda003b09f0ed';
if(crypto.createHash('sha256').update(before).digest('hex')!==originalSha)throw Error('Unexpected UAT source SHA');
const marker='  # H5C_QA26_MANAGED_UAT_DENY_END\n';
if(before.split(marker).length!==2||before.includes('H5C_SIX_TENANT_MANAGED_UAT_DENY'))throw Error('UAT policy marker collision');
const target=[];
for(const suffix of ['managed1-uat','managed2-uat','managed1-uat-portal','managed2-uat-portal']){
const id=suffix.replace(/-/g,'_');
target.push('  @six_'+id+' header X-Forwarded-Host '+suffix+'.hi5central.com','  handle @six_'+id+' {','    respond 404','  }');
}
const rmmAnchor='  # H5C_QA26_UAT_RMM_DENY_END\n';
if(before.split(rmmAnchor).length!==2)throw Error('Unexpected UAT RMM marker');
const rmm=[];
for(const suffix of ['managed1-uat-rmm','managed2-uat-rmm','custom1-uat-rmm','custom2-uat-rmm']){
const id=suffix.replace(/-/g,'_');
rmm.push('  @six_'+id+' header X-Forwarded-Host '+suffix+'.hi5central.com','  handle @six_'+id+' {','    respond 404','  }');
}
const after=before.replace(marker,'  # H5C_SIX_TENANT_MANAGED_UAT_DENY_BEGIN\n'+target.join('\n')+'\n  # H5C_SIX_TENANT_MANAGED_UAT_DENY_END\n'+marker).replace(rmmAnchor,'  # H5C_SIX_TENANT_UAT_RMM_DENY_BEGIN\n'+rmm.join('\n')+'\n  # H5C_SIX_TENANT_UAT_RMM_DENY_END\n'+rmmAnchor);
fs.writeFileSync(process.argv[3],after,{mode:0o600});
console.log('QA_SIX_UAT_CANDIDATE_CREATED',crypto.createHash('sha256').update(after).digest('hex'));
