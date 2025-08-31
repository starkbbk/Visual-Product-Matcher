import React from 'react'
import { Product } from '../data/products'

type Props = {
  item: Product
  score: number
  label?: string
  onSelect?: () => void
}

const PROXY = 'https://images.weserv.nl/?url='

// allow-list of friendly hosts we can load directly
const SAFE_HOSTS = new Set([
  'upload.wikimedia.org',
  'picsum.photos',
  'images.unsplash.com',
  'i.imgur.com',
  'loremflickr.com',
  'images.pexels.com',
  'cdn.pixabay.com',
])

function toProxy(u: string) {
  const hostless = u.replace(/^https?:\/\//, '')
  return `${PROXY}${encodeURIComponent(hostless)}`
}

function normalizeSrc(u: string) {
  try {
    const url = new URL(u)
    // Enforce https to avoid mixed-content blocks
    if (url.protocol === 'http:') url.protocol = 'https:'
    // If host not on the safe list, go through proxy
    if (!SAFE_HOSTS.has(url.host)) return toProxy(url.href)
    return url.href
  } catch {
    // If it isn't a valid URL, try proxying whatever string we have
    return toProxy(u)
  }
}

export default function ProductCard({ item, score, label, onSelect }: Props) {
  const [src, setSrc] = React.useState<string>(() => normalizeSrc(item.image))
  const [triedProxy, setTriedProxy] = React.useState(false)

  return (
    <article
      className="rounded-2xl bg-white/5 ring-1 ring-white/10 overflow-hidden hover:bg-white/10 transition-colors"
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onSelect?.()}
      aria-label={label ?? item.title}
    >
      <div className="relative aspect-[4/3] bg-black/20">
        <img
          src={src}
          alt={item.title}
          className="absolute inset-0 w-full h-full object-cover"
          loading="lazy"
          decoding="async"
          onError={() => {
            // if direct src failed, force proxy once
            if (!triedProxy) {
              setTriedProxy(true)
              setSrc(toProxy(item.image))
            }
          }}
        />
        {/* score badge */}
        <div className="absolute top-2 left-2 px-2 py-1 rounded-lg bg-black/55 text-[11px] tabular-nums">
          {(score * 100).toFixed(1)}%
        </div>
      </div>

      <div className="p-3">
        <div className="text-sm font-medium leading-tight line-clamp-2">{item.title}</div>
        <div className="text-xs text-white/70 mt-0.5">{item.category}</div>

        <div className="mt-2 h-1.5 w-full rounded-full bg-white/10 overflow-hidden" aria-hidden="true">
          <div
            className="h-full bg-white/80"
            style={{ width: `${Math.max(0, Math.min(100, score * 100))}%` }}
          />
        </div>
      </div>
    </article>
  )
}