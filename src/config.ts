import rawInstanceConfig from '../rally.config.json'
import type { InstanceConfig, PublicInstanceConfig } from './types'

export const instanceConfig = rawInstanceConfig as InstanceConfig

export const bundledPublicConfig: PublicInstanceConfig = {
  site: instanceConfig.site,
  accounts: instanceConfig.accounts,
  polls: instanceConfig.polls,
}

export const apiBaseUrl = (
  import.meta.env.VITE_API_BASE_URL
  || (import.meta.env.MODE === 'pages' ? instanceConfig.deployment.apiBaseUrl : '')
).replace(/\/$/, '')

export function applySiteConfig() {
  document.title = instanceConfig.site.title
  document.querySelector('meta[name="description"]')
    ?.setAttribute('content', instanceConfig.site.description)
  document.querySelector('meta[name="theme-color"]')
    ?.setAttribute('content', instanceConfig.site.themeColor)
}