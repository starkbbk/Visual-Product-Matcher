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
      document.title = DEFAULT_TITLE
    } catch {
      setDisplayQueryUrl(null)
      setQueryImgLoaded(false)
      setStatusQuery('error')
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
        <Uploader onFile={onFile} onUrl={onUrl} />
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
            <div className="glass p-5 flex flex-col gap-3">
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
      <section>
        <Reveal delay={0.15}>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5 md:gap-6">
            {scored.map((item, visibleIndex) => (
              <Reveal key={`rev-${item.id}`} delay={Math.min(visibleIndex, 10) * 0.05}>
                <ProductCard
                  item={item}
                  score={item.score}
                  label={`Picture ${visibleIndex + 1}`}
                  onSelect={() => { document.title = `Picture ${visibleIndex + 1}` }}
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
          <form
            className="grid md:grid-cols-2 gap-4"
            onSubmit={(e) => {
              e.preventDefault()
              alert('Thanks! We received your message.')
            }}
          >
            <input name="name" required placeholder="Your name" className="glass px-3 py-2 rounded-xl" />
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
  const linkBase = 'px-3 py-2 rounded-xl text-sm md:text-[15px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
  const linkActive = 'text-white bg-white/15'
  const linkIdle   = 'text-white/85 hover:text-white hover:bg-white/10'
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <header className="sticky top-0 z-[1200] px-4 sm:px-6 lg:px-8 py-3">
      <div className="glass-strong px-3 py-2 rounded-2xl flex items-center justify-between overflow-x-hidden">
        <Link to="/" className="text-lg md:text-xl font-semibold tracking-tight">
          Visual Product Matcher
        </Link>
        <nav className="hidden md:flex items-center gap-2">
          <div className="flex items-center gap-2">
            <NavLink to="/" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
              Home
            </NavLink>
            <NavLink to="/about" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>About</NavLink>
            <NavLink to="/pricing" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>Pricing</NavLink>
          </div>
          <div className="relative">
            <button onClick={() => setOpen((v) => !v)} className={`${linkBase} ${linkIdle}`}>Contact ▾</button>
            {open &&
              createPortal(
                <>
                  <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[1300]" onClick={() => setOpen(false)} />
                  <div className="fixed inset-0 z-[1400] flex items-center justify-center p-4">
                    <div className="w-[min(95vw,560px)] rounded-2xl bg-slate-900/85 backdrop-blur-xl ring-1 ring-white/15 shadow-2xl p-6">
                      <h3 className="text-2xl font-semibold mb-4">Contact</h3>
                      <div className="grid gap-3">
                        <a href="https://www.linkedin.com/in/starkbbk" target="_blank" rel="noreferrer" className="flex items-center gap-3 px-3 py-3 rounded-xl text-white hover:bg-white/10 transition-colors">
                          <span aria-hidden className="shrink-0 grid place-items-center w-10 h-10 rounded-xl bg-white/10 ring-1 ring-white/15">
                            <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                              <path fill="#0A66C2" d="M22.225 0H1.771C.792 0 0 .771 0 1.723v20.554C0 23.229.792 24 1.771 24h20.451C23.2 24 24 23.229 24 22.277V1.723C24 .771 23.2 0 22.225 0zM7.119 20.452H3.558V9h3.561v11.452zM5.338 7.433a2.066 2.066 0 1 1 0-4.133 2.066 2.066 0 0 1 0 4.133zM20.447 20.452h-3.554v-5.569c0-1.328-.024-3.036-1.852-3.036-1.853 0-2.136 1.447-2.136 2.944v5.661H9.352V9h3.414v1.561h.047c.476-.9 1.637-1.852 3.368-1.852 3.6 0 4.266 2.37 4.266 5.456v6.287z"/>
                            </svg>
                          </span>
                          <span className="text-base">LinkedIn</span>
                        </a>
                        <a href="https://github.com/starkbbk" target="_blank" rel="noreferrer" className="flex items-center gap-3 px-3 py-3 rounded-xl text-white hover:bg-white/10 transition-colors">
                          <span aria-hidden className="shrink-0 grid place-items-center w-10 h-10 rounded-xl bg-white/10 ring-1 ring-white/15">
                            <img src="https://cdn.simpleicons.org/github/ffffff" width="22" height="22" alt="" />
                          </span>
                          <span className="text-base">GitHub</span>
                        </a>
                        <a href="https://leetcode.com/u/starkbbk/" target="_blank" rel="noreferrer" className="flex items-center gap-3 px-3 py-3 rounded-xl text-white hover:bg-white/10 transition-colors">
                          <span className="shrink-0 grid place-items-center w-10 h-10 rounded-xl bg-white/10 ring-1 ring-white/15">
                            <img src="https://cdn.simpleicons.org/leetcode/F89F1B" width="22" height="22" alt="" />
                          </span>
                          <span className="text-base">LeetCode</span>
                        </a>
                        <a href="http://instagram.com/starkbbk/" target="_blank" rel="noreferrer" className="flex items-center gap-3 px-3 py-3 rounded-xl text-white hover:bg-white/10 transition-colors">
                          <span className="shrink-0 grid place-items-center w-10 h-10 rounded-xl bg-white/10 ring-1 ring-white/15">
                            <img src="https://cdn.simpleicons.org/instagram/E4405F" width="22" height="22" alt="" />
                          </span>
                          <span className="text-base">Instagram</span>
                        </a>
                      </div>
                      <div className="flex justify-end mt-5">
                        <button className="btn-glass text-base px-4 py-2" onClick={() => setOpen(false)}>Close</button>
                      </div>
                    </div>
                  </div>
                </>,
                document.body
              )}
          </div>
        </nav>
      </div>
    </header>
  )
}

function Footer() {
  const reviews = [
    { name: 'Aarav Mehta', role: 'E-commerce lead', rating: 4.9, text: 'Matched thousands of product photos without any server setup. The frosted UI is a bonus.' },
    { name: 'Sana Kapoor', role: 'Design Ops', rating: 4.8, text: 'Drag a pic in, get similar shots immediately. The local-only processing is great for privacy.' },
    { name: 'Dev Sharma', role: 'Frontend Engineer', rating: 5.0, text: 'CLIP + MobileNet fallback makes it feel instant. Works even on my older laptop.' },
  ]
  return (
    <footer className="relative z-50 mt-10 md:mt-14 pb-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <p className="text-center text-xs text-white/70 mt-8">
          Built with React, Vite &amp; Tailwind. Similarity: CLIP (transformers.js) with MobileNet fallback + COCO-SSD. Catalog via precomputed embeddings or local compute.
        </p>
      </div>
    </footer>
  )
}

function AppShell() {
  const location = useLocation()
  return (
    <div className="min-h-screen bg-aurora text-slate-100 overflow-x-hidden">
      <Snowfall enabled density={0.8} zIndex={1} />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[2000] bg-white/90 text-slate-900 px-3 py-2 rounded-md">Skip to content</a>
      <Navbar />
      <main id="main" className="relative z-[30] max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 md:py-8 flex flex-col gap-6">
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