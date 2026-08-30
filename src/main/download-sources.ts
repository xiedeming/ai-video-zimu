import type { ModelManifestItem } from '../shared/types'

function endpointUrl(base: string, sourceUrl: URL): string {
  return `${base.replace(/\/$/, '')}${sourceUrl.pathname}${sourceUrl.search}`
}

export function getModelDownloadSources(item: ModelManifestItem, customEndpoint = process.env.ZIMU_MODEL_ENDPOINT): string[] {
  const official = new URL(item.url)
  const sources: string[] = []
  if (customEndpoint) sources.push(endpointUrl(customEndpoint, official))

  sources.push(endpointUrl('https://hf-mirror.com', official), item.url)
  return [...new Set(sources)]
}

export function downloadSourceLabel(url: string): string {
  try {
    const host = new URL(url).hostname
    if (host === 'hf-mirror.com') return 'Hugging Face 国内镜像'
    if (host === 'huggingface.co') return 'Hugging Face 官方源'
    return host
  } catch {
    return '自定义下载源'
  }
}
