#!/usr/bin/env node
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import net from 'node:net'
import {execFile} from 'node:child_process'
import {promisify} from 'node:util'
const exec=promisify(execFile)
import {domainToASCII,fileURLToPath} from 'node:url'
import {createHash} from 'node:crypto'
function hostName(value){
  if(typeof value!=='string')return ''
  const h=domainToASCII(value.trim().toLowerCase().replace(/\.$/,''))
  return h && !net.isIP(h) && h.length<=253 && h.split('.').every(x=>/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(x)) ? h : ''
}
// Only infer decisions from rules that cover an entire hostname. URL paths and
// scheme-only rules cannot be inferred from Clash connection host metadata.
export function compileGfwList(text){
  if(!text.includes('[AutoProxy'))text=Buffer.from(text.replace(/\s/g,''),'base64').toString('utf8')
  if(!text.startsWith('[AutoProxy'))throw Error('Not a GFWList AutoProxy document')
  const lists={proxy:new Map(),exception:new Map()},wildcards={proxy:[],exception:[]},unsupported=[]
  for(const raw of text.split(/\r?\n/)){
    const line=raw.trim();if(!line||/^[!\[]/.test(line))continue
    const exception=line.startsWith('@@'),rule=exception?line.slice(2):line,kind=exception?'exception':'proxy'
    let domain=rule.startsWith('||')?rule.slice(2):rule.startsWith('.')?rule.slice(1):rule
    domain=domain.replace(/\^$/,'')
    if(/[\/$|]/.test(domain)||domain.includes('^')){unsupported.push({rule:line,exception});continue}
    if(domain.includes('*')){
      if(!rule.startsWith('||') || !/^[a-z0-9.*-]+$/i.test(domain)){unsupported.push({rule:line,exception});continue}
      const source=domain.split('*').map(x=>x.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')).join('[a-z0-9.-]*')
      wildcards[kind].push({regex:new RegExp('(?:^|\\.)'+source+'$','i'),rule:line});continue
    }
    domain=hostName(domain)
    if(!domain){unsupported.push({rule:line,exception});continue}
    lists[kind].set(domain,line)
  }
  const match=(host,kind)=>{
    const parts=host.split('.');for(let i=0;i<parts.length;i++){const r=lists[kind].get(parts.slice(i).join('.'));if(r)return r}
    return wildcards[kind].find(x=>x.regex.test(host))?.rule
  }
  // A path-specific exception on a host makes host-only inference uncertain.
  const uncertainExceptions=unsupported.filter(x=>x.exception).map(x=>{
    const plain=x.rule.slice(2).replace(/^\|?https?:\/\//,'').replace(/^\|\|/,'').replace(/^\./,'')
    const domain=hostName(plain.split(/[\/$^]/)[0]);
    const regexScopes=x.rule.startsWith('@@/')?(x.rule.slice(2).match(/[a-z0-9-]+(?:\\\.[a-z0-9-]+)+/gi)||[]).map(v=>hostName(v.replaceAll('\\.','.'))).filter(Boolean):[]
    return {domain,regexScopes,rule:x.rule}
  })
  return {
    metadata:{sha256:createHash('sha256').update(text).digest('hex'),lastModified:text.match(/^! Last Modified:\s*(.+)$/m)?.[1]||'',supportedDomainRules:lists.proxy.size+lists.exception.size+wildcards.proxy.length+wildcards.exception.length,unsupportedRules:unsupported.length,unsupportedExceptions:unsupported.filter(x=>x.exception).length},
    unsupported,
    lookup(value){const host=hostName(value);if(!host)return {expectation:'unknown',reason:'no_domain'}
      const exception=match(host,'exception');if(exception)return {host,expectation:'exception',matchedRule:exception}
      const proxy=match(host,'proxy');if(!proxy)return {host,expectation:'not_listed'}
      const uncertain=uncertainExceptions.find(x=>[x.domain,...x.regexScopes].filter(Boolean).some(d=>host===d||host.endsWith('.'+d)))
      if(uncertain)return {host,expectation:'uncertain',matchedRule:proxy,exceptionRule:uncertain.rule}
      return {host,expectation:'proxy',matchedRule:proxy}
    },
  }
}
const virtual=new Set(['selector','urltest','dns'])
export function auditConnection(conn,config,list){
  const reference=list.lookup(conn.metadata?.host),byTag=new Map((config.outbounds||[]).map(n=>[n.tag,n]))
  const nodes=(conn.chains||[]).map(tag=>byTag.get(tag)).filter(Boolean),physical=nodes.filter(n=>!virtual.has(n.type))
  let actual='unknown'
  if(physical.some(n=>n.type==='block'))actual='blocked'
  else if(physical.some(n=>n.type!=='direct'))actual='proxy'
  else if(physical.some(n=>n.type==='direct'))actual='direct'
  const status=reference.expectation==='proxy'?(actual==='proxy'?'reference_proxy_selected':actual==='direct'?'gfw_direct_mismatch':actual==='blocked'?'gfw_blocked':'gfw_unverifiable'):
    reference.expectation==='exception'?'gfw_exception':reference.expectation==='not_listed'?'not_listed_'+actual:'reference_unknown'
  return {id:conn.id,start:conn.start,host:reference.host||conn.metadata?.host||'',destinationIP:conn.metadata?.destinationIP||'',destinationPort:conn.metadata?.destinationPort||'',network:conn.metadata?.network,reference,status,actual,rule:conn.rule||'',rulePayload:conn.rulePayload||'',chains:conn.chains||[],bindings:physical.map(n=>({tag:n.tag,type:n.type,source:n.inet4_bind_address||'',interface:n.bind_interface||'',detour:n.detour||''})),evidence:'OpenBox connection chain; per-flow Ethernet next hop not proven by this record'}
}
async function run(dir){
  process.umask(0o077)
  const config=JSON.parse(await fsp.readFile(path.join(dir,'config.json'),'utf8')),runInfo=JSON.parse(await fsp.readFile(path.join(dir,'run.json'),'utf8'))
  const deadline=new Date(runInfo.deadline).getTime();if(deadline<=Date.now())return
  const raw=await fsp.readFile(path.join(dir,'gfwlist.txt'),'utf8'),list=compileGfwList(raw)
  const atomic=async(name,value)=>{const file=path.join(dir,name),tmp=file+'.tmp';await fsp.writeFile(tmp,JSON.stringify(value,null,2));await fsp.rename(tmp,file)}
  const append=(name,value)=>fs.appendFileSync(path.join(dir,name),JSON.stringify(value)+'\n')
  const prior=await fsp.readFile(path.join(dir,'policy-status.json'),'utf8').then(JSON.parse,()=>({}))
  const totals=prior.totals||{},seen=new Map(),minute={},errors=prior.apiErrors||0
  let apiErrors=errors,polls=prior.polls||0,closing=false,busy=false,details=prior.detailRecords||0,lastWrite=0,lastRuntime='',runtime=null,lastMismatchSample=0,headerBytes=0
  const auditStarted=prior.auditStarted||new Date().toISOString()
  await atomic('gfw-parser.json',{...list.metadata,unsupported:list.unsupported})
  append('policy-events.jsonl',{at:new Date().toISOString(),type:'started',deadline:runInfo.deadline,list:list.metadata})
  async function checkpoint(state='running'){
    await atomic('policy-status.json',{state,at:new Date().toISOString(),auditStarted,deadline:runInfo.deadline,reference:list.metadata,polls,apiErrors,totals,detailRecords:details,pollIntervalSeconds:2,detailLimit:100000,coverage:'Only connections alive at polling time, hostname available, supported host-level GFWList rules. No retroactive classification of old IP-only captures.'})
  }
  async function poll(){if(busy||closing)return;busy=true;try{
    const file=path.join(config.root,'data/multi-backend/egress-runtime.json'),stat=await fsp.stat(file),key=stat.mtimeMs+':'+stat.size
    if(key!==lastRuntime){runtime=JSON.parse(await fsp.readFile(file,'utf8'));lastRuntime=key}
    const api=runtime.experimental?.clash_api
    if(!api?.external_controller)throw Error('Clash controller unavailable')
    // Controller address comes from local config, but never contact a remote host.
    let controller=api.external_controller.replace(/^0\.0\.0\.0:/,'127.0.0.1:')
    if(!/^(127\.0\.0\.1|localhost):\d+$/.test(controller))throw Error('Controller must listen on local IPv4 loopback')
    const res=await fetch('http://'+controller+'/connections',{headers:api.secret?{Authorization:'Bearer '+api.secret}:{},signal:AbortSignal.timeout(3000)})
    if(!res.ok)throw Error('Controller HTTP '+res.status)
    const data=await res.json();if(!Array.isArray(data.connections))throw Error('Invalid connections response')
    polls++;const now=Date.now()
    for(const conn of data.connections){
      const item=auditConnection(conn,runtime,list),fingerprint=JSON.stringify([item.host,item.status,item.chains,item.rule,item.bindings])
      const id=conn.id||JSON.stringify([conn.metadata?.sourceIP,conn.metadata?.sourcePort,item.host,item.destinationPort,conn.start])
      const old=seen.get(id);seen.set(id,{fingerprint,at:now});if(old?.fingerprint===fingerprint)continue
      totals[item.status]=(totals[item.status]||0)+1;minute[item.status]=(minute[item.status]||0)+1
      // Matched proxy requirements, exceptions, unknown coverage and mismatches
      // are retained. Never include controller tokens or node passwords.
      if(item.reference.expectation!=='not_listed' && item.host && details<100000 && headerBytes<30*1024*1024){
        const line={at:new Date().toISOString(),...item};const serialized=JSON.stringify(line)
        if(item.status!=='gfw_direct_mismatch'||now-lastMismatchSample>1000){append('policy-observations.jsonl',line);headerBytes+=Buffer.byteLength(serialized);details++;if(item.status==='gfw_direct_mismatch')lastMismatchSample=now}
      }
    }
    for(const [id,v]of seen)if(now-v.at>600000)seen.delete(id)
    if(now-lastWrite>=60000){append('policy-minutes.jsonl',{at:new Date().toISOString(),observations:{...minute},activeConnections:data.connections.length,apiErrors});for(const k of Object.keys(minute))delete minute[k];await checkpoint();lastWrite=now}
  }catch(e){apiErrors++;if(apiErrors<=20||apiErrors%30===0)append('policy-events.jsonl',{at:new Date().toISOString(),type:'api_error',error:e.message})}finally{busy=false}}
  const interval=setInterval(poll,2000),timer=setTimeout(()=>stop('completed'),deadline-Date.now())
  async function stop(state){if(closing)return;closing=true;clearInterval(interval);clearTimeout(timer);while(busy)await new Promise(r=>setTimeout(r,50));append('policy-minutes.jsonl',{at:new Date().toISOString(),final:true,observations:minute,apiErrors});await checkpoint(state);try{const script=path.join(dir,'report.mjs');if(fs.existsSync(script)){const result=await exec(process.execPath,[script,dir],{timeout:15000,maxBuffer:1024*1024});await fsp.writeFile(path.join(dir,'report.md'),result.stdout)}}catch(e){append('policy-events.jsonl',{at:new Date().toISOString(),type:'report_error',error:e.message})}}
  process.once('SIGTERM',()=>stop('stopped'));process.once('SIGINT',()=>stop('stopped'))
  await poll();await checkpoint()
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))run(path.resolve(process.argv[2]||'.')).catch(e=>{console.error(e.message);process.exitCode=1})
