import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  NavLink,
  Link,
  useLocation,
} from 'react-router-dom'

import Uploader from './components/Uploader'
import ProductCard from './components/ProductCard'
import Snowfall from './components/Snowfall'
import { PRODUCTS, Product } from './data/products'
import { classifyImage, detectAndCrop, imageToEmbedding } from './lib/mobilenet'
import { clipImageEmbedding } from './lib/clip'
import { cosineSimilarity } from './lib/similarity'

type Scored = Product & { score: number }
const DEFAULT_TITLE = 'Visual Product Matcher'

// ------------------------------
// Performance switches / caching
// ------------------------------
const CACHE_VERSION = 'v2'
const KEY_VECTORS = `vpm:vectors:${CACHE_VERSION}`
const KEY_LABELS  = `vpm:labels:${CACHE_VERSION}`

// Safe concurrency for embedding work (not used if precomputed is present)
const EMBED_CONCURRENCY = 3

// CORS proxy for remote images if direct CORS fails
const PROXY = 'https://images.weserv.nl/?url='
const SAFE_HOSTS = new Set([
  'upload.wikimedia.org',
  'picsum.photos',
  'images.unsplash.com',
  'i.imgur.com',
  'loremflickr.com',
  'images.pexels.com',
  'images.livemint.com',
])

function shouldProxy(u: string) {
  try {
    const url = new URL(u)
    if (url.origin === window.location.origin) return false
    if (SAFE_HOSTS.has(url.host)) return false
    return true
  } catch {
    return false
  }
}
function proxyUrl(u: string) {
  const hostless = u.replace(/^https?:\/\//, '')
  return `${PROXY}${encodeURIComponent(hostless)}`
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
/** Fetch to blob → objectURL. If CORS fails and it’s not a safe host, retry via proxy. */
async function fetchToObjectURL(rawUrl: string): Promise<string> {
  const tryFetch = async (url: string) => {
    const res = await fetch(url, { mode: 'cors', referrerPolicy: 'no-referrer' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    return URL.createObjectURL(blob)
  }
  try {
    return await tryFetch(rawUrl)
  } catch (e) {
    if (shouldProxy(rawUrl)) return await tryFetch(proxyUrl(rawUrl))
    throw e
  }
}
/** Always prefer object URLs for catalog images to avoid canvas taint */
async function loadCatalogImage(url: string): Promise<HTMLImageElement> {
  const objUrl = await fetchToObjectURL(url)
  try {
    return await loadImageFromSrc(objUrl)
  } finally {
    // keep the objectURL alive while the <img> is in use; revoke later if you store it
  }
}
/** Yield control so Chrome can paint progress updates */
function tick() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()))
}

/** Prefer CLIP, fallback to MobileNet embedding */
async function robustEmbed(img: HTMLImageElement) {
  try {
    return await clipImageEmbedding(img)
  } catch {
    return await imageToEmbedding(img)
  }
}

// ------------------------------
// LocalStorage encode/decode
// ------------------------------
function encodeVec(f: Float32Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(f.buffer)))
}
function decodeVec(s: string): Float32Array {
  const bin = atob(s)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Float32Array(arr.buffer)
}
function saveCatalogCache(embeds: (Float32Array | null)[], labels: string[][]) {
  const ve: Record<string, string> = {}
  const la: Record<string, string[]> = {}
  for (let i = 0; i < PRODUCTS.length; i++) {
    const id = PRODUCTS[i].id
    if (embeds[i]) ve[id] = encodeVec(embeds[i]!)
    if (labels[i]?.length) la[id] = labels[i]
  }
  localStorage.setItem(KEY_VECTORS, JSON.stringify(ve))
  localStorage.setItem(KEY_LABELS, JSON.stringify(la))
}
function loadCatalogCache(): { embeds: (Float32Array | null)[]; labels: string[][] } | null {
  try {
    const ve = JSON.parse(localStorage.getItem(KEY_VECTORS) || '{}')
    const la = JSON.parse(localStorage.getItem(KEY_LABELS) || '{}')
    const E: (Float32Array | null)[] = Array(PRODUCTS.length).fill(null)
    const L: string[][] = Array(PRODUCTS.length).fill([])
    let count = 0
    for (let i = 0; i < PRODUCTS.length; i++) {
      const id = PRODUCTS[i].id
      if (ve[id]) {
        E[i] = decodeVec(ve[id])
        count++
      }
      if (la[id]) L[i] = la[id]
    }
    if (count > 0) return { embeds: E, labels: L }
    return null
  } catch {
    return null
  }
}

/** Load precomputed vectors/labels from /public if present */
async function loadPrecomputedFiles(): Promise<{ embeds: (Float32Array | null)[]; labels: string[][] } | null> {
  try {
    const [eRes, lRes] = await Promise.all([
      fetch('/embeds.v1.json'),
      fetch('/labels.v1.json'),
    ])
    if (!eRes.ok || !lRes.ok) return null
    const eJson = await eRes.json()
    const lJson = await lRes.json()
    const E: (Float32Array | null)[] = Array(PRODUCTS.length).fill(null)
    const L: string[][] = Array(PRODUCTS.length).fill([])
    for (let i = 0; i < PRODUCTS.length; i++) {
      const id = PRODUCTS[i].id
      const ev = Array.isArray(eJson) ? eJson[i] : eJson[id]
      const lv = Array.isArray(lJson) ? lJson[i] : lJson[id]
      if (ev) E[i] = new Float32Array(ev)
      if (lv) L[i] = lv
    }
    return { embeds: E, labels: L }
  } catch {
    return null
  }
}

/* --------------------
 * HOME (matcher)
 * -------------------- */
function Home() {
  // Query state
  const [displayQueryUrl, setDisplayQueryUrl] = useState<string | null>(null)
  const [queryImgLoaded, setQueryImgLoaded] = useState(false)
  const [queryEmbed, setQueryEmbed] = useState<Float32Array | null>(null)
  const [queryLabels, setQueryLabels] = useState<string[]>([])

  // Catalog state
  const [embeds, setEmbeds] = useState<(Float32Array | null)[]>(Array(PRODUCTS.length).fill(null))
  const [labels, setLabels] = useState<string[][]>(Array(PRODUCTS.length).fill([]))
  const [statusCatalog, setStatusCatalog] = useState<'idle' | 'processing' | 'ready'>('idle')

  // UI state
  const [progress, setProgress] = useState(0)
  const [statusQuery, setStatusQuery] = useState<'idle' | 'processing' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [minScore, setMinScore] = useState(0.25)
  const [topK, setTopK] = useState(12)
  const [category, setCategory] = useState<string>('All')
  const [preferQueryClass, setPreferQueryClass] = useState(true)
  const [onlySameClass, setOnlySameClass] = useState(false)

  const imgRef = useRef<HTMLImageElement>(null)
  const lastBlobURL = useRef<string | null>(null)
  const resultsRef = useRef<HTMLDivElement | null>(null)
  const [autoScrolled, setAutoScrolled] = useState(false)
  const statusRef = useRef<HTMLDivElement | null>(null)
  const [scrolledStatus, setScrolledStatus] = useState(false)

  useEffect(() => { document.title = DEFAULT_TITLE }, [])

  // Prime from local cache OR /public precomputed; this prevents recompute on upload
  useEffect(() => {
    const cached = loadCatalogCache()
    if (cached) {
      setEmbeds(cached.embeds)
      setLabels(cached.labels)
      setStatusCatalog('ready')
      setProgress(1)
      return
    }
    ;(async () => {
      const pre = await loadPrecomputedFiles()
      if (pre) {
        setEmbeds(pre.embeds)
        setLabels(pre.labels)
        setStatusCatalog('ready')
        setProgress(1)
      }
    })()
  }, [])

  function onFile(f: File) {
    setError(null)
    if (lastBlobURL.current) {
      URL.revokeObjectURL(lastBlobURL.current)
      lastBlobURL.current = null
    }
    const blobUrl = URL.createObjectURL(f)
    lastBlobURL.current = blobUrl
    setDisplayQueryUrl(blobUrl)
    setQueryImgLoaded(false)
    setStatusQuery('processing')
    setAutoScrolled(false)
    setScrolledStatus(false)
    document.title = DEFAULT_TITLE
  }

  async function onUrl(url: string) {
    setError(null)
    if (lastBlobURL.current) {
      URL.revokeObjectURL(lastBlobURL.current)
      lastBlobURL.current = null
    }
    try {
      const blobUrl = await fetchToObjectURL(url.trim())
      lastBlobURL.current = blobUrl
      setDisplayQueryUrl(blobUrl)
      setQueryImgLoaded(false)
      setStatusQuery('processing')
      setAutoScrolled(false)
      setScrolledStatus(false)
      document.title = DEFAULT_TITLE
    } catch {
      setDisplayQueryUrl(null)
      setQueryImgLoaded(false)
      setStatusQuery('error')
      setAutoScrolled(false)
      setScrolledStatus(false)
      setError('Could not load image. Use a direct .jpg/.png URL or upload a file.')
    }
  }

  // When the preview <img> is ready, embed the query
  useEffect(() => {
    async function run() {
      if (!queryImgLoaded || !imgRef.current) return
      setStatusQuery('processing')
      try {
        const region = await detectAndCrop(imgRef.current, ['backpack', 'handbag', 'suitcase', 'laptop', 'shoe', 'bottle', 'book', 'cell phone', 'cup', 't-shirt', 'jacket'])
        const emb = await robustEmbed(region)
        setQueryEmbed(emb)
        const qpred = await classifyImage(region, 3)
        setQueryLabels(qpred.map((p) => p.className.toLowerCase()))
        setStatusQuery('ready')
      } catch {
        setStatusQuery('error')
        setError('Failed to process the image. Try another URL or upload a file.')
      }
    }
    run()
  }, [queryImgLoaded])

  // Do NOT auto-recompute the catalog if we already loaded precomputed/cache
  useEffect(() => {
    if (queryEmbed && statusCatalog === 'idle') {
      // Only when nothing was loaded at all, compute on demand
      // (You can also expose a button to start this manually)
    }
  }, [queryEmbed, statusCatalog])

  // Manual compute path (only for missing entries)
  async function computeCatalogEmbeddings() {
    if (statusCatalog === 'processing') return
    setStatusCatalog('processing')

    const out = [...embeds]
    const outLabels = [...labels]

    let done = out.filter(Boolean).length
    setProgress(done / PRODUCTS.length)

    // simple bounded concurrency
    const queue: Promise<void>[] = []
    let inFlight = 0
    let i = 0

    const next = async () => {
      while (i < PRODUCTS.length && inFlight < EMBED_CONCURRENCY) {
        const idx = i++
        if (out[idx]) continue
        inFlight++
        const p = (async () => {
          try {
            const img = await loadCatalogImage(PRODUCTS[idx].image)
            const region = await detectAndCrop(img, ['backpack', 'handbag', 'suitcase', 'laptop', 'shoe', 'bottle', 'book', 'cell phone', 'cup', 't-shirt', 'jacket'])
            out[idx] = await robustEmbed(region)
            const preds = await classifyImage(region, 3)
            outLabels[idx] = preds.map((p) => p.className.toLowerCase())
          } catch {
            out[idx] = null
            outLabels[idx] = []
          } finally {
            done++
            setProgress(done / PRODUCTS.length)
            inFlight--
            await tick()
            await next()
          }
        })()
        queue.push(p)
      }
    }
    await next()
    await Promise.all(queue)

    saveCatalogCache(out, outLabels)
    setEmbeds(out)
    setLabels(outLabels)
    setStatusCatalog('ready')
  }

  // Cleanup object URLs
  useEffect(() => () => { if (lastBlobURL.current) URL.revokeObjectURL(lastBlobURL.current) }, [])

  // Score
  const scored = useMemo(() => {
    if (!queryEmbed) return [] as (Scored & { _idx: number })[]
    const rows: (Scored & { _idx: number })[] = []
    for (let i = 0; i < PRODUCTS.length; i++) {
      const emb = embeds[i]
      if (!emb) continue
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

  useEffect(() => {
    if (!autoScrolled && scored.length > 0) {
      requestAnimationFrame(() => {
        resultsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })
      setAutoScrolled(true)
    }
  }, [scored.length, autoScrolled])

  useEffect(() => {
    if (displayQueryUrl && !scrolledStatus) {
      requestAnimationFrame(() => {
        statusRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      })
      setScrolledStatus(true)
    }
  }, [displayQueryUrl, scrolledStatus])

  // UI helpers
  const QueryStatus = () => (
    <div className="flex items-center gap-3">
      <StatusBadge ok={statusQuery === 'ready'} busy={statusQuery === 'processing'} />
      <div className="text-base md:text-lg font-medium tracking-tight">
        {statusQuery === 'idle' && 'Waiting for query'}
        {statusQuery === 'processing' && 'Processing query…'}
        {statusQuery === 'ready' && 'Query embedded'}
        {statusQuery === 'error' && 'Query failed'}
      </div>
    </div>
  )
  const CatalogStatus = () => (
    <div className="flex items-center gap-3">
      <StatusBadge ok={statusCatalog === 'ready'} busy={statusCatalog === 'processing'} />
      <div className="text-base md:text-lg font-medium tracking-tight">
        {statusCatalog === 'idle' && 'Catalog idle'}
        {statusCatalog === 'processing' && 'Catalog embedding…'}
        {statusCatalog === 'ready' && 'Catalog embedded'}
      </div>
    </div>
  )

  return (
    <>
      <Reveal>
        <section className="glass p-5 rounded-2xl">
          <div className="grid md:grid-cols-2 gap-5 items-start">
            {/* Left: Uploader with short helper text */}
            <div className="h-full">
              <Uploader onFile={onFile} onUrl={onUrl} />

              {/* Extra helpful info below uploader */}
              <div className="mt-4 text-sm text-white/85 space-y-3">
                <div className="grid sm:grid-cols-2 gap-3">
                  {/* Quick tips */}
                  <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-3">
                    <div className="text-[11px] uppercase tracking-wide text-white/60">Quick tips</div>
                    <ul className="mt-2 list-disc pl-5 text-[13px] leading-relaxed text-white/80 space-y-1">
                      <li>Use a direct <code>.jpg</code>/<code>.png</code> URL or upload a file for the fastest results.</li>
                      <li>Center the main object; tighter crops improve matching.</li>
                      <li>Need stricter matches? Turn on <i>Prefer same class</i> or raise <i>Min similarity</i>.</li>
                    </ul>
                  </div>

                  {/* Supported sources */}
                  <div className="rounded-xl bg-white/5 ring-1 ring-white/10 p-3">
                    <div className="text-[11px] uppercase tracking-wide text-white/60">Works great with</div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {[...SAFE_HOSTS].map((h) => (
                        <span
                          key={String(h)}
                          className="inline-flex items-center rounded-lg bg-white/10 ring-1 ring-white/15 px-2 py-1 text-[12px] text-white/85"
                          title={String(h)}
                        >
                          {String(h)}
                        </span>
                      ))}
                    </div>
                    <p className="mt-2 text-[12px] text-white/65">
                      Tip: Google/Bing result links usually redirect — open the image in a new tab and copy its direct URL.
                    </p>
                  </div>
                </div>
              </div>
            </div>

            {/* Right: What is this? */}
            <div className="h-full">
              <h2 className="text-xl font-semibold mb-2">What is this?</h2>
              <p className="text-white/85 text-sm leading-relaxed">
                Visual Product Matcher lets you upload a photo or paste an image link to find similar items
                from our demo catalog. Everything runs in your browser for privacy—no images are uploaded to a server.
              </p>
              <ul className="mt-3 grid sm:grid-cols-2 gap-2 text-sm text-white/80">
                <li>• Private: on-device processing</li>
                <li>• Fast: precomputed vectors + caching</li>
                <li>• Smart: CLIP embeddings + object detection</li>
                <li>• Controls: filter by category &amp; similarity</li>
              </ul>
              <div className="mt-4 grid gap-2 text-xs text-white/70">
                <div>
                  Tip: Paste a direct image URL ending in <code>.jpg</code> / <code>.png</code> for fastest results.
                </div>
                <div>
                  Tip: If results look off, toggle “Prefer same class” or raise “Min similarity.”
                </div>
              </div>
              {/* Privacy & speed note (moved here) */}
              <div className="mt-5 rounded-xl bg-white/5 ring-1 ring-white/10 p-3">
                <p className="text-[13px] text-white/80">
                  All processing happens in your browser for privacy. For instant results on repeat visits,
                  precompute the demo catalog once and it will be cached locally.
                </p>
                <button
                  type="button"
                  onClick={computeCatalogEmbeddings}
                  className="mt-3 inline-flex items-center rounded-lg bg-white/10 px-3 py-1.5 text-[13px] ring-1 ring-white/15 hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-indigo-400"
                  title="Compute any missing embeddings now"
                >
                  Precompute catalog
                </button>
              </div>
            </div>
          </div>
        </section>
      </Reveal>

      {displayQueryUrl && (
        <div className="grid md:grid-cols-2 gap-6 mt-5 mb-6">
          <Reveal>
            <div className="glass p-5">
              <div className="text-sm mb-3 text-white/85">Your image</div>
              <img
                ref={imgRef}
                src={displayQueryUrl}
                alt="query"
                crossOrigin="anonymous"
                referrerPolicy="no-referrer"
                onLoad={() => setQueryImgLoaded(true)}
                onError={() => {
                  setStatusQuery('error')
                  setError('Preview failed. Try uploading the file instead.')
                }}
                className="w-full max-h-96 object-contain rounded-2xl bg-black/30"
              />
              {queryLabels.length > 0 && (
                <div className="text-xs text-white/75 mt-3">Predicted: {queryLabels.join(', ')}</div>
              )}
            </div>
          </Reveal>

          <Reveal delay={0.1}>
            <div ref={statusRef} className="glass p-5 flex flex-col gap-3">
              <div className="text-sm text-white/85">Status</div>

              <QueryStatus />
              <div className="progress-track">
                <div
                  className="progress-fill"
                  style={{ width: `${statusQuery === 'ready' ? 100 : statusQuery === 'processing' ? 50 : 0}%` }}
                />
              </div>

              <CatalogStatus />
              <div className="progress-track">
                <div className="progress-fill" style={{ width: `${Math.round(progress * 100)}%` }} />
              </div>
              <div className="text-xs text-white/70">
                {statusCatalog === 'processing' ? `Progress: ${Math.round(progress * 100)}%` : ' '}
              </div>

              <div className="flex flex-wrap gap-2">
                <button
                  className="btn-glass"
                  onClick={computeCatalogEmbeddings}
                  disabled={statusCatalog === 'processing' || progress === 1}
                  aria-disabled={statusCatalog === 'processing' || progress === 1}
                  title={statusCatalog === 'processing' ? 'Working…' : 'Compute any missing embeddings'}
                >
                  Compute missing embeddings
                </button>

                <button
                  className="btn-glass"
                  onClick={() => {
                    localStorage.removeItem(KEY_VECTORS)
                    localStorage.removeItem(KEY_LABELS)
                    setEmbeds(Array(PRODUCTS.length).fill(null))
                    setLabels(Array(PRODUCTS.length).fill([]))
                    setStatusCatalog('idle')
                    setProgress(0)
                  }}
                >
                  Clear cache
                </button>
              </div>

              {error && <div className="text-sm text-rose-200">{error}</div>}
            </div>
          </Reveal>
        </div>
      )}

      {/* Controls */}
      <Reveal delay={0.12}>
        <div className="glass px-4 py-3 mt-4 mb-8 flex flex-wrap gap-x-6 gap-y-3 items-center">
          <div className="flex items-center gap-2">
            <label className="text-sm text-white/85">Min similarity</label>
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
            <label className="text-sm text-white/85">Top K</label>
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
            <label className="text-sm text-white/85">Category</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="glass px-3 py-1.5 rounded-xl text-slate-100"
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
              className="switch"
              checked={preferQueryClass}
              onChange={(e) => setPreferQueryClass(e.target.checked)}
            />
            <span className="text-sm text-white/85">Prefer same class as query</span>
          </label>

          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="switch"
              checked={onlySameClass}
              onChange={(e) => setOnlySameClass(e.target.checked)}
            />
            <span className="text-sm text-white/85">Only show same class</span>
          </label>

          <div className="ml-auto flex gap-2">
            <button onClick={() => {
              setMinScore(0.25); setTopK(16); setCategory('All'); setPreferQueryClass(true); setOnlySameClass(false)
            }} className="btn-glass">
              Reset filters
            </button>
          </div>
        </div>
      </Reveal>

      {/* Results */}
      <section ref={resultsRef}>
        <Reveal delay={0.15}>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5 md:gap-6">
            {scored.map((item, visibleIndex) => (
              <Reveal key={`rev-${item.id}`} delay={Math.min(visibleIndex, 10) * 0.05}>
                <ProductCard
                  item={item}
                  score={item.score}
                  label={`Image ${visibleIndex + 1}`}
                  onSelect={() => { document.title = `Image ${visibleIndex + 1}` }}
                />
              </Reveal>
            ))}
          </div>
        </Reveal>

        {!queryEmbed && (
          <div className="text-center text-white/70 mt-8 text-sm">
            Upload an image or paste a URL to see similar items.
          </div>
        )}

        {queryEmbed && statusCatalog !== 'ready' && (
          <div className="text-center text-white/70 mt-8 text-sm">
            Using precomputed vectors if available… otherwise compute runs once and results will stream in.
          </div>
        )}

        {queryEmbed && statusCatalog === 'ready' && (scored as any[]).length === 0 && (
          <div className="text-center text-white/70 mt-8 text-sm">
            No matches ≥ {(minScore * 100).toFixed(0)}%. Lower <b>Min similarity</b>, increase <b>Top K</b>, or change filters.
          </div>
        )}
      </section>

      <Reveal delay={0.18}>
        <section className="glass p-5 rounded-2xl mt-6">
          <h3 className="text-xl font-semibold mb-2">Thanks for visiting 👋</h3>
          <p className="text-white/85 text-sm leading-relaxed">
            You’re using <b>Visual Product Matcher</b> — a private, client‑side visual search. Drop a photo or paste an image URL and we’ll find visually similar items from the demo catalog. Nothing is uploaded to a server.
          </p>
          <ul className="mt-3 text-sm text-white/80 list-disc pl-5 space-y-1">
            <li><b>Fastest results:</b> Use direct <code>.jpg</code>/<code>.png</code> links or upload a file.</li>
            <li><b>Tune precision:</b> Raise <i>Min similarity</i> or enable <i>Prefer same class</i> to tighten matches.</li>
            <li>
              <b>Bigger catalogs:</b> Precompute vectors once and they’ll load instantly on next visits.{` `}
              <button
                type="button"
                onClick={computeCatalogEmbeddings}
                className="inline-flex items-center rounded-lg bg-white/10 px-2 py-1 text-xs ring-1 ring-white/15 hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-indigo-400"
              >
                Precompute now
              </button>
            </li>
          </ul>
          <div className="mt-4 text-sm text-white/80">
            Built with ❤️ by <a href="https://github.com/starkbbk" target="_blank" rel="noreferrer" className="underline decoration-white/40 hover:text-white">starkbbk</a>. 
            Have feedback? Use the contact form below or email <a href="mailto:starkbbk@gmail.com" className="underline decoration-white/40 hover:text-white">starkbbk@gmail.com</a>.
          </div>
        </section>
      </Reveal>
    </>
  )
}

/* --------------------
 * Status badge (green check / spinner)
 * -------------------- */
function StatusBadge({ ok, busy }: { ok?: boolean; busy?: boolean }) {
  return (
    <span
      className="inline-grid place-items-center"
      aria-hidden="true"
      style={{ width: 22, height: 22 }}
    >
      {ok ? (
        <svg viewBox="0 0 24 24" width="22" height="22">
          <circle cx="12" cy="12" r="11" fill="rgba(16,185,129,0.25)" />
          <circle cx="12" cy="12" r="10" fill="rgba(16,185,129,1)" />
          <path d="M7.5 12.5l2.7 2.7L16.5 9" stroke="white" strokeWidth="2.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      ) : busy ? (
        <svg viewBox="0 0 50 50" width="22" height="22" className="animate-spin-slow">
          <circle cx="25" cy="25" r="20" stroke="rgba(255,255,255,0.25)" strokeWidth="6" fill="none" />
          <path d="M45 25a20 20 0 0 1-20 20" stroke="white" strokeWidth="6" fill="none" strokeLinecap="round" />
          <style>{`.animate-spin-slow{animation:rot 1s linear infinite}@keyframes rot{to{transform:rotate(360deg)}}`}</style>
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" width="22" height="22">
          <circle cx="12" cy="12" r="10" fill="rgba(255,255,255,0.25)" />
        </svg>
      )}
    </span>
  )
}

/* --------------------
 * Simple reveal helper
 * -------------------- */
function Reveal({ children, className = '', delay = 0 }: { children: React.ReactNode; className?: string; delay?: number }) {
  const ref = React.useRef<HTMLDivElement>(null)
  React.useEffect(() => {
    const node = ref.current
    if (!node) return

    const reduced = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reduced) {
      node.style.opacity = '1'
      node.style.transform = 'none'
      return
    }

    node.style.opacity = '0'
    node.style.transform = 'translateY(20px)'
    node.style.willChange = 'opacity, transform'

    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            node.style.transition = `opacity 650ms cubic-bezier(0.22,1,0.36,1) ${delay}s, transform 650ms cubic-bezier(0.22,1,0.36,1) ${delay}s`
            node.style.opacity = '1'
            node.style.transform = 'translateY(0)'
            io.unobserve(node)
          }
        })
      },
      { threshold: 0.12, rootMargin: '0px 0px -8% 0px' }
    )

    io.observe(node)
    return () => io.disconnect()
  }, [delay])

  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}

/* --------------------
 * ABOUT / PRICING (unchanged)
 * -------------------- */
function About() {
  return (
    <>
      <Reveal>
        <section className="glass p-6 rounded-2xl">
          <h2 className="text-2xl font-semibold mb-2">About</h2>
          <p className="text-white/85">
            Visual Product Matcher finds visually similar items in a local catalog using client-side ML (CLIP with MobileNet fallback and COCO-SSD for object detection). No server required.
          </p>
        </section>
      </Reveal>
      <Reveal>
        <section id="contact" className="glass p-6 rounded-2xl">
          <h3 className="text-xl font-semibold mb-2">Contact</h3>
          <p className="text-white/80 text-sm">
            Have feedback or a feature request? Send us a message or reach us on LinkedIn / GitHub.
          </p>

          <form
            className="mt-4 grid md:grid-cols-2 gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              alert('Thanks! We received your message.');
            }}
          >
            <input
              name="name"
              required
              placeholder="Your name"
              className="glass px-3 py-2 rounded-xl"
            />
            <input
              name="email"
              required
              type="email"
              placeholder="Your email"
              className="glass px-3 py-2 rounded-xl"
            />
            <textarea
              name="message"
              required
              placeholder="Message"
              rows={4}
              className="glass px-3 py-2 rounded-xl md:col-span-2"
            />
            <button className="btn-glass md:col-span-2">Send message</button>
          </form>

          <p className="mt-4 text-sm text-white/70">
            or email us directly:{' '}
            <a
              href="mailto:starkbbk@gmail.com"
              className="text-indigo-300 underline underline-offset-2 hover:text-indigo-200"
            >
              starkbbk@gmail.com
            </a>
          </p>

          {/* Always-visible social buttons (desktop + mobile) */}
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <a
              href="https://linkedin.com/in/starkbbk"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2 text-white ring-1 ring-white/15 hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
                <path d="M4.98 3.5C4.98 4.88 3.86 6 2.5 6S0 4.88 0 3.5 1.12 1 2.5 1s2.48 1.12 2.48 2.5zM0 8h5v15H0zM8 8h4.8v2.1h.07c.67-1.27 2.3-2.6 4.73-2.6C21.4 7.5 24 9.5 24 13.6V23H19V14.8c0-1.95-.03-4.45-2.71-4.45-2.71 0-3.13 2.12-3.13 4.31V23H8z"/>
              </svg>
              <span className="text-sm font-medium">LinkedIn</span>
            </a>

            <a
              href="https://github.com/starkbbk/Visual-Product-Matcher"
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-2 rounded-xl bg-white/10 px-3 py-2 text-white ring-1 ring-white/15 hover:bg-white/15 focus:outline-none focus:ring-2 focus:ring-indigo-400"
            >
              <svg viewBox="0 0 24 24" className="h-5 w-5 fill-current" aria-hidden="true">
                <path d="M12 .5a12 12 0 0 0-3.79 23.4c.6.11.82-.26.82-.58v-2.2c-3.34.73-4.04-1.6-4.04-1.6-.55-1.4-1.35-1.77-1.35-1.77-1.1-.76.08-.75.08-.75 1.22.09 1.87 1.26 1.87 1.26 1.08 1.85 2.83 1.32 3.52 1.01.11-.8.42-1.32.76-1.62-2.66-.3-5.47-1.34-5.47-5.95 0-1.32.47-2.39 1.24-3.24-.12-.3-.54-1.52.12-3.16 0 0 1.01-.32 3.32 1.23a11.5 11.5 0 0 1 6.04 0c2.31-1.55 3.31-1.23 3.31-1.23.67 1.64.25 2.86.13 3.16.77.85 1.23 1.92 1.23 3.24 0 4.62-2.81 5.64-5.49 5.94.43.37.81 1.1.81 2.22v3.29c0 .32.21.7.83.58A12 12 0 0 0 12 .5z"/>
              </svg>
              <span className="text-sm font-medium">GitHub</span>
            </a>
          </div>
        </section>
      </Reveal>
    </>
  )
}

function Pricing() {
  return (
    <>
      <Reveal>
        <section className="glass p-6 rounded-2xl" id="subscribe">
          <h2 className="text-2xl font-semibold mb-2">Pricing</h2>
          <p className="text-white/85">Start free, upgrade to Pro when you’re ready.</p>
        </section>
      </Reveal>
      <section className="grid md:grid-cols-2 gap-4">
        <Reveal delay={0.05}>
          <div className="glass p-6 rounded-2xl">
            <h3 className="text-xl font-semibold">Free</h3>
            <ul className="mt-2 space-y-1 text-sm text-white/85">
              <li>• Upload via file/URL</li>
              <li>• Similarity search on sample catalog</li>
              <li>• Local-only processing</li>
            </ul>
            <a href="#subscribe" className="btn-glass mt-4 inline-block">
              Get Free
            </a>
          </div>
        </Reveal>
        <Reveal delay={0.1}>
          <div className="glass p-6 rounded-2xl" id="pro">
            <h3 className="text-xl font-semibold">Pro</h3>
            <ul className="mt-2 space-y-1 text-sm text-white/85">
              <li>• Larger catalogs</li>
              <li>• Faster CLIP model</li>
              <li>• Priority support</li>
            </ul>
            <a href="#subscribe" className="btn-glass mt-4 inline-block">
              Buy Pro
            </a>
          </div>
        </Reveal>
      </section>
    </>
  )
}

/* --------------------
 * NAV, FOOTER, SHELL
 * -------------------- */
function Navbar() {
  const linkBase =
    'px-3 py-2 rounded-xl text-sm md:text-[15px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40';
  const linkActive = 'text-white bg-white/15';
  const linkIdle = 'text-white/85 hover:text-white hover:bg-white/10';

  const [open, setOpen] = React.useState(false);
  const [contactOpen, setContactOpen] = React.useState(false);

  // lock body scroll when menu is open (mobile)
  React.useEffect(() => {
    const root = document.documentElement;
    if (open) root.classList.add('overflow-hidden');
    else root.classList.remove('overflow-hidden');
    return () => root.classList.remove('overflow-hidden');
  }, [open]);

  // Esc closes the sheet
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <>
      <header className="sticky top-0 z-[1200] px-4 sm:px-6 lg:px-8 py-3">
        <div className="glass-strong px-3 py-2 rounded-2xl flex items-center justify-between">
          <Link to="/" className="text-lg md:text-xl font-semibold tracking-tight">
            Visual Product Matcher
          </Link>

          {/* desktop nav */}
          <nav className="hidden md:flex items-center gap-2">
            <NavLink to="/" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
              Home
            </NavLink>
            <NavLink to="/about" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
              About
            </NavLink>
            <NavLink to="/pricing" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
              Pricing
            </NavLink>
            <button type="button" onClick={() => setContactOpen(true)} className={`${linkBase} ${linkIdle}`}>Contact</button>
          </nav>

          {/* mobile hamburger */}
          <button
            aria-label="Open menu"
            onClick={() => setOpen(true)}
            className="md:hidden inline-flex items-center justify-center rounded-xl bg-white/20 ring-1 ring-white/25 text-white w-11 h-11"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>
      </header>

      {/* mobile overlay menu (portal to body) */}
      {open &&
        createPortal(
          <>
            <div className="fixed inset-0 z-[1300] bg-slate-950/70 backdrop-blur-sm" onClick={() => setOpen(false)} />
            <div className="fixed inset-0 z-[1400] flex">
              <div className="ml-auto h-full w-full max-w-md bg-slate-900 text-slate-100 shadow-2xl
                              pt-safe pb-[calc(env(safe-area-inset-bottom)+24px)] overflow-y-auto">
                <div className="px-6 py-5 flex items-center justify-between">
                  <h2 className="text-xl font-semibold">Menu</h2>
                  <button
                    aria-label="Close menu"
                    onClick={() => setOpen(false)}
                    className="inline-flex items-center rounded-xl bg-white/10 px-3 py-1.5 ring-1 ring-white/20"
                  >
                    Close
                  </button>
                </div>

                <nav className="px-4 pb-6 grid gap-2 text-lg">
                  <NavLink to="/" onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 hover:bg-white/10">Home</NavLink>
                  <NavLink to="/about" onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 hover:bg-white/10">About</NavLink>
                  <NavLink to="/pricing" onClick={() => setOpen(false)} className="rounded-lg px-3 py-2 hover:bg-white/10">Pricing</NavLink>
                  <button
                    type="button"
                    onClick={() => { setOpen(false); setContactOpen(true); }}
                    className="text-left rounded-lg px-3 py-2 hover:bg-white/10"
                  >
                    Contact
                  </button>
                </nav>

                <div className="px-4 border-t border-white/10 pt-5 grid gap-3">
                  <a href="https://www.linkedin.com/in/starkbbk" target="_blank" rel="noreferrer" className="rounded-lg px-3 py-2 bg-white/10 ring-1 ring-white/15">LinkedIn</a>
                  <a href="https://github.com/starkbbk" target="_blank" rel="noreferrer" className="rounded-lg px-3 py-2 bg-white/10 ring-1 ring-white/15">GitHub</a>
                </div>
              </div>
            </div>
          </>,
          document.body
        )}
      {contactOpen && <ContactModal onClose={() => setContactOpen(false)} />}
    </>
  );
}

function ContactModal({ onClose }: { onClose: () => void }) {
  const CONTACT_EMAIL = 'starkbbk@gmail.com';

  function submitContact(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = String(data.get('name') || '');
    const email = String(data.get('email') || '');
    const message = String(data.get('message') || '');
    const subject = encodeURIComponent(`VPM Contact from ${name || 'Anonymous'}`);
    const body = encodeURIComponent(`From: ${name}\nEmail: ${email}\n\n${message}`);
    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
    onClose();
  }

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return createPortal(
    <>
      <div
        className="fixed inset-0 z-[1500] bg-slate-950/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden="true"
      />
      <div className="fixed inset-0 z-[1600] grid place-items-center px-4 py-6">
        <div
          className="w-full max-w-lg rounded-2xl bg-slate-900 text-slate-100 shadow-2xl ring-1 ring-white/15
                     p-5 md:p-6"
          role="dialog"
          aria-modal="true"
          aria-label="Contact form"
        >
          <div className="flex items-center justify-between">
            <h2 className="text-lg md:text-xl font-semibold">Contact us</h2>
            <button
              type="button"
              onClick={onClose}
              className="inline-flex items-center rounded-xl bg-white/10 px-3 py-1.5 ring-1 ring-white/20"
              aria-label="Close contact dialog"
            >
              Close
            </button>
          </div>

          <form onSubmit={submitContact} className="mt-4 grid gap-3">
            <input
              name="name"
              type="text"
              placeholder="Your name"
              className="rounded-xl bg-slate-900/50 border border-white/10 px-3 py-2 text-white placeholder:text-slate-500"
            />
            <input
              name="email"
              type="email"
              required
              placeholder="you@example.com"
              className="rounded-xl bg-slate-900/50 border border-white/10 px-3 py-2 text-white placeholder:text-slate-500"
            />
            <textarea
              name="message"
              required
              rows={4}
              placeholder="How can we help?"
              className="rounded-xl bg-slate-900/50 border border-white/10 px-3 py-2 text-white placeholder:text-slate-500 resize-y"
            />
            <div className="flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="inline-flex items-center rounded-xl bg-white/10 px-4 py-2 ring-1 ring-white/20"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="inline-flex items-center rounded-xl bg-white/90 text-slate-900 px-4 py-2 font-medium hover:bg-white"
              >
                Send
              </button>
            </div>
            <p className="text-xs text-slate-400">
              or email us directly: <a className="underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            </p>
          </form>
        </div>
      </div>
    </>,
    document.body
  );
}
function Stars({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex gap-1" aria-label="Rate this app">
      {[1, 2, 3, 4, 5].map((n) => (
        <button
          key={n}
          type="button"
          onClick={() => onChange(n)}
          className="p-1"
          aria-label={`${n} star${n > 1 ? 's' : ''}`}
          title={`${n} star${n > 1 ? 's' : ''}`}
        >
          <svg
            className={`h-7 w-7 ${n <= value ? 'fill-yellow-400' : 'fill-transparent'} stroke-yellow-400`}
            viewBox="0 0 24 24"
            strokeWidth="2"
          >
            <path d="M12 17.3l-6.16 3.64 1.78-7.64L2 8.36l7.72-.66L12 0.5l2.28 7.2 7.72.66-5.62 4.94 1.78 7.64z" />
          </svg>
        </button>
      ))}
    </div>
  );
}

function Footer() {
  const CONTACT_EMAIL = 'starkbbk@gmail.com';
  const RATING_KEY = 'vpm:userRating';
  const [rating, setRating] = React.useState<number>(0);
  const [sent, setSent] = React.useState(false);

  React.useEffect(() => {
    const saved = Number(localStorage.getItem(RATING_KEY) || 0);
    if (saved) setRating(saved);
  }, []);

  function handleRate(v: number) {
    setRating(v);
    localStorage.setItem(RATING_KEY, String(v));
  }

  function submitContact(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    const name = String(data.get('name') || '');
    const email = String(data.get('email') || '');
    const message = String(data.get('message') || '');
    const subject = encodeURIComponent(`VPM Contact from ${name || 'Anonymous'}`);
    const body = encodeURIComponent(`From: ${name}\nEmail: ${email}\n\n${message}\n\nRating: ${rating || 'N/A'}★`);
    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
    setSent(true);
    e.currentTarget.reset();
  }

  return (
    <footer id="contact" className="relative z-50 mt-10 md:mt-14 pb-[calc(env(safe-area-inset-bottom,0px)+1.25rem)] border-t border-white/10">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-10">
        <div className="grid gap-10 md:gap-12 lg:gap-16 md:grid-cols-2">
          <section className="rounded-2xl bg-white/5 ring-1 ring-white/10 p-6">
            <h3 className="text-white text-xl font-semibold">Rate your experience</h3>
            <p className="text-slate-300 mt-1">Help us improve by leaving a quick rating.</p>
            <div className="mt-4">
              <Stars value={rating} onChange={handleRate} />
              {rating > 0 && (
                <p className="mt-2 text-slate-300">
                  Thanks! You rated this <span className="font-semibold">{rating} / 5</span>.
                </p>
              )}
            </div>
          </section>

          <section className="rounded-2xl bg-white/5 ring-1 ring-white/10 p-6">
            <h3 className="text-white text-xl font-semibold">Contact us</h3>
            <p className="text-slate-300 mt-1">Have feedback or a feature request? Send us a message.</p>
            <form onSubmit={submitContact} className="mt-4 grid gap-3">
              <div className="grid gap-2">
                <label className="text-sm text-slate-300">Name</label>
                <input name="name" type="text" className="rounded-xl bg-slate-900/50 border border-white/10 px-3 py-2 text-white placeholder:text-slate-500" placeholder="Your name" />
              </div>
              <div className="grid gap-2">
                <label className="text-sm text-slate-300">Email</label>
                <input name="email" type="email" required className="rounded-xl bg-slate-900/50 border border-white/10 px-3 py-2 text-white placeholder:text-slate-500" placeholder="you@example.com" />
              </div>
              <div className="grid gap-2">
                <label className="text-sm text-slate-300">Message</label>
                <textarea name="message" required rows={4} className="rounded-xl bg-slate-900/50 border border-white/10 px-3 py-2 text-white placeholder:text-slate-500 resize-y" placeholder="How can we help?" />
              </div>
              <div className="flex items-center gap-3">
                <button type="submit" className="inline-flex items-center rounded-xl bg-white/90 text-slate-900 px-4 py-2 font-medium hover:bg-white">
                  Send
                </button>
                {sent && <span className="text-sm text-green-300">Thanks! Your email client should open.</span>}
              </div>
              <p className="text-xs text-slate-400">
                or email us directly: <a className="underline" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
              </p>
            </form>
          </section>
        </div>

        <p className="text-center text-xs text-white/70 mt-10">
          Built with React, Vite &amp; Tailwind. Similarity: CLIP (transformers.js) with MobileNet fallback + COCO-SSD. Catalog via precomputed embeddings or local compute.
        </p>
      </div>
    </footer>
  );
}

function AppShell() {
  const location = useLocation()
  return (
    <div className="min-h-[100svh] bg-aurora text-slate-100 overflow-x-hidden">
      <Snowfall enabled density={0.8} zIndex={1} />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[2000] bg-white/90 text-slate-900 px-3 py-2 rounded-md">Skip to content</a>
      <Navbar />
      <main
        id="main"
        className="relative z-[30] max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 md:py-8 flex flex-col gap-6 pb-[calc(env(safe-area-inset-bottom,0px)+4.5rem)] md:pb-12"
      >
        <div className={location.pathname === '/' ? '' : 'hidden'}>
          <Home />
        </div>
        <Routes>
          <Route path="/about" element={<About />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Footer />
    </div>
  )
}

export default function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  )
}