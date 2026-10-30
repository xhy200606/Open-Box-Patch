#!/usr/bin/env node
// Passive 24h split-routing probe. Never changes network, firewall or OpenBox.
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import {spawn, execFile} from 'node:child_process'
import {promisify} from 'node:util'
import {createHash} from 'node:crypto'
import {fileURLToPath} from 'node:url'
const exec = promisify(execFile)
const mac = b => [...b].map(x=>x.toString(16).padStart(2,'0')).join(':')
const ipv4 = (b,o) => [...b.subarray(o,o+4)].join('.')
export function packetInfo(b) {
  if(b.length<14)return null
  const p={srcMac:mac(b.subarray(6,12)),dstMac:mac(b.subarray(0,6))}
  let offset=14, type=b.readUInt16BE(12)
  for(let n=0;n<2 && [0x8100,0x88a8].includes(type);n++){if(b.length<offset+4)return null;type=b.readUInt16BE(offset+2);offset+=4}
  if(type===0x0800){
    if(b.length<offset+20 || b[offset]>>>4!==4)return null
    const ihl=(b[offset]&15)*4;if(ihl<20 || b.length<offset+ihl)return null
    Object.assign(p,{family:4,src:ipv4(b,offset+12),dst:ipv4(b,offset+16),protocol:b[offset+9]})
    const fragmented=Boolean(b.readUInt16BE(offset+6)&0x1fff);offset+=ihl
    if(!fragmented && [6,17].includes(p.protocol) && b.length>=offset+4){p.sport=b.readUInt16BE(offset);p.dport=b.readUInt16BE(offset+2)}
  }else if(type===0x86dd){
    if(b.length<offset+40)return null
    const ip6=o=>Array.from({length:8},(_,i)=>b.readUInt16BE(o+i*2).toString(16)).join(':')
    Object.assign(p,{family:6,src:ip6(offset+8),dst:ip6(offset+24),protocol:b[offset+6]})
  }else if(type===0x0806)return {...p,family:'arp'}
  else return null
  return p
}
export class PcapReader {
  constructor(onHeader,onPacket){this.buffer=Buffer.alloc(0);this.onHeader=onHeader;this.onPacket=onPacket;this.header=null}
  push(data){
    this.buffer=Buffer.concat([this.buffer,data])
    if(!this.header){
      if(this.buffer.length<24)return
      const magic=this.buffer.readUInt32LE(0)
      if(![0xa1b2c3d4,0xa1b23c4d,0xd4c3b2a1,0x4d3cb2a1].includes(magic))throw Error('Unsupported PCAP magic')
      this.little=[0xa1b2c3d4,0xa1b23c4d].includes(magic);this.nano=[0xa1b23c4d,0x4d3cb2a1].includes(magic)
      this.u32=(b,o)=>this.little?b.readUInt32LE(o):b.readUInt32BE(o)
      if(this.u32(this.buffer,20)!==1)throw Error('Probe requires Ethernet PCAP')
      this.header=Buffer.from(this.buffer.subarray(0,24));this.buffer=this.buffer.subarray(24);this.onHeader(this.header)
    }
    while(this.buffer.length>=16){
      const n=this.u32(this.buffer,8);if(n>65535)throw Error('Invalid captured length')
      if(this.buffer.length<16+n)return
      const record=this.buffer.subarray(0,16+n)
      this.onPacket(record.subarray(16),this.u32(record,12),this.u32(record,0)*1000+this.u32(record,4)/(this.nano?1e6:1e3),record)
      this.buffer=this.buffer.subarray(16+n)
    }
  }
}
export function classify(p,c){
  if(!p)return 'undecoded'
  if(p.family==='arp')return 'arp'
  const role=Object.entries(c.sources).find(([,ip])=>ip===p.src)?.[0]
  const returning=Object.entries(c.sources).find(([,ip])=>ip===p.dst)?.[0]
  if(p.srcMac!==c.localMac)return returning?'return_'+returning:'incoming_other'
  if(p.family===6)return 'ipv6_unclassified'
  if(!role)return 'unclassified_local_source'
  if(p.dst.startsWith(c.lanPrefix))return role+'_lan'
  // Installed DNS destination rule precedes source rules (observed on this device).
  const expected=c.destinationOverrides?.[p.dst] || role
  if(p.dstMac===c.gatewayMacs[expected])return expected===role?role+'_expected':role+'_configured_override'
  if(c.fallbackActive && role==='direct' && p.dstMac===c.gatewayMacs.proxy)return 'direct_fallback'
  return role+'_unexpected_gateway'
}
async function main(configFile){
  process.umask(0o077)
  const c=JSON.parse(await fsp.readFile(configFile,'utf8')),dir=c.output
  await fsp.mkdir(dir,{recursive:true,mode:0o700})
  let lock
  try{lock=await fsp.open(path.join(dir,'probe.lock'),'wx');await lock.writeFile(String(process.pid))}
  catch(e){if(e.code!=='EEXIST')throw e;const pid=Number(await fsp.readFile(path.join(dir,'probe.lock'),'utf8'));let alive=false;try{process.kill(pid,0);alive=true}catch{}if(alive)throw Error('Probe already running');await fsp.unlink(path.join(dir,'probe.lock'));lock=await fsp.open(path.join(dir,'probe.lock'),'wx');await lock.writeFile(String(process.pid))}
  const atomic=async(name,value)=>{const tmp=path.join(dir,name+'.tmp');await fsp.writeFile(tmp,JSON.stringify(value,null,2));await fsp.rename(tmp,path.join(dir,name))}
  const append=(name,value)=>fs.appendFileSync(path.join(dir,name),JSON.stringify(value)+'\n')
  let meta
  try{meta=JSON.parse(await fsp.readFile(path.join(dir,'run.json'),'utf8'))}catch{
    const start=Date.now();meta={start:new Date(start).toISOString(),deadline:new Date(start+(c.durationSeconds||86400)*1000).toISOString(),config:c};await atomic('run.json',meta)
  }
  const remaining=new Date(meta.deadline).getTime()-Date.now()
  if(remaining<=0){await atomic('status.json',{state:'expired',at:new Date().toISOString()});await lock.close();await fsp.unlink(path.join(dir,'probe.lock'));return}
  const initial=await fsp.readFile(path.join(dir,'status.json'),'utf8').then(JSON.parse,()=>({}))
  const totals=initial.totals||{},minute={},samples=new Map()
  let packets=initial.packets||0,bytes=initial.bytes||0,undecoded=initial.undecoded||0,anomalies=0,closing=false,lastHash='',lastMacs='',fd=null,fileBytes=0,ringIndex=0,header=null,writing=true,ringPackets=0
  const event=(type,extra={})=>append('events.jsonl',{at:new Date().toISOString(),type,...extra})
  function openRing(){
    if(fd!==null)fs.closeSync(fd)
    const filename='capture-'+String(ringIndex%12).padStart(2,'0')+'.pcap';ringIndex++
    fd=fs.openSync(path.join(dir,filename),'w',0o600);fs.writeSync(fd,header);fileBytes=24
    event('pcap_rotate',{filename})
  }
  const reader=new PcapReader(h=>{header=h;if(writing)openRing()},(buf,wireLength,timestamp,record)=>{
    if(writing){if(fileBytes+record.length>10*1024*1024)openRing();fs.writeSync(fd,record);fileBytes+=record.length;ringPackets++}
    const p=packetInfo(buf),category=classify(p,c)
    packets++;bytes+=wireLength;if(!p)undecoded++
    totals[category]??={packets:0,wireBytes:0};totals[category].packets++;totals[category].wireBytes+=wireLength
    minute[category]??={packets:0,wireBytes:0};minute[category].packets++;minute[category].wireBytes+=wireLength
    const key=p?[category,p.src,p.dst,p.protocol,p.dport,p.dstMac].join('|'):category
    if(!samples.has(key) && samples.size<60)samples.set(key,{category,at:new Date(timestamp).toISOString(),...p})
    if(category.includes('unexpected')){anomalies++;if(anomalies<=20)append('anomalies.jsonl',{category,at:new Date(timestamp).toISOString(),...p})}
  })
  const filter=`(ether src ${c.localMac} or ether dst ${c.localMac}) and (ip or ip6 or arp)`
  const child=spawn('tcpdump',['-i',c.interface,'-n','-s','96','-B','4096','-U','-w','-',filter],{stdio:['ignore','pipe','pipe']})
  const captureLog=fs.createWriteStream(path.join(dir,'tcpdump.log'),{flags:'a',mode:0o600})
  child.stderr.pipe(captureLog,{end:false})
  let failed=null
  child.stdout.on('data',b=>{try{reader.push(b)}catch(e){failed=e.message;event('capture_error',{error:e.message});stop('capture_error')}})
  child.on('error',e=>{failed=e.message;stop('spawn_error')})
  const exited=new Promise(resolve=>child.on('close',(code,signal)=>resolve({code,signal})))
  async function status(state='running'){
    await atomic('status.json',{state,at:new Date().toISOString(),pid:process.pid,started:meta.start,deadline:meta.deadline,packets,bytes,undecoded,totals,pcapEnabled:writing,ringPackets,ringMaxBytes:120*1024*1024,error:failed})
  }
  async function snapshot(){
    const out={at:new Date().toISOString()}
    for(const [name,args] of Object.entries({rules4:['-j','-4','rule','show'],rules6:['-j','-6','rule','show'],routes4:['-j','-4','route','show','table','all'],routes6:['-j','-6','route','show','table','all'],neighbors:['-j','neigh','show','dev',c.interface],addresses:['-j','addr','show','dev',c.interface]})){
      try{out[name]=JSON.parse((await exec('ip',args,{timeout:5000,maxBuffer:2*1024*1024})).stdout)}catch(e){out[name]={error:e.message}}
    }
    c.fallbackActive=Array.isArray(out.rules4)&&out.rules4.some(r=>r.src?.split('/')[0]===c.sources.direct && Number(r.table)===22031 && r.priority<8702)
    for(const [role,gateway] of Object.entries(c.gateways)){
      const entry=Array.isArray(out.neighbors)&&out.neighbors.find(n=>n.dst===gateway&&n.lladdr)
      if(entry)c.gatewayMacs[role]=entry.lladdr.toLowerCase()
    }
    if(JSON.stringify(c.gatewayMacs)!==lastMacs){lastMacs=JSON.stringify(c.gatewayMacs);event('gateway_macs',{macs:c.gatewayMacs})}
    out.gatewayMacs=c.gatewayMacs;out.fallbackActive=c.fallbackActive
    out.lookups={}
    for(const [role,source] of Object.entries(c.sources))for(const dest of ['1.1.1.1','223.6.6.6','223.5.5.5']){
      try{out.lookups[role+'_'+dest]=JSON.parse((await exec('ip',['-j','-4','route','get',dest,'from',source,'mark','0x2024'],{timeout:4000})).stdout)}catch(e){out.lookups[role+'_'+dest]={error:e.message}}
    }
    try{
      const p=path.join(c.root,'data/multi-backend/egress-runtime.json'),text=await fsp.readFile(p,'utf8'),runtime=JSON.parse(text)
      out.runtimeHash=createHash('sha256').update(text).digest('hex')
      const groups={}
      for(const n of runtime.outbounds||[]){const k=JSON.stringify({type:n.type,source:n.inet4_bind_address,interface:n.bind_interface,mark:n.routing_mark,detour:Boolean(n.detour)});groups[k]=(groups[k]||0)+1}
      out.bindings=groups
      const pids=await fsp.readdir('/proc');out.core=[]
      for(const pid of pids.filter(p=>/^\d+$/.test(p))){const raw=await fsp.readFile('/proc/'+pid+'/cmdline','utf8').catch(()=> '');if(raw.includes('sing-box')&&raw.includes('run\0'))out.core.push({pid:Number(pid),runtime:raw.includes(p)})}
    }catch(e){out.runtimeError=e.message}
    const hash=createHash('sha256').update(JSON.stringify({...out,at:undefined,neighbors:undefined})).digest('hex')
    if(hash!==lastHash){lastHash=hash;append('network-changes.jsonl',out)}
    append('route-checks.jsonl',{at:out.at,lookups:out.lookups,fallbackActive:out.fallbackActive,runtimeHash:out.runtimeHash,core:out.core})
    const stat=await fsp.statfs(dir),free=stat.bavail*stat.bsize
    if(free<80*1024*1024&&writing){writing=false;event('pcap_paused_low_disk',{freeBytes:free})}
  }
  let tickBusy=false
  async function tick(){if(tickBusy||closing)return;tickBusy=true;try{
    append('minutes.jsonl',{at:new Date().toISOString(),categories:{...minute},samples:[...samples.values()],anomalies})
    for(const k of Object.keys(minute))delete minute[k];samples.clear();anomalies=0
    await snapshot();await status()
  }catch(e){event('tick_error',{error:e.message})}finally{tickBusy=false}}
  let finishResolve;const done=new Promise(r=>finishResolve=r)
  async function stop(reason){if(closing)return;closing=true;clearInterval(interval);clearTimeout(timer)
    child.kill('SIGINT');const kill=setTimeout(()=>child.kill('SIGKILL'),5000);const result=await exited;clearTimeout(kill)
    while(tickBusy)await new Promise(r=>setTimeout(r,50))
    append('minutes.jsonl',{at:new Date().toISOString(),final:true,categories:minute,samples:[...samples.values()],anomalies})
    if(fd!==null){fs.fsyncSync(fd);fs.closeSync(fd);fd=null}
    event('stopped',{reason,...result,trailingPcapBytes:reader.buffer.length});await status(reason==='deadline'?'completed':reason)
    captureLog.end();await lock.close();await fsp.unlink(path.join(dir,'probe.lock'));finishResolve()
  }
  const interval=setInterval(tick,60000),timer=setTimeout(()=>stop('deadline'),remaining)
  process.on('SIGTERM',()=>stop('stopped_by_signal'));process.on('SIGINT',()=>stop('stopped_by_signal'))
  event('started',{pid:process.pid,filter,deadline:meta.deadline,method:'source-address policy routing',snaplen:96})
  try{await snapshot();await status()}catch(e){event('startup_snapshot_error',{error:e.message});await status()}
  exited.then(r=>{if(!closing){failed='tcpdump exited unexpectedly: '+JSON.stringify(r);stop('capture_exited')}})
  await done
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===path.resolve(process.argv[1]))main(process.argv[2]).catch(e=>{console.error(e);process.exitCode=1})
