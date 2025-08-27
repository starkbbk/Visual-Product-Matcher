// src/App.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import Uploader from './components/Uploader'
import ProductCard from './components/ProductCard'
import { PRODUCTS, Product } from './data/products'
import { classifyImage, detectAndCrop, imageToEmbedding } from './lib/mobilenet'
import { clipImageEmbedding } from './lib/clip'
import { cosineSimilarity } from './lib/similarity'

type Scored = Product & { score: number }

function proxied(url: string) {
  try {
    const u = new URL(url)
    if (u.origin === window.location.origin) return url
    const hostless = url.replace(/^https?:\/\//, '')
    return `https://images.weserv.nl/?url=${encodeURIComponent(hostless)}`
  } catch {
    return url
  }
}

async function robustEmbed(img: HTMLImageElement) {
  // Prefer CLIP; fallback to MobileNet if CLIP fails (offline, etc.)
  try {
    return await clipImageEmbedding(img)
  } catch (e) {
    console.warn('CLIP failed, falling back to MobileNet embeddings:', e)
    return await imageToEmbedding(img)
  }
}

export default function App() {
  const [queryUrl, setQueryUrl] = useState<string | null>(null)
  const [queryImgLoaded, setQueryImgLoaded] = useState(false)
  const [queryEmbed, setQueryEmbed] = useState<Float32Array | null>(null)

  const [embeds, setEmbeds] = useState<(Float32Array | null)[]>(
    Array(PRODUCTS.length).fill(null)
  )
  const [labels, setLabels] = useState<string[][]>(Array(PRODUCTS.length).fill([]))
  const [queryLabels, setQueryLabels] = useState<string[]>([])

  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('Load or paste an image to start')
  const [minScore, setMinScore] = useState(0.25)
  const [topK, setTopK] = useState(12)
  const [category, setCategory] = useState<string>('All')
  const [preferQueryClass, setPreferQueryClass] = useState(true)
  const [onlySameClass, setOnlySameClass] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const imgRef = useRef<HTMLImageElement>(null)

  const hasEmbeds = embeds.some((e) => !!e)

  async function computeCatalogEmbeddings() {
    setStatus('Computing product embeddings...')
    setProgress(0)
    const out: (Float32Array | null)[] = [...embeds]
    const outLabels: string[][] = [...labels]
    let done = 0
    for (let i = 0; i < PRODUCTS.length; i++) {
      if (!out[i]) {
        const url = PRODUCTS[i].image
        try {
          const img = await loadImage(url)
          const region = await detectAndCrop(img, ['backpack', 'handbag', 'suitcase'])
          const emb = await robustEmbed(region)
          out[i] = emb
          const preds = await classifyImage(region, 3)
          outLabels[i] = preds.map((p) => p.className.toLowerCase())
        } catch (e) {
          console.warn('Embed failed for', url, e)
          out[i] = null
          outLabels[i] = []
        }
      }
      done++
      setProgress(done / PRODUCTS.length)
    }
    setEmbeds(out)
    setLabels(outLabels)
    setStatus('Embeddings ready')
  }

  function onFile(f: File) {
    setError(null)
    const url = URL.createObjectURL(f)
    setQueryUrl(url)
    setQueryImgLoaded(false)
  }

  function onUrl(url: string) {
    setError(null)
    const clean = url.trim()
    setQueryUrl(proxied(clean))
    setQueryImgLoaded(false)
  }

  // Query image → crop → embed → classify
  useEffect(() => {
    async function run() {
      if (!queryImgLoaded || !imgRef.current) return
      setStatus('Detecting object & embedding query...')
      try {
        const region = await detectAndCrop(imgRef.current, ['backpack', 'handbag', 'suitcase'])
        const emb = await robustEmbed(region)
        setQueryEmbed(emb)
        const qpred = await classifyImage(region, 3)
        setQueryLabels(qpred.map((p) => p.className.toLowerCase()))
        setStatus('Query embedded')
      } catch (e) {
        console.error(e)
        setError(
          'Failed to process the image. Use a direct .jpg/.png URL (or upload a file).'
        )
      }
    }
    run()
  }, [queryImgLoaded])

  // Auto-compute catalog embeddings after the query is ready (first time)
  useEffect(() => {
    if (queryEmbed && !hasEmbeds) {
      computeCatalogEmbeddings()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryEmbed])

  const scored: Scored[] = useMemo(() => {
    if (!queryEmbed) return []
    const rows: Scored[] = []
    for (let i = 0; i < PRODUCTS.length; i++) {
      const emb = embeds[i]
      if (!emb) continue
      const sameClass = labels[i]?.some((l) => queryLabels.includes(l))
      if (onlySameClass && !sameClass) continue
      const base = cosineSimilarity(queryEmbed, emb)
      const boost = preferQueryClass && sameClass ? 0.15 : 0
      const s = Math.max(0, Math.min(1, base + boost))
      rows.push({ ...PRODUCTS[i], score: s })
    }
    let r = rows
    if (category !== 'All') r = r.filter((d) => d.category === category)
    r.sort((a, b) => b.score - a.score)
    r = r.filter((d) => d.score >= minScore).slice(0, topK)
    return r
  }, [queryEmbed, embeds, labels, queryLabels, minScore, topK, category, preferQueryClass, onlySameClass])

  function relaxFilters() {
    setMinScore(0.25)
    setTopK(16)
    setCategory('All')
    setPreferQueryClass(true)
    setOnlySameClass(false)
  }

  return (
    <div className="max-w-6xl mx-auto p-4 md:p-6 flex flex-col gap-6">
      <header className="flex flex-col md:flex-row gap-3 items-start md:items-center justify-between">
        <h1 className="text-2xl md:text-3xl font-bold">Visual Product Matcher</h1>
        <div className="text-sm opacity-70">Client-side ML (CLIP + MobileNet + COCO-SSD)</div>
      </header>

      <Uploader onFile={onFile} onUrl={onUrl} />

      {queryUrl && (
        <div className="grid md:grid-cols-2 gap-4">
          <div className="card p-4">
            <div className="text-sm mb-2 opacity-80">Your image</div>
            <img
              ref={imgRef}
              src={queryUrl}
              alt="query"
              onLoad={() => setQueryImgLoaded(true)}
              onError={() =>
                setError('Could not load image. Use a direct .jpg/.png URL or upload a file.')
              }
              crossOrigin="anonymous"
              className="w-full max-h-96 object-contain rounded-xl bg-slate-900"
            />
            {queryLabels.length > 0 && (
              <div className="text-xs opacity-70 mt-2">Predicted: {queryLabels.join(', ')}</div>
            )}
          </div>

          <div className="card p-4 flex flex-col gap-3">
            <div className="text-sm opacity-80">Status</div>
            <div className="text-lg">{status}</div>
            <div className="w-full h-2 bg-slate-800 rounded">
              <div
                className="h-2 bg-slate-100 rounded"
                style={{ width: `${Math.round(progress * 100)}%` }}
              />
            </div>
            <div className="text-xs opacity-70">Progress: {Math.round(progress * 100)}%</div>
            <div className="flex gap-2">
              <button
                onClick={computeCatalogEmbeddings}
                className="px-3 py-2 rounded-xl bg-slate-100 text-slate-900 text-sm font-semibold hover:opacity-80"
              >
                Compute Catalog Embeddings
              </button>
            </div>
            {error && <div className="text-sm text-red-300">{error}</div>}
          </div>
        </div>
      )}

      <div className="card p-4 flex flex-wrap gap-4 items-center">
        <div className="flex items-center gap-2">
          <label className="text-sm opacity-80">Min similarity</label>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={minScore}
            onChange={(e) => setMinScore(parseFloat(e.target.value))}
          />
          <div className="text-sm tabular-nums">{(minScore * 100).toFixed(0)}%</div>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm opacity-80">Top K</label>
          <input
            type="range"
            min={4}
            max={24}
            step={1}
            value={topK}
            onChange={(e) => setTopK(parseInt(e.target.value))}
          />
          <div className="text-sm tabular-nums">{topK}</div>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm opacity-80">Category</label>
          <select
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="rounded-lg bg-slate-900 border border-slate-800 px-3 py-1.5 text-sm"
          >
            <option>All</option>
            {[...new Set(PRODUCTS.map((p) => p.category))].map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
        </div>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={preferQueryClass}
            onChange={(e) => setPreferQueryClass(e.target.checked)}
          />
          <span className="text-sm opacity-80">Prefer same class as query</span>
        </label>

        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            checked={onlySameClass}
            onChange={(e) => setOnlySameClass(e.target.checked)}
          />
          <span className="text-sm opacity-80">Only show same class</span>
        </label>

        <button
          onClick={relaxFilters}
          className="px-3 py-1.5 rounded-xl bg-slate-100 text-slate-900 text-sm font-semibold hover:opacity-80"
        >
          Show more results
        </button>
      </div>

      <section>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {scored.map((item) => (
            <ProductCard key={item.id} item={item} score={item.score} />
          ))}
        </div>

        {!queryEmbed && (
          <div className="text-center opacity-70 mt-6 text-sm">
            Upload an image or paste a URL to see similar items.
          </div>
        )}

        {queryEmbed && !hasEmbeds && (
          <div className="text-center opacity-70 mt-6 text-sm">
            Catalog embeddings not ready. Click <b>Compute Catalog Embeddings</b> or wait for the
            auto-run to finish.
          </div>
        )}

        {queryEmbed && hasEmbeds && scored.length === 0 && (
          <div className="text-center opacity-70 mt-6 text-sm">
            No matches ≥ {(minScore * 100).toFixed(0)}%. Lower <b>Min similarity</b>, increase
            <b> Top K</b>, or disable the class options.
            <button
              onClick={relaxFilters}
              className="ml-2 px-2.5 py-1 rounded-lg bg-slate-100 text-slate-900 text-xs font-semibold"
            >
              Relax filters
            </button>
          </div>
        )}
      </section>

      <footer className="text-xs opacity-60 py-6">
        Built with React, Vite, Tailwind. Similarity: CLIP (transformers.js) with MobileNet fallback
        + object detection (COCO-SSD). Labels via MobileNet.
      </footer>
    </div>
  )
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = (e) => reject(e)
    img.src = proxied(url)
  })
}