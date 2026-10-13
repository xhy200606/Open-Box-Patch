/**
 * [Open-Box Patch] 文案。
 *
 * 与 zashboard 的 `earth*` 词条逐条对齐（含简体 / 繁体 / 英文），
 * 另加少量补丁自有的提示（服务端代理相关）。
 */
type Dict = Record<string, string>

const ZH: Dict = {
  globeTitle: '全球连接',
  projection: '投影方式',
  visualStyle: '地球样式',
  visualStyle_space: '星空',
  visualStyle_flat: '扁平',
  originAPI: '公网 IP 服务',
  localIP: '本机 IP',
  toggleIP: '显示或隐藏本机 IP',
  hideCityLabels: '隐藏城市名称',
  showCityLabels: '显示城市名称',
  pauseRotation: '停止地球自转',
  resumeRotation: '继续地球自转',
  expand: '扩展地球画面',
  collapse: '还原地球画面',
  legend: '端点图例',
  legendProxied: '经代理',
  legendRelay: '经中转',
  role_relay: '经中转',
  showRelays: '显示转发',
  relayUnavailable: '暂无法读取中转节点，仍显示最终目标线路。',
  relayIncomplete: '部分中转节点无法识别或定位，转发路径可能不完整。',
  role_origin: '本机',
  role_destination: '目的地',
  direct: '直连',
  databaseChecking: '正在检查本地城市数据库…',
  databaseLoading: '正在加载缓存的城市数据库…',
  databaseConsentTitle: '下载本地城市数据库？',
  databaseConsent:
    '所有连接端点都只在此浏览器中查询。DB-IP City Lite 下载约需 {download}，解压后约占 {stored} 本地存储空间。',
  databaseConsentSource: '数据库由本机的多后端代理转发，只需从局域网下载一次。',
  databaseCacheRecovered: '已移除损坏的数据库缓存，请下载完整副本以恢复定位。',
  databaseDownload: '下载数据库',
  databaseDownloading: '正在下载城市数据库',
  databaseLearnMore: '了解 DB-IP City Lite',
  originError: '无法探测本机公网 IP，请重试后再定位连接。',
  noConnections: '暂无活跃连接',
  noLocatedConnections: '无法定位当前活跃连接的端点',
  endpointRole: '角色',
  topDownloadedHosts: '下载量 Top 5 Host',
  rendererError: '当前浏览器无法使用 3D 渲染。',
  getting: '获取中...',
  testFailed: '测速超时',
  retry: '重试',
  cancel: '取消',
  unknown: '未知',
  connectionCount: '连接数',
  proxyMissing: '未检测到本机的多后端代理服务，无法下载城市数据库与探测公网 IP。',
  databaseError_space: '浏览器可用存储空间不足，无法保存城市数据库。',
  databaseError_network: '城市数据库下载失败。',
  databaseError_decompress: '城市数据库解压失败。',
  databaseError_invalid: '下载的城市数据库无效。',
  databaseError_storage: '无法将城市数据库保存到浏览器存储。',
  databaseError_unsupported: '当前浏览器无法解压城市数据库。',
  databaseError_unknown: '无法加载城市数据库。',
}

const TW: Dict = {
  ...ZH,
  globeTitle: '全球連接',
  visualStyle: '地球樣式',
  originAPI: '公網 IP 服務',
  localIP: '本機 IP',
  toggleIP: '顯示或隱藏本機 IP',
  hideCityLabels: '隱藏城市名稱',
  showCityLabels: '顯示城市名稱',
  pauseRotation: '停止地球自轉',
  resumeRotation: '繼續地球自轉',
  expand: '展開地球畫面',
  collapse: '還原地球畫面',
  legendProxied: '經代理',
  legendRelay: '經中轉',
  role_relay: '經中轉',
  showRelays: '顯示轉發',
  relayUnavailable: '暫無法讀取中轉節點，仍顯示最終目標線路。',
  relayIncomplete: '部分中轉節點無法辨識或定位，轉發路徑可能不完整。',
  role_origin: '本機',
  direct: '直連',
  databaseChecking: '正在檢查本機城市資料庫…',
  databaseLoading: '正在載入快取的城市資料庫…',
  databaseConsentTitle: '下載本機城市資料庫？',
  databaseConsent:
    '所有連接端點都只在此瀏覽器中查詢。DB-IP City Lite 下載約需 {download}，解壓後約占 {stored} 本機儲存空間。',
  databaseConsentSource: '資料庫由本機的多後端代理轉發，只需從區域網路下載一次。',
  databaseCacheRecovered: '已移除損壞的資料庫快取，請下載完整副本以恢復定位。',
  databaseDownload: '下載資料庫',
  databaseDownloading: '正在下載城市資料庫',
  databaseLearnMore: '瞭解 DB-IP City Lite',
  originError: '無法偵測本機公網 IP，請重試後再定位連接。',
  noConnections: '暫無作用中的連接',
  noLocatedConnections: '無法定位目前作用中連接的端點',
  rendererError: '目前瀏覽器無法使用 3D 渲染。',
  getting: '獲取中...',
  testFailed: '測速超時',
  retry: '重試',
  cancel: '取消',
  unknown: '未知',
  connectionCount: '連接數',
  proxyMissing: '未偵測到本機的多後端代理服務，無法下載城市資料庫與探測公網 IP。',
  databaseError_space: '瀏覽器可用儲存空間不足，無法儲存城市資料庫。',
  databaseError_network: '城市資料庫下載失敗。',
  databaseError_decompress: '城市資料庫解壓失敗。',
  databaseError_invalid: '下載的城市資料庫無效。',
  databaseError_storage: '無法將城市資料庫儲存到瀏覽器。',
  databaseError_unsupported: '目前瀏覽器無法解壓城市資料庫。',
  databaseError_unknown: '無法載入城市資料庫。',
}

const EN: Dict = {
  globeTitle: 'Global connections',
  projection: 'Projection',
  visualStyle: 'Globe style',
  visualStyle_space: 'Space',
  visualStyle_flat: 'Flat',
  originAPI: 'Public IP service',
  localIP: 'Local IP',
  toggleIP: 'Show or hide local IP',
  hideCityLabels: 'Hide city names',
  showCityLabels: 'Show city names',
  pauseRotation: 'Pause globe rotation',
  resumeRotation: 'Resume globe rotation',
  expand: 'Expand globe view',
  collapse: 'Restore globe view',
  legend: 'Endpoint legend',
  legendProxied: 'Via proxy',
  legendRelay: 'Via relay',
  role_relay: 'Relay',
  showRelays: 'Show forwarding',
  relayUnavailable: 'Relay data is unavailable. Final destinations are still shown.',
  relayIncomplete: 'Some relay nodes cannot be identified or located. Paths may be incomplete.',
  role_origin: 'Local device',
  role_destination: 'Destination',
  direct: 'Direct',
  databaseChecking: 'Checking the local city database…',
  databaseLoading: 'Loading the cached city database…',
  databaseConsentTitle: 'Download the local city database?',
  databaseConsent:
    'Connection endpoints stay in this browser. DB-IP City Lite requires about {download} to download and {stored} of local storage after extraction.',
  databaseConsentSource:
    'The database is mirrored by this host’s multi-backend proxy, so it is fetched over the LAN only once.',
  databaseCacheRecovered:
    'A damaged cached database was removed. Download a clean copy to restore location lookup.',
  databaseDownload: 'Download database',
  databaseDownloading: 'Downloading city database',
  databaseLearnMore: 'About DB-IP City Lite',
  originError: 'The local public IP could not be detected. Retry to locate connections.',
  noConnections: 'No active connections',
  noLocatedConnections: 'No active connection endpoints could be located',
  endpointRole: 'Role',
  topDownloadedHosts: 'Top 5 hosts by download',
  rendererError: '3D rendering is unavailable in this browser.',
  getting: 'Getting...',
  testFailed: 'Test failed',
  retry: 'Retry',
  cancel: 'Cancel',
  unknown: 'Unknown',
  connectionCount: 'Connection count',
  proxyMissing:
    'The local multi-backend proxy was not detected, so the city database and public IP lookup are unavailable.',
  databaseError_space: 'There is not enough browser storage for the city database.',
  databaseError_network: 'The city database could not be downloaded.',
  databaseError_decompress: 'The city database could not be decompressed.',
  databaseError_invalid: 'The downloaded city database is invalid.',
  databaseError_storage: 'The city database could not be saved in browser storage.',
  databaseError_unsupported: 'This browser cannot decompress the city database.',
  databaseError_unknown: 'The city database could not be loaded.',
}

const TABLE: Record<string, Dict> = { zh: ZH, 'zh-tw': TW, en: EN }

export type Translator = (key: keyof typeof ZH | string, params?: Record<string, string>) => string

export const createTranslator = (language: string): Translator => {
  const normalized = (language || 'zh').toLowerCase()
  const dict =
    normalized.startsWith('zh-tw') || normalized.startsWith('zh-hk') || normalized.startsWith('zh-hant')
      ? TW
      : normalized.startsWith('zh')
        ? ZH
        : EN

  return (key, params) => {
    const template = dict[key] ?? EN[key] ?? key

    if (!params) return template

    return template.replace(/\{(\w+)\}/g, (_, name: string) => params[name] ?? '')
  }
}

/** 传给 geoip worker 的地区码，决定城市名的语言 */
export const workerLocale = (language: string) => {
  const normalized = (language || 'zh').toLowerCase()
  if (normalized.startsWith('zh-tw') || normalized.startsWith('zh-hk')) return 'zh-TW'
  if (normalized.startsWith('zh')) return 'zh-CN'
  return normalized
}
