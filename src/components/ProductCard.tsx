import React from 'react'
import type { Product } from '../data/products'

function titleCase(s: string) {
  return s.replace(/\w\S*/g, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase())
}

export default function ProductCard({
  item,
  score,
  label,
  onSelect,
}: {
  item: Product
  score?: number
  label?: string            // e.g. "Picture 1"
  onSelect?: () => void     // used to set document.title
}) {
  const pct = typeof score === 'number' ? Math.max(0, Math.min(100, score * 100)) : null

  // Nice fallback name if no label provided
  const derived =
    item.name && /\D+\s*\d+/.test(item.name)
      ? item.name.replace(
          /(\D+)\s*(\d+)/,
          (_, a: string, b: string) => `${titleCase(a.trim().replace(/s$/i, ''))} #${b}`
        )
      : `${titleCase(item.category.replace(/s$/i, ''))}${
          item.id != null ? ` #${Number(item.id)}` : ''
        }`

  const displayName = label || (item as any).title || item.name || derived

  return (
    <div
      className="glass p-3 rounded-2xl card-hover cursor-pointer"
      onClick={onSelect}
      role="button"
      title="Select to set tab title"
    >
      <a href={item.image} target="_blank" rel="noreferrer" title="Open source image">
        <img
          src={item.image}
          alt={displayName}
          className="w-full h-48 object-cover rounded-xl"
          crossOrigin="anonymous"
        />
      </a>

      <div className="mt-3 flex items-start justify-between gap-3">
        <div>
          <div className="font-semibold text-slate-50 tracking-[-0.01em]">{displayName}</div>
          <div className="text-xs text-slate-300">{titleCase(item.category)}</div>
        </div>
      </div>

      <div className="mt-2 text-[11px] text-slate-200/80 truncate" title={item.image}>
        {item.image.startsWith('/') ? `local: ${item.image}` : item.image}
      </div>

      {pct !== null && (
        <div className="mt-2">
          <div className="progress-track">
            <div className="progress-fill" style={{ width: `${pct.toFixed(0)}%` }} />
          </div>
          <div className="mt-1 text-[11px] text-slate-200/75">Similarity: {pct.toFixed(1)}%</div>
        </div>
      )}
    </div>
  )
}