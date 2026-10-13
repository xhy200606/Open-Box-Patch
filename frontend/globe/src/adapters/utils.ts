/**
 * [Open-Box Patch] 从 zashboard `src/helper/utils.ts` 取出的字节格式化函数。
 */
const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'] as const

export const prettyBytesHelper = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '0 B'

  const exponent = Math.min(BYTE_UNITS.length - 1, Math.floor(Math.log(value) / Math.log(1024)))
  const scaled = value / 1024 ** exponent
  const digits = scaled >= 100 || exponent === 0 ? 0 : 1

  return `${scaled.toFixed(digits)} ${BYTE_UNITS[exponent]}`
}
