// src/pages/Home.tsx
import React, { useEffect, useMemo, useRef, useState } from 'react'
import Uploader from '../components/Uploader'
import ProductCard from '../components/ProductCard'
import { PRODUCTS, Product } from '../data/products'
import { classifyImage, detectAndCrop, imageToEmbedding } from '../lib/mobilenet'
import { clipImageEmbedding } from '../lib/clip'
import { cosineSimilarity } from '../lib/similarity'

type Scored = Product & { score: number }
const DEFAULT_TITLE = 'Visual Product Matcher'

const PROXY = 'https://images.weserv.nl/?url='
const SAFE_HOSTS = new Set(['upload.wikimedia.org', 'picsum.photos', 'images.unsplash.com', 'i.imgur.com'])

function shouldProxy(u: string) {
  try {
    const url = new URL(u)
    if (url.origin === window.location.origin) return false
    if (SAFE_HOSTS.has(url.host)) return false
    return true
  } catch { return false }
}
function proxyUrl(u: string) {
  const hostless = u.replace(/^https?:\/\//, '')
  return `${PROXY}${encodeURIComponent(hostless)}`
}
async function robustEmbed(img: HTMLImageElement) {
  try { return await clipImageEmbedding(img) } catch { return await imageToEmbedding(img) }
}
function loadImageFromSrc(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('img load failed'))
    img.src = src
  })
}
async function loadCatalogImage(url: string) {
  try { return await loadImageFromSrc(url) }
  catch {
    if (shouldProxy(url)) return await loadImageFromSrc(proxyUrl(url))
    throw new Error('catalog image load failed: ' + url)
  }
}
async function fetchToObjectURL(rawUrl: string): Promise<string> {
  const tryFetch = async (url: string) => {
    const res = await fetch(url, { mode: 'cors', referrerPolicy: 'no-referrer' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  }
  try { return await tryFetch(rawUrl) }
  catch (e) {
    if (shouldProxy(rawUrl)) return await tryFetch(proxyUrl(rawUrl))
    throw e
  }
}

export default function Home() {
  const [displayQueryUrl, setDisplayQueryUrl] = useState<string | null>(null)
  const [queryImgLoaded, setQueryImgLoaded] = useState(false)
  const [queryEmbed, setQueryEmbed] = useState<Float32Array | null>(null)
  const [queryLabels, setQueryLabels] = useState<string[]>([])

  const [embeds, setEmbeds] = useState<(Float32Array | null)[]>(Array(PRODUCTS.length).fill(null))
  const [labels, setLabels] = useState<string[][]>(Array(PRODUCTS.length).fill([]))
  const hasEmbeds = embeds.some(Boolean)

  const [progress, setProgress] = useState(0)
  const [status, setStatus] = useState('Load or paste an image to start')
  const [error, setError] = useState<string | null>(null)
  const [minScore, setMinScore] = useState(0.25)
  const [topK, setTopK] = useState(12)
  const [category, setCategory] = useState<string>('All')
  const [preferQueryClass, setPreferQueryClass] = useState(true)
  const [onlySameClass, setOnlySameClass] = useState(false)

  const imgRef = useRef<HTMLImageElement>(null)
  const lastBlobURL = useRef<string | null>(null)

  useEffect(() => { document.title = DEFAULT_TITLE }, [])

  async function computeCatalogEmbeddings() {
    setStatus('Computing product embeddings...')
    setProgress(0)
    const out = [...embeds]
    const outLabels = [...labels]
    let done = 0
    for (let i = 0; i < PRODUCTS.length; i++) {
      if (!out[i]) {
        const url = PRODUCTS[i].image
        try {
          const img = await loadCatalogImage(url)
          const region = await detectAndCrop(img, ['backpack', 'handbag', 'suitcase'])
          out[i] = await robustEmbed(region)
          const preds = await classifyImage(region, 3)
          outLabels[i] = preds.map((p) => p.className.toLowerCase())
        } catch {
          out[i] = null
          outLabels[i] = []
        }
      }
      done++; setProgress(done / PRODUCTS.length)
    }
    setEmbeds(out); setLabels(outLabels); setStatus('Embeddings ready')
  }

  function onFile(f: File) {
    setError(null)
    if (lastBlobURL.current) { URL.revokeObjectURL(lastBlobURL.current); lastBlobURL.current = null }
    const blobUrl = URL.createObjectURL(f)
    lastBlobURL.current = blobUrl
    setDisplayQueryUrl(blobUrl); setQueryImgLoaded(false)
    document.title = DEFAULT_TITLE
  }
  async function onUrl(url: string) {
    setError(null)
    if (lastBlobURL.current) { URL.revokeObjectURL(lastBlobURL.current); lastBlobURL.current = null }
    try {
      const blobUrl = await fetchToObjectURL(url.trim())
      lastBlobURL.current = blobUrl
      setDisplayQueryUrl(blobUrl); setQueryImgLoaded(false)
      document.title = DEFAULT_TITLE
    } catch {
      setDisplayQueryUrl(null); setQueryImgLoaded(false)
      setError('Could not load image. Use a direct .jpg/.png URL or upload a file.')
    }
  }

  useEffect(() => {
    async function run() {
      if (!queryImgLoaded || !imgRef.current) return
      setStatus('Detecting object & embedding query…')
      try {
        const region = await detectAndCrop(imgRef.current, ['backpack', 'handbag', 'suitcase'])
        const emb = await robustEmbed(region)
        setQueryEmbed(emb)
        const qpred = await classifyImage(region, 3)
        setQueryLabels(qpred.map((p) => p.className.toLowerCase()))
        setStatus('Query embedded')
      } catch {
        setError('Failed to process the image. Try another URL or upload a file.')
      }
    }
    run()
  }, [queryImgLoaded])

  useEffect(() => { if (queryEmbed && !hasEmbeds) void computeCatalogEmbeddings() }, [queryEmbed]) // eslint-disable-line

  useEffect(() => () => { if (lastBlobURL.current) URL.revokeObjectURL(lastBlobURL.current) }, [])

  const scored = useMemo(() => {
    if (!queryEmbed) return [] as (Scored & { _idx: number })[]
    const rows: (Scored & { _idx: number })[] = []
    for (let i = 0; i < PRODUCTS.length; i++) {
      const emb = embeds[i]; if (!emb) continue
      const sameClass = labels[i]?.some((l) => queryLabels.includes(l))
      if (onlySameClass && !sameClass) continue
      const base = cosineSimilarity(queryEmbed, emb)
      const boost = preferQueryClass && sameClass ? 0.15 : 0
      rows.push({ ...PRODUCTS[i], score: Math.max(0, Math.min(1, base + boost)), _idx: i })
    }
    let r = rows
    if (category !== 'All') r = r.filter((d) => d.category === category)
    r.sort((a, b) => b.score - a.score)
    r = r.filter((d) => d.score >= minScore).slice(0, topK)
    return r.map((d, visibleIndex) => ({ ...d, _idx: visibleIndex }))
  }, [queryEmbed, embeds, labels, queryLabels, minScore, topK, category, preferQueryClass, onlySameClass])

  function relaxFilters() {
    setMinScore(0.25); setTopK(16); setCategory('All'); setPreferQueryClass(true); setOnlySameClass(false)
  }

  return (
    <>
      <div className="glass-strong px-4 py-3 rounded-2xl flex items-center justify-between">
        <h1 className="text-xl md:text-2xl font-bold tracking-tight">Visual Product Matcher</h1>
        <div className="text-xs md:text-sm text-white/80">Client-side ML · CLIP + MobileNet + COCO-SSD</div>
      </div>

      <Uploader onFile={onFile} onUrl={onUrl} />

      {displayQueryUrl && (
        <div className="grid md:grid-cols-2 gap-4">
          <div className="glass p-4">
            <div className="text-sm mb-2 text-white/80">Your image</div>
            <img
              ref={imgRef}
              src={displayQueryUrl}
              alt="query"
              crossOrigin="anonymous"
              referrerPolicy="no-referrer"
              onLoad={() => setQueryImgLoaded(true)}
              onError={() => setError('Preview failed. Try uploading the file instead.')}
              className="w-full max-h-96 object-contain rounded-2xl bg-black/30"
            />
            {queryLabels.length > 0 && (
              <div className="text-xs text-white/75 mt-2">Predicted: {queryLabels.join(', ')}</div>
            )}
          </div>

          <div className="glass p-4 flex flex-col gap-3">
            <div className="text-sm text-white/80">Status</div>
            <div className="text-lg">{status}</div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
            </div>
            <div className="text-xs text-white/70">Progress: {Math.round(progress * 100)}%</div>
            <div className="flex gap-2">
              <button className="btn-glass" onClick={computeCatalogEmbeddings}>
                Compute Catalog Embeddings
              </button>
            </div>
            {error && <div className="text-sm text-rose-200">{error}</div>}
          </div>
        </div>
      )}

      <div className="glass p-4 flex flex-wrap gap-4 items-center">
        <div className="flex items-center gap-2">
          <label className="text-sm text-white/80">Min similarity</label>
          <input type="range" min={0} max={1} step={0.01} value={minScore} onChange={(e) => setMinScore(parseFloat(e.target.value))} />
          <div className="text-sm tabular-nums">{(minScore * 100).toFixed(0)}%</div>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm text-white/80">Top K</label>
          <input type="range" min={4} max={24} step={1} value={topK} onChange={(e) => setTopK(parseInt(e.target.value))} />
          <div className="text-sm tabular-nums">{topK}</div>
        </div>

        <div className="flex items-center gap-2">
          <label className="text-sm text-white/80">Category</label>
          <select value={category} onChange={(e) => setCategory(e.target.value)} className="glass px-3 py-1.5 rounded-xl text-slate-100">
            <option>All</option>
            {[...new Set(PRODUCTS.map((p) => p.category))].map((c) => (<option key={c}>{c}</option>))}
          </select>
        </div>

        <label className="flex items-center gap-2">
          <input type="checkbox" className="switch" checked={preferQueryClass} onChange={(e) => setPreferQueryClass(e.target.checked)} />
          <span className="text-sm text-white/80">Prefer same class as query</span>
        </label>

        <label className="flex items-center gap-2">
          <input type="checkbox" className="switch" checked={onlySameClass} onChange={(e) => setOnlySameClass(e.target.checked)} />
          <span className="text-sm text-white/80">Only show same class</span>
        </label>

        <button onClick={relaxFilters} className="btn-glass">Show more results</button>
      </div>

      <section>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-4">
          {scored.map((item, visibleIndex) => (
            <ProductCard
              key={item.id}
              item={item}
              score={item.score}
              label={`Picture ${visibleIndex + 1}`}
              onSelect={() => { document.title = `Picture ${visibleIndex + 1}` }}
            />
          ))}
        </div>

        {!queryEmbed && (
          <div className="text-center text-white/70 mt-6 text-sm">
            Upload an image or paste a URL to see similar items.
          </div>
        )}
      </section>
    </>
  )
}