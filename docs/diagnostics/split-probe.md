# 同网桥分流探针

这是一份被动诊断工具，不修改网络、DHCP、防火墙或 OpenBox 设置。按设备当前的辅助源地址策略验证实际以太网下一跳，而不是假设自定义流量标记。

2026-10-30 在 `192.168.100.2` 部署的采集目录为 `/root/openbox-split-probe-20261030`；运行时间为北京时间 2026-10-30 21:26:34 至 2026-10-31 21:26:34。

当前验证目标：

| 流量 | OpenBox 源地址 | 预期下一跳 |
| --- | --- | --- |
| 代理 | 192.168.100.221 | 192.168.100.1 |
| 直连 | 192.168.100.222 | 192.168.100.4 |

已有 `223.5.5.5` 目的地址策略优先经直连出口，探针单独统计。探针也记录现有直连故障回退规则，区分回退和疑似错误出口。源地址、路由查询、实际目的 MAC 三者结合核查；只看路由表不能证明实际数据包路径。

## 查看与分析

以下命令在 .2 上执行：

```sh
/etc/init.d/openbox-split-probe status
cat /root/openbox-split-probe-20261030/status.json
/opt/open-box/node/bin/node /root/openbox-split-probe-20261030/report.mjs /root/openbox-split-probe-20261030 > /root/openbox-split-probe-20261030/report.md
cat /root/openbox-split-probe-20261030/report.md
```

采集结束会自动更新 `report.md`；采集中需要手动运行上述报告命令以获得最新报告。

- `minutes.jsonl`：每分钟分类包数、线长字节、有限样本；全天保留。
- `route-checks.jsonl`：每分钟带源地址与 OpenBox 原生标记的路由查询。
- `network-changes.jsonl`：路由、地址、网关 MAC、运行配置绑定摘要及核心进程变化；不保存节点密码。
- `anomalies.jsonl`：疑似错误网关包的样本。
- `capture-*.pcap`：每包前 96 字节的原始包，Wireshark 可读，最多 12 × 10 MiB 循环覆盖。**不保留全天所有原始包**。
- `tcpdump.log`：tcpdump 状态及停止时的内核丢包统计。
- `events.jsonl`、`run.json`、`status.json`：采集生命周期、截止时间、累计统计。

每分钟最多保存 60 条不同流量样本和 20 条异常逐包样本；计数覆盖全部匹配抓包，不受样本上限影响。剩余空间低于 80 MiB 时停止写入原始 PCAP，但继续统计。抓包范围是 br-lan 上以 .2 的 MAC 为源或目的的 IPv4、IPv6 和 ARP，网桥可能重复观察同一包，因此不作为流量计费依据。

IPv6 仅做单独记录，不能由 IPv4 源地址策略证明其分流。来自 .2 主地址的流量可能是系统服务或终端回包，不直接认定为漏分流。瞬间路由切换可能产生待核查样本；需要结合当时路由记录确认。

## 生命周期

探针由独立 procd 服务运行，SSH 断开后继续采集，24 小时截止后停止。开机启动已启用，若设备在截止前重启，会按原截止时间恢复；停机期间没有抓包，日志中的空档需计入分析。截止后重启设备不会开始新一轮 24 小时采集。

提前停止并保留结果：

```sh
/etc/init.d/openbox-split-probe stop
/etc/init.d/openbox-split-probe disable
```

确认分析完成后可停用服务并自行清理采集目录。探针不负责自动删除证据。

## 本地验证

```sh
node --test tests/split-probe.test.mjs
```

设备上已进行 15 秒真实抓包试运行，验证了 PCAP 可读性、分类、定时停止及 tcpdump 丢包记录。
