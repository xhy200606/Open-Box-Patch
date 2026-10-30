#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
const dir=path.resolve(process.argv[2]||'.')
const read=(name,otherwise)=>{try{return fs.readFileSync(path.join(dir,name),'utf8')}catch{return otherwise}}
const json=(name,fallback={})=>{try{return JSON.parse(read(name,''))}catch{return fallback}}
const lines=name=>read(name,'').split('\n').filter(Boolean).flatMap(x=>{try{return [JSON.parse(x)]}catch{return []}})
const status=json('status.json'),run=json('run.json'),c=run.config||{},minutes=lines('minutes.jsonl'),checks=lines('route-checks.jsonl'),events=lines('events.jsonl')
const fmt=t=>t?new Date(t).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai',hour12:false}):'未知'
const totals={}
for(const item of minutes)for(const [k,v]of Object.entries(item.categories||{})){totals[k]??={packets:0,wireBytes:0};totals[k].packets+=v.packets;totals[k].wireBytes+=v.wireBytes}
// status can contain a more recent cumulative checkpoint than minutes after a restart.
for(const [k,v]of Object.entries(status.totals||{}))if((totals[k]?.packets||0)<v.packets)totals[k]=v
const count=k=>totals[k]?.packets||0
let routeMismatch=0,routeErrors=0
for(const check of checks)for(const [key,results]of Object.entries(check.lookups||{})){
  if(!Array.isArray(results)){routeErrors++;continue}
  const role=key.split('_')[0],target=key.slice(role.length+1),expected=c.destinationOverrides?.[target]||role
  const gateways=[c.gateways?.[expected]]
  if(check.fallbackActive&&expected==='direct')gateways.push(c.gateways?.proxy)
  if(!results.some(r=>gateways.includes(r.gateway)&&r.dev===c.interface))routeMismatch++
}
const samples=minutes.flatMap(x=>x.samples||[]),wrong=count('proxy_unexpected_gateway')+count('direct_unexpected_gateway')
const gaps=[];let previous=new Date(run.start).getTime()
for(const item of minutes){const now=new Date(item.at).getTime();if(now-previous>95000)gaps.push({from:fmt(previous),to:fmt(now),seconds:Math.round((now-previous)/1000)});previous=now}
const dropped=[...read('tcpdump.log','').matchAll(/(\d+) packets dropped by kernel/g)].map(x=>Number(x[1]))
const output=[
'# OpenBox 分流探针报告','',
`状态：${status.state||'未知'}；计划时段：${fmt(run.start)} 至 ${fmt(run.deadline)}（北京时间）。`,
`最近统计：${fmt(status.at)}。实现方式：源地址策略路由，非自定义流量标记。`,'',
`代理源地址：${c.sources?.proxy} → ${c.gateways?.proxy}；直连源地址：${c.sources?.direct} → ${c.gateways?.direct}。`,'',
'| 分类 | 抓到的包数 | 线长累计字节 |','| --- | ---: | ---: |',
...Object.entries(totals).map(([key,v])=>`| ${key} | ${v.packets} | ${v.wireBytes} |`),'',
`代理与直连均观察到预期出站：${count('proxy_expected')>0&&count('direct_expected')>0?'是':'尚不充分'}。`,
`疑似错误下一跳包：${wrong}；路由查询偏离：${routeMismatch}；查询失败：${routeErrors}。`,
`抓包内核丢包计数（tcpdump 已输出的统计）：${dropped.length?dropped.join(', '):'尚未输出，通常在停止采集时输出'}。`,
`统计间隔超过 95 秒：${gaps.length} 处；原始抓包因存储不足暂停：${events.filter(e=>e.type==='pcap_paused_low_disk').length} 次。`,'',
'说明：expected 为源地址、实际目的 MAC 与预期上游吻合；configured_override 为现有 DNS 特殊规则；fallback 为监测到降级规则时经另一上游；unexpected_gateway 需结合当时路由变化核查。',
'unclassified_local_source 包括路由器其他服务及终端回包，不能据此认定漏分流。IPv6 仅记录，不能用 IPv4 源地址规则证明其分流。网桥可能重复观察同一包，包数与字节不是账单流量。',
'每分钟统计覆盖采集期间全部匹配包；样本每分钟最多 60 条、异常逐包样本最多 20 条，计数不受样本上限影响。PCAP 截取每包前 96 字节，最多 12 × 10 MiB 循环覆盖，仅保留最近原始包；重启/停机与丢包均会影响证据完整性。','',
'## 部分出口证据','',
...samples.filter(x=>['proxy_expected','direct_expected'].includes(x.category)).slice(0,12).map(x=>`- ${fmt(x.at)} ${x.category}: ${x.src} → ${x.dst}:${x.dport||''}，目的 MAC ${x.dstMac}`),
...(gaps.length?['','## 统计间隔异常','',...gaps.map(g=>`- ${g.from} 至 ${g.to}：${g.seconds} 秒`)]:[]),'',
'依据仅来自探针所在设备观察到的流量和路由。未覆盖未使用的节点、所有终端或其他设备内部的后续转发。',''
].join('\n')
console.log(output)
