// src/components/ProductCard.tsx
import React from 'react'
import { Product } from '../data/products'

type Props = {
  item: Product
  score?: number
  label?: string
  onSelect?: () => void
}

function pctColor(score?: number) {
  if (score == null) return 'bg-white/25'
  if (score >= 0.8) return 'bg-emerald-500'
  if (score >= 0.6) return 'bg-lime-500'
  if (score >= 0.4) return 'bg-amber-500'
  if (score >= 0.25) return 'bg-orange-500'
  return 'bg-rose-500'
}

export default function ProductCard({ item, score, label, onSelect }: Props) {
  const anyItem = item as unknown as Record<string, any>
  const name: string =
    anyItem.title || anyItem.name || anyItem.label || `Item ${item.id}`
  const category: string | undefined = anyItem.category
  const price: number | string | undefined = anyItem.price
  const image: string = anyItem.image
  const [loaded, setLoaded] = React.useState(false)
  const [failed, setFailed] = React.useState(false)

  const displayScore =
    typeof score === 'number' ? Math.round(score * 100) : undefined

  function handleActivate() {
    onSelect?.()
  }

  return (
    <article className="group rounded-2xl overflow-hidden bg-white/5 ring-1 ring-white/10 focus-within:ring-white/25">
      <button
        type="button"
        onClick={handleActivate}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            handleActivate()
          }
        }}
        className="w-full text-left"
        aria-label={label ? `${label}: ${name}` : name}
        title={name}
      >
        {/* Image area */}
        <div className="relative">
          <div className="aspect-square w-full bg-black/20 overflow-hidden">
            {!failed ? (
              <>
                {!loaded && (
                  <div className="w-full h-full animate-pulse bg-white/10" />
                )}
                <img
                  src={image}
                  alt={name}
                  className={`w-full h-full object-cover transition-opacity duration-300 ${
                    loaded ? 'opacity-100' : 'opacity-0'
                  }`}
                  loading="lazy"
                  decoding="async"
                  crossOrigin="anonymous"
                  referrerPolicy="no-referrer"
                  onLoad={() => setLoaded(true)}
                  onError={() => {
                    setFailed(true)
                    setLoaded(true)
                  }}
                />
              </>
            ) : (
              <div className="w-full h-full grid place-items-center text-white/60 text-xs">
                No image
              </div>
            )}
          </div>

          {/* Score pill */}
          {displayScore !== undefined && (
            <div className="absolute top-2 right-2">
              <span
                className={`px-2.5 py-1 rounded-full text-xs font-semibold text-white shadow ${pctColor(
                  score
                )}`}
              >
                {displayScore}%
              </span>
            </div>
          )}

          {/* Category chip */}
          {category && (
            <div className="absolute top-2 left-2">
              <span className="px-2 py-1 rounded-full text-[11px] font-medium bg-black/40 text-white backdrop-blur-sm ring-1 ring-white/10">
                {category}
              </span>
            </div>
          )}
        </div>

        {/* Meta */}
        <div className="p-3">
          <h3
            className="text-sm leading-snug text-white/95"
            style={{
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
          >
            {name}
          </h3>

          <div className="mt-1 flex items-center justify-between gap-2">
            {price != null ? (
              <div className="text-sm font-medium text-white/90">
                {typeof price === 'number' ? `$${price.toFixed(2)}` : price}
              </div>
            ) : (
              <div className="text-xs text-white/60">#{item.id}</div>
            )}

            <span className="opacity-0 group-hover:opacity-100 transition-opacity text-xs text-white/80">
              View
            </span>
          </div>
        </div>
      </button>
    </article>
  )
}