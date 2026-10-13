/**
 * [Open-Box Patch] 运行期环境
 *
 * 补丁资产是从 `index.html` 里以相对路径注入的，因此脚本自身 URL 才是唯一可靠的
 * 资产定位依据；服务端代理地址则由注入脚本从页面同源推导后传入。
 */

let assetBase = './'
let proxyBase = ''
let panelBase = ''

const withSlash = (url: string) => (url.endsWith('/') ? url : url + '/')

export const setAssetBase = (url: string) => {
  assetBase = withSlash(url)
}

export const getAssetBase = () => assetBase

/** 地球贴图等静态资产的绝对地址 */
export const earthAssetURL = (name: string) => `${assetBase}globe-assets/earth/${name}`

export const setProxyBase = (url: string) => {
  proxyBase = url.replace(/\/+$/, '')
}

export const getProxyBase = () => proxyBase

/** 面板自身 origin（同源接口，如 /api/controller/*） */
export const setPanelBase = (url: string) => {
  panelBase = url.replace(/\/+$/, '')
}

export const getPanelBase = () => panelBase || window.location.origin
