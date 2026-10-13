import type { EarthProjection } from './earth/projection'
import type { EarthVisualMode } from './earth/renderer-types'
import type { IPInfoAPI } from './adapters/geoip'

export const GLOBE_PREFERENCES_KEY = 'openbox.globe.preferences.v1'
export interface GlobePreferences {
  projection: EarthProjection
  visualMode: EarthVisualMode
  showCityLabels: boolean
  rotationPaused: boolean
  showRelays: boolean
  api: IPInfoAPI
  showOriginIP: boolean
}
const defaults: GlobePreferences = { projection: '3d', visualMode: 'space', showCityLabels: true, rotationPaused: false, showRelays: true, api: 'ip.sb', showOriginIP: false }

export function loadGlobePreferences(storage?: Pick<Storage, 'getItem'>): GlobePreferences {
  try {
    const value = JSON.parse((storage || localStorage).getItem(GLOBE_PREFERENCES_KEY) || '{}')
    return { projection: value?.projection === '2d' ? '2d' : '3d', visualMode: value?.visualMode === 'flat' ? 'flat' : 'space',
      showCityLabels: typeof value?.showCityLabels === 'boolean' ? value.showCityLabels : defaults.showCityLabels,
      rotationPaused: typeof value?.rotationPaused === 'boolean' ? value.rotationPaused : defaults.rotationPaused,
      showRelays: typeof value?.showRelays === 'boolean' ? value.showRelays : defaults.showRelays,
      api: ['ip.sb', 'ipwho.is', 'ipapi.is', 'ipip.net'].includes(value?.api) ? value.api : defaults.api,
      showOriginIP: typeof value?.showOriginIP === 'boolean' ? value.showOriginIP : defaults.showOriginIP }
  } catch { return { ...defaults } }
}
export function saveGlobePreferences(value: GlobePreferences, storage?: Pick<Storage, 'setItem'>) {
  try { (storage || localStorage).setItem(GLOBE_PREFERENCES_KEY, JSON.stringify(value)) } catch { /* private browsing / storage full */ }
}
