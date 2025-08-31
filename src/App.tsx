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
import pLimit from 'p-limit'

import Uploader from './components/Uploader'
import ProductCard from './components/ProductCard'
import Snowfall from './components/Snowfall'
import { PRODUCTS, Product } from './data/products'
import { classifyImage, detectAndCrop, imageToEmbedding } from './lib/mobilenet'
import { clipImageEmbedding } from './lib/clip'
import { cosineSimilarity } from './lib/similarity'

type Scored = Product & { score: number }
const DEFAULT_TITLE = 'Visual Product Matcher'

// --- Tuning knobs ---
const CACHE_VER = 'v1'
const CACHE_EMBEDS = `vpm:catalogEmbeds:${CACHE_VER}`
const CACHE_LABELS = `vpm:catalogLabels:${CACHE_VER}`
const REMOTE_EMBEDS_URL = '/embeds.v1.json'
const REMOTE_LABELS_URL = '/labels.v1.json'

const EMBED_CONCURRENCY = Math.min(3, Math.max(2, Math.floor((((navigator as any)?.hardwareConcurrency) ?? 6) / 3)))

// CORS proxy for remote images if direct CORS fails
const PROXY = 'https://images.weserv.nl/?url='
const SAFE_HOSTS = new Set([
  'upload.wikimedia.org',
  'picsum.photos',
  'images.unsplash.com',
  'i.imgur.com',
])

/* --------------------
 * Utilities
 * -------------------- */
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

/** Prefer CLIP, fallback to MobileNet embedding */
async function robustEmbed(img: HTMLImageElement | HTMLCanvasElement) {
  try {
    return await clipImageEmbedding(img as any)
  } catch {
    return await imageToEmbedding(img as any)
  }
}

/** For demo sources like picsum, fetch a smaller 256x256 to cut bytes. */
function prefer256(u: string) {
  if (/\/\/picsum\.photos\/.*\/640\/640(?:$|\?)/.test(u)) {
    return u.replace(/\/640\/640(\b|$)/, '/256/256$1')
  }
  if (/images\.unsplash\.com/.test(u)) {
    const url = new URL(u)
    if (url.searchParams.has('w')) url.searchParams.set('w', '256')
    if (url.searchParams.has('h')) url.searchParams.set('h', '256')
    return url.toString()
  }
  if (/\/\/loremflickr\.com\//.test(u)) {
    return u.replace(/\/\d{2,4}\/\d{2,4}(?=\/)/, '/256/256')
  }
  return u
}

const IMG_EXT = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?.*)?$/i
const looksLikeImageUrl = (u: string) => IMG_EXT.test(u) || u.startsWith('data:image/')
const dec = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }

/** Resolve common wrapper links (Google/Bing Images, Drive, Dropbox, etc.) to a direct image URL */
function resolveImageUrl(input: string): string {
  const s = input.trim()
  if (!s) return s
  if (looksLikeImageUrl(s)) return s

  let url: URL
  try { url = new URL(s) } catch { return s }

  if (url.hostname.includes('google.') && url.pathname.includes('/imgres')) {
    const cand = url.searchParams.get('imgurl') || url.searchParams.get('imgrefurl') || ''
    return dec(cand) || s
  }
  if (url.hostname.includes('bing.com')) {
    const cand = url.searchParams.get('mediaurl')
    if (cand) return dec(cand)
  }
  const mDrive = url.hostname.includes('drive.google.com') && url.pathname.match(/\/file\/d\/([^/]+)/)
  if (mDrive) return `https://drive.google.com/uc?export=download&id=${mDrive[1]}`
  if (url.hostname.endsWith('dropbox.com')) {
    url.searchParams.set('dl', '1')
    return url.toString()
  }
  if (url.hostname.endsWith('unsplash.com')) {
    const m = url.pathname.match(/\/photos\/([A-Za-z0-9_-]+)/)
    if (m) return `https://images.unsplash.com/photo-${m[1]}?w=256&h=256&fit=crop`
  }
  if (url.hostname.endsWith('imgur.com')) {
    const m = url.pathname.match(/\/(gallery|a)\/([A-Za-z0-9]+)$/) || url.pathname.match(/\/([A-Za-z0-9]+)$/)
    if (m) return `https://i.imgur.com/${m[m.length - 1]}.jpg`
  }
  return s
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

async function loadCatalogImage(url: string): Promise<HTMLImageElement> {
  const objUrl = await fetchToObjectURL(prefer256(url))
  try {
    return await loadImageFromSrc(objUrl)
  } finally {}
}

function tick() {
  return new Promise<void>((r) => requestAnimationFrame(() => r()))
}

function to224(el: HTMLImageElement | HTMLCanvasElement) {
  const W = 224, H = 224
  const canvas: HTMLCanvasElement | OffscreenCanvas =
    typeof OffscreenCanvas !== 'undefined'
      ? new OffscreenCanvas(W, H)
      : Object.assign(document.createElement('canvas'), { width: W, height: H })
  // @ts-ignore
  canvas.width = W; (canvas as any).height = H
  const ctx = (canvas as any).getContext('2d')!
  const sw = (el as any).width ?? (el as HTMLImageElement).naturalWidth
  const sh = (el as any).height ?? (el as HTMLImageElement).naturalHeight
  const scale = Math.min(W / sw, H / sh)
  const dw = Math.round(sw * scale), dh = Math.round(sh * scale)
  const dx = Math.floor((W - dw) / 2), dy = Math.floor((H - dh) / 2)
  ctx.clearRect(0, 0, W, H)
  ctx.drawImage(el as any, 0, 0, sw, sh, dx, dy, dw, dh)
  return canvas
}

function warmModelsOnce() {
  const k = 'vpm:warmed'
  if (sessionStorage.getItem(k)) return
  sessionStorage.setItem(k, '1')

  const W = 224, H = 224
  const c = Object.assign(document.createElement('canvas'), { width: W, height: H }) as HTMLCanvasElement
  const ctx = c.getContext('2d')!
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)

  Promise.race([imageToEmbedding(c as any), new Promise(r => setTimeout(r, 1200))]).catch(() => {})
  clipImageEmbedding(c as any).catch(() => {})
}

/* --------------------
 * Small helpers for mobile
 * -------------------- */
function useIsMobile() {
  const [m, setM] = useState(false)
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 640px)')
    const handler = (e: MediaQueryListEvent) => setM(e.matches)
    setM(mq.matches)
    mq.addEventListener ? mq.addEventListener('change', handler) : mq.addListener(handler)
    return () => {
      mq.removeEventListener ? mq.removeEventListener('change', handler) : mq.removeListener(handler)
    }
  }, [])
  return m
}

/* --------------------
 * HOME (matcher)
 * -------------------- */
function Home() {
  const [displayQueryUrl, setDisplayQueryUrl] = useState<string | null>(null)
  const [queryImgLoaded, setQueryImgLoaded] = useState(false)
  const [queryEmbed, setQueryEmbed] = useState<Float32Array | null>(null)
  const [queryLabels, setQueryLabels] = useState<string[]>([])

  const [embeds, setEmbeds] = useState<(Float32Array | null)[]>(Array(PRODUCTS.length).fill(null))
  const [labels, setLabels] = useState<string[][]>(Array(PRODUCTS.length).fill([]))
  const hasEmbeds = embeds.some(Boolean)

  const [progress, setProgress] = useState(0)
  const [statusQuery, setStatusQuery] = useState<'idle' | 'processing' | 'ready' | 'error'>('idle')
  const [statusCatalog, setStatusCatalog] = useState<'idle' | 'processing' | 'ready' | 'error'>('idle')
  const [error, setError] = useState<string | null>(null)
  const [minScore, setMinScore] = useState(0.15)
  const [topK, setTopK] = useState(12)
  const [category, setCategory] = useState<string>('All')
  const [preferQueryClass, setPreferQueryClass] = useState(true)
  const [onlySameClass, setOnlySameClass] = useState(false)
  const [fastMode, setFastMode] = useState(true)

  const imgRef = useRef<HTMLImageElement>(null)
  const lastBlobURL = useRef<string | null>(null)

  useEffect(() => {
    document.title = DEFAULT_TITLE
  }, [])

  useEffect(() => {
    try {
      const e = localStorage.getItem(CACHE_EMBEDS)
      const l = localStorage.getItem(CACHE_LABELS)
      if (e) {
        const record: Record<string, number[]> = JSON.parse(e)
        const arr = PRODUCTS.map((p) => (record[p.id] ? new Float32Array(record[p.id]) : null))
        setEmbeds(arr)
        setStatusCatalog('ready')
      }
      if (l) {
        const record: Record<string, string[]> = JSON.parse(l)
        const arr = PRODUCTS.map((p) => record[p.id] ?? [])
        setLabels(arr)
      }
    } catch {}

    (async () => {
      try {
        const [eRes, lRes] = await Promise.all([
          fetch(REMOTE_EMBEDS_URL, { cache: 'force-cache' }),
          fetch(REMOTE_LABELS_URL, { cache: 'force-cache' }).catch(() => null),
        ])

        if (eRes?.ok) {
          const record = (await eRes.json()) as Record<string, number[]>
          const arr = PRODUCTS.map(p => (record[p.id] ? new Float32Array(record[p.id]) : null))
          setEmbeds(arr)
          setStatusCatalog('ready')
          localStorage.setItem(CACHE_EMBEDS, JSON.stringify(record))
        }
        if (lRes?.ok) {
          const record = (await lRes.json()) as Record<string, string[]>
          const arr = PRODUCTS.map(p => record[p.id] ?? [])
          setLabels(arr)
          localStorage.setItem(CACHE_LABELS, JSON.stringify(record))
        }
      } catch {}
    })()
  }, [])

  async function computeCatalogEmbeddings() {
    if (statusCatalog === 'processing') return
    setStatusCatalog('processing')

    const out = [...embeds]
    const outLabels = [...labels]

    const cachedEmb: Record<string, number[]> = (() => {
      try { return JSON.parse(localStorage.getItem(CACHE_EMBEDS) || '{}') } catch { return {} }
    })()
    const cachedLab: Record<string, string[]> = (() => {
      try { return JSON.parse(localStorage.getItem(CACHE_LABELS) || '{}') } catch { return {} }
    })()

    const missing = PRODUCTS.map((p, i) => ({ p, i })).filter(({ i }) => !out[i])
    const already = PRODUCTS.length - missing.length
    setProgress(already / PRODUCTS.length)

    if (missing.length === 0) {
      setStatusCatalog('ready')
      return
    }

    const limit = pLimit(
      fastMode
        ? Math.min(6, Math.max(3, Math.floor((((navigator as any)?.hardwareConcurrency) ?? 6) / 2)))
        : EMBED_CONCURRENCY
    )

    let done = 0

    const tasks = missing.map(({ p, i }) =>
      limit(async () => {
        try {
          const img = await loadCatalogImage(p.image)
          let emb: Float32Array
          let classes: string[] = []

          if (fastMode) {
            const resized = to224(img)
            emb = await imageToEmbedding(resized as any)
            try {
              const preds = await classifyImage(resized as any, 3)
              classes = preds.map(pp => pp.className.toLowerCase())
            } catch {}
          } else {
            const region = await detectAndCrop(img, ['backpack', 'handbag', 'suitcase', 'laptop'])
            const resized = to224(region as any)
            emb = await robustEmbed(resized as any)
            const preds = await classifyImage(resized as any, 3)
            classes = preds.map(pp => pp.className.toLowerCase())
          }

          out[i] = emb
          outLabels[i] = classes

          cachedEmb[p.id] = Array.from(emb)
          if (classes.length) cachedLab[p.id] = classes
          localStorage.setItem(CACHE_EMBEDS, JSON.stringify(cachedEmb))
          localStorage.setItem(CACHE_LABELS, JSON.stringify(cachedLab))
        } catch {
          out[i] = null
          outLabels[i] = []
        } finally {
          done++
          setProgress((already + done) / PRODUCTS.length)
          await tick()
        }
      })
    )

    await Promise.all(tasks)

    setEmbeds(out)
    setLabels(outLabels)
    setStatusCatalog('ready')

    if (fastMode && queryEmbed) {
      const k = 64
      const idxs = out
        .map((e, idx) => e ? ({ idx, s: cosineSimilarity(queryEmbed, e) }) : null)
        .filter(Boolean) as { idx: number; s: number }[]
      idxs.sort((a, b) => b.s - a.s)
      const top = idxs.slice(0, Math.min(k, idxs.length))

      const refine = pLimit(3)
      await Promise.all(top.map(({ idx }) => refine(async () => {
        const p = PRODUCTS[idx]
        try {
          const img = await loadCatalogImage(p.image)
          const region = await detectAndCrop(img, ['backpack', 'handbag', 'suitcase', 'laptop'])
          const resized = to224(region as any)
          const clipEmb = await robustEmbed(resized as any)
          const preds = await classifyImage(resized as any, 3)

          out[idx] = clipEmb
          outLabels[idx] = preds.map(pp => pp.className.toLowerCase())

          cachedEmb[p.id] = Array.from(clipEmb)
          cachedLab[p.id] = outLabels[idx]
          localStorage.setItem(CACHE_EMBEDS, JSON.stringify(cachedEmb))
          localStorage.setItem(CACHE_LABELS, JSON.stringify(cachedLab))

          setEmbeds([...out])
          setLabels([...outLabels])
        } catch {}
      })))
    }
  }

  function downloadJSON(filename: string, data: any) {
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = filename
    a.click()
  }

  function exportEmbeds() {
    try {
      const raw = localStorage.getItem(CACHE_EMBEDS) || '{}'
      downloadJSON('embeds.v1.json', JSON.parse(raw))
    } catch {
      downloadJSON('embeds.v1.json', {})
    }
  }

  function exportLabels() {
    try {
      const raw = localStorage.getItem(CACHE_LABELS) || '{}'
      downloadJSON('labels.v1.json', JSON.parse(raw))
    } catch {
      downloadJSON('labels.v1.json', {})
    }
  }

  function clearCache() {
    try { localStorage.removeItem(CACHE_EMBEDS) } catch {}
    try { localStorage.removeItem(CACHE_LABELS) } catch {}
    setEmbeds(Array(PRODUCTS.length).fill(null))
    setLabels(Array(PRODUCTS.length).fill([]))
    setStatusCatalog('idle')
    setProgress(0)
  }

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
      const resolved = resolveImageUrl(url.trim())
      const normalized = prefer256(resolved)
      const blobUrl = await fetchToObjectURL(normalized)
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

  useEffect(() => {
    async function run() {
      if (!queryImgLoaded || !imgRef.current) return
      setStatusQuery('processing')
      try {
        const region = await detectAndCrop(imgRef.current, ['backpack', 'handbag', 'suitcase', 'laptop'])
        const resized = to224(region as any)
        const fastEmb = await imageToEmbedding(resized as any)
        setQueryEmbed(fastEmb)
        const qpred = await classifyImage(resized as any, 3)
        setQueryLabels(qpred.map((p) => p.className.toLowerCase()))
        setStatusQuery('ready')
        robustEmbed(resized as any).then(setQueryEmbed).catch(() => {})
      } catch {
        setStatusQuery('error')
        setError('Failed to process the image. Try another URL or upload a file.')
      }
    }
    run()
  }, [queryImgLoaded])

  useEffect(() => {
    if (queryEmbed && !hasEmbeds) {
      computeCatalogEmbeddings()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryEmbed])

  useEffect(
    () => () => {
      if (lastBlobURL.current) URL.revokeObjectURL(lastBlobURL.current)
    },
    []
  )

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

  function relaxFilters() {
    setMinScore(0.25)
    setTopK(16)
    setCategory('All')
    setPreferQueryClass(true)
    setOnlySameClass(false)
  }

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
        {statusCatalog === 'error' && 'Catalog failed'}
      </div>
    </div>
  )

  return (
    <>
      <Reveal>
        <Uploader onFile={onFile} onUrl={onUrl} />
      </Reveal>

      {displayQueryUrl && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mt-5 mb-6">
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
                className="w-full h-auto max-h-96 object-contain rounded-2xl bg-black/30"
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
                  disabled={statusCatalog === 'processing'}
                  aria-disabled={statusCatalog === 'processing'}
                  title={statusCatalog === 'processing' ? 'Working…' : 'Recompute catalog embeddings'}
                >
                  Compute Catalog Embeddings
                </button>
                <button className="btn-glass" onClick={exportEmbeds}>Export vectors</button>
                <button className="btn-glass" onClick={exportLabels}>Export labels</button>
                <button className="btn-glass" onClick={clearCache}>Clear cache</button>
              </div>

              {error && <div className="text-sm text-rose-200">{error}</div>}
            </div>
          </Reveal>
        </div>
      )}

      {/* Controls */}
      <Reveal delay={0.12}>
        <div className="glass px-4 py-3 mt-4 mb-8 flex flex-nowrap gap-x-6 gap-y-3 items-center overflow-x-auto no-scrollbar">
          <div className="flex items-center gap-2">
            <label className="text-sm text-white/85">Min similarity</label>
            <input
              type="range"
              min={0}
              max={1}
              step={0.01}
              value={minScore}
              onChange={(e) => setMinScore(parseFloat(e.target.value))}
              className="w-32 sm:w-40"
            />
            <div className="text-sm tabular-nums w-10">{(minScore * 100).toFixed(0)}%</div>
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
              className="w-28 sm:w-36"
            />
            <div className="text-sm tabular-nums w-8">{topK}</div>
          </div>

          <div className="flex items-center gap-2">
            <label className="text-sm text-white/85 whitespace-nowrap">Category</label>
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

          <label className="flex items-center gap-2 whitespace-nowrap">
            <input
              type="checkbox"
              className="switch"
              checked={preferQueryClass}
              onChange={(e) => setPreferQueryClass(e.target.checked)}
            />
            <span className="text-sm text-white/85">Prefer same class</span>
          </label>

          <label className="flex items-center gap-2 whitespace-nowrap">
            <input
              type="checkbox"
              className="switch"
              checked={onlySameClass}
              onChange={(e) => setOnlySameClass(e.target.checked)}
            />
            <span className="text-sm text-white/85">Only same class</span>
          </label>

          <label className="flex items-center gap-2 whitespace-nowrap">
            <input
              type="checkbox"
              className="switch"
              checked={fastMode}
              onChange={(e) => setFastMode(e.target.checked)}
            />
            <span className="text-sm text-white/85">Fast mode</span>
          </label>

          <div className="ml-auto flex-shrink-0">
            <button onClick={relaxFilters} className="btn-glass">Reset</button>
          </div>
        </div>
      </Reveal>

      {/* Results */}
      <section>
        <Reveal delay={0.15}>
          <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-5 md:gap-6">
            {scored.map((item, visibleIndex) => (
              <Reveal key={`rev-${item.id}`} delay={Math.min(visibleIndex, 10) * 0.05}>
                <ProductCard
                  item={item}
                  score={item.score}
                  label={`Picture ${visibleIndex + 1}`}
                  onSelect={() => {
                    document.title = `Picture ${visibleIndex + 1}`
                  }}
                />
              </Reveal>
            ))}
          </div>
        </Reveal>

        {!queryEmbed && (
          <div className="text-center text-white/70 mt-8 text-sm px-3">
            Upload an image or paste a URL to see similar items.
          </div>
        )}

        {queryEmbed && statusCatalog !== 'ready' && (
          <div className="text-center text-white/70 mt-8 text-sm px-3">
            Computing catalog embeddings… this runs once and then results will stream in.
          </div>
        )}

        {queryEmbed && statusCatalog === 'ready' && (scored as any[]).length === 0 && (
          <div className="text-center text-white/70 mt-8 text-sm px-3">
            No matches ≥ {(minScore * 100).toFixed(0)}%. Lower <b>Min similarity</b>, increase <b>Top K</b>, or change filters.
          </div>
        )}
      </section>
    </>
  )
}

/* --------------------
 * Status badge
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
 * ABOUT & PRICING (unchanged)
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
  const [openContact, setOpenContact] = React.useState(false)
  const [openMenu, setOpenMenu] = React.useState(false)

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenContact(false)
        setOpenMenu(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const MenuOverlay = ({ onClose }: { onClose: () => void }) => (
    <>
      <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[1300]" onClick={onClose} />
      <div className="fixed inset-0 z-[1400] flex items-end sm:items-center justify-center p-4">
        <div className="w-full sm:w-[min(95vw,560px)] max-w-lg rounded-t-2xl sm:rounded-2xl bg-slate-900/85 backdrop-blur-xl ring-1 ring-white/15 shadow-2xl p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-xl font-semibold">Menu</h3>
            <button onClick={onClose} className="btn-glass px-3 py-1.5">Close</button>
          </div>
          <div className="grid gap-3">
            <NavLink to="/" onClick={onClose} className="px-3 py-3 rounded-xl text-white hover:bg-white/10">Home</NavLink>
            <NavLink to="/about" onClick={onClose} className="px-3 py-3 rounded-xl text-white hover:bg-white/10">About</NavLink>
            <NavLink to="/pricing" onClick={onClose} className="px-3 py-3 rounded-xl text-white hover:bg-white/10">Pricing</NavLink>
            <hr className="border-white/10 my-2" />
            <a
              href="https://www.linkedin.com/in/starkbbk"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 px-3 py-3 rounded-xl text-white hover:bg-white/10"
            >
              <span className="shrink-0 grid place-items-center w-10 h-10 rounded-xl bg-white/10 ring-1 ring-white/15">
                <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#0A66C2" d="M22.225 0H1.771C.792 0 0 .771 0 1.723v20.554C0 23.229.792 24 1.771 24h20.451C23.2 24 24 23.229 24 22.277V1.723C24 .771 23.2 0 22.225 0zM7.119 20.452H3.558V9h3.561v11.452zM5.338 7.433a2.066 2.066 0 1 1 0-4.133 2.066 2.066 0 0 1 0 4.133zM20.447 20.452h-3.554v-5.569c0-1.328-.024-3.036-1.852-3.036-1.853 0-2.136 1.447-2.136 2.944v5.661H9.352V9h3.414v1.561h.047c.476-.9 1.637-1.852 3.368-1.852 3.6 0 4.266 2.37 4.266 5.456v6.287z"/>
                </svg>
              </span>
              <span className="text-base">LinkedIn</span>
            </a>
            <a
              href="https://github.com/starkbbk"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 px-3 py-3 rounded-xl text-white hover:bg-white/10"
            >
              <span className="shrink-0 grid place-items-center w-10 h-10 rounded-xl bg-white/10 ring-1 ring-white/15">
                <img src="https://cdn.simpleicons.org/github/ffffff" width="22" height="22" alt="" />
              </span>
              <span className="text-base">GitHub</span>
            </a>
          </div>
        </div>
      </div>
    </>
  )

  const ContactOverlay = ({ onClose }: { onClose: () => void }) => (
    <>
      <div className="fixed inset-0 bg-black/70 backdrop-blur-md z-[1300]" onClick={onClose} />
      <div className="fixed inset-0 z-[1400] flex items-center justify-center p-4">
        <div className="w-[min(95vw,560px)] rounded-2xl bg-slate-900/85 backdrop-blur-xl ring-1 ring-white/15 shadow-2xl p-6">
          <h3 className="text-2xl font-semibold mb-4">Contact</h3>
          <div className="grid gap-3">
            <a
              href="https://www.linkedin.com/in/starkbbk"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 px-3 py-3 rounded-xl text-white hover:bg-white/10 transition-colors"
            >
              <span aria-hidden className="shrink-0 grid place-items-center w-10 h-10 rounded-xl bg-white/10 ring-1 ring-white/15">
                <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
                  <path fill="#0A66C2" d="M22.225 0H1.771C.792 0 0 .771 0 1.723v20.554C0 23.229.792 24 1.771 24h20.451C23.2 24 24 23.229 24 22.277V1.723C24 .771 23.2 0 22.225 0zM7.119 20.452H3.558V9h3.561v11.452zM5.338 7.433a2.066 2.066 0 1 1 0-4.133 2.066 2.066 0 0 1 0 4.133zM20.447 20.452h-3.554v-5.569c0-1.328-.024-3.036-1.852-3.036-1.853 0-2.136 1.447-2.136 2.944v5.661H9.352V9h3.414v1.561h.047c.476-.9 1.637-1.852 3.368-1.852 3.6 0 4.266 2.37 4.266 5.456v6.287z"/>
                </svg>
              </span>
              <span className="text-base">LinkedIn</span>
            </a>
            <a
              href="https://github.com/starkbbk"
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-3 px-3 py-3 rounded-xl text-white hover:bg-white/10 transition-colors"
            >
              <span aria-hidden className="shrink-0 grid place-items-center w-10 h-10 rounded-xl bg-white/10 ring-1 ring-white/15">
                <img src="https://cdn.simpleicons.org/github/ffffff" width="22" height="22" alt="" />
              </span>
              <span className="text-base">GitHub</span>
            </a>
          </div>
          <div className="flex justify-end mt-5">
            <button className="btn-glass text-base px-4 py-2" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </>
  )

  return (
    <header className="sticky top-0 z-[1200] px-4 sm:px-6 lg:px-8 py-3">
      <div className="glass-strong px-3 py-2 rounded-2xl flex items-center justify-between">
        <Link to="/" className="text-lg md:text-xl font-semibold tracking-tight">
          Visual Product Matcher
        </Link>

        {/* Desktop nav */}
        <nav className="hidden md:flex items-center gap-2">
          <div className="flex items-center gap-2">
            <NavLink to="/" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
              Home
            </NavLink>
            <NavLink to="/about" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
              About
            </NavLink>
            <NavLink to="/pricing" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
              Pricing
            </NavLink>
          </div>
          <div className="relative">
            <button onClick={() => setOpenContact(true)} className={`${linkBase} ${linkIdle}`}>Contact ▾</button>
          </div>
        </nav>

        {/* Mobile hamburger */}
        <div className="md:hidden">
          <button
            aria-label="Open menu"
            onClick={() => setOpenMenu(true)}
            className="px-3 py-2 rounded-xl text-white/85 hover:text-white hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
          >
            <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor">
              <path d="M3 6h18v2H3V6zm0 5h18v2H3v-2zm0 5h18v2H3v-2z" />
            </svg>
          </button>
        </div>
      </div>

      {openContact && createPortal(<ContactOverlay onClose={() => setOpenContact(false)} />, document.body)}
      {openMenu && createPortal(<MenuOverlay onClose={() => setOpenMenu(false)} />, document.body)}
    </header>
  )
}

function StarIcon(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" className={`w-4 h-4 ${props.className ?? ''}`} fill="currentColor" aria-hidden="true">
      <path d="M12 .587l3.668 7.431 8.2 1.192-5.934 5.785 1.401 8.167L12 18.896l-7.335 3.866 1.401-8.167L.132 9.21l8.2-1.192L12 .587z" />
    </svg>
  )
}

function StarRating({ value = 5 }: { value?: number }) {
  const clamped = Math.max(0, Math.min(5, value))
  const pct = (clamped / 5) * 100
  const stars = Array.from({ length: 5 })

  return (
    <div className="relative inline-flex items-center" aria-label={`${clamped.toFixed(1)} out of 5 stars`}>
      <div className="flex gap-1 text-white/25">
        {stars.map((_, i) => <StarIcon key={`bg-${i}`} />)}
      </div>
      <div className="pointer-events-none absolute left-0 top-0 h-full overflow-hidden" style={{ width: `${pct}%` }}>
        <div className="flex gap-1 text-amber-400">
          {stars.map((_, i) => <StarIcon key={`fg-${i}`} />)}
        </div>
      </div>
      <span className="ml-2 text-xs text-white/70 tabular-nums">{clamped.toFixed(1)}</span>
    </div>
  )
}

function initials(name: string) {
  const parts = name.trim().split(/\s+/)
  const a = parts[0]?.[0] ?? ''
  const b = parts[1]?.[0] ?? ''
  return (a + b).toUpperCase()
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
        <section className="grid lg:grid-cols-2 gap-6">
          <Reveal>
            <div className="glass p-6 rounded-2xl">
              <h3 className="text-xl font-semibold mb-3">What this app does</h3>
              <ul className="space-y-2 text-white/85 text-sm leading-relaxed">
                <li>• Finds visually similar items from a local catalog of images (1k+ demo set, expandable to 100k with precomputed vectors).</li>
                <li>• Accepts uploads or direct image URLs; the main object is auto-detected and neatly cropped before matching.</li>
                <li>• Ranks results by cosine similarity, with an optional class-match boost for extra precision.</li>
                <li>• Fine-tune results by adjusting minimum similarity, Top-K, category filter, and class-match preferences.</li>
              </ul>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="glass p-6 rounded-2xl">
              <h3 className="text-xl font-semibold mb-3">Why it’s fast &amp; private</h3>
              <ul className="space-y-2 text-white/85 text-sm leading-relaxed">
                <li>• 100% client-side ML: CLIP for embeddings with MobileNet + COCO-SSD fallback — works offline after model load.</li>
                <li>• Your images never leave the browser; no server or login. Optional CORS proxy is used only for remote URLs.</li>
                <li>• Vector math is SIMD-accelerated where available; catalog vectors can be precomputed and cached for instant search.</li>
              </ul>
            </div>
          </Reveal>
        </section>

        <section className="grid lg:grid-cols-2 gap-6 mt-6 md:mt-8">
          <Reveal delay={0.05}>
            <div className="glass p-6 rounded-2xl">
              <h3 className="text-xl font-semibold mb-3">How it works</h3>
              <ol className="list-decimal list-inside space-y-2 text-white/85 text-sm leading-relaxed">
                <li>Detect &amp; crop the salient object in your query image.</li>
                <li>Embed the crop with CLIP (or MobileNet fallback).</li>
                <li>Compute cosine similarity against catalog vectors and sort Top-K.</li>
              </ol>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="glass p-6 rounded-2xl">
              <h3 className="text-xl font-semibold mb-3">Use cases</h3>
              <ul className="space-y-2 text-white/85 text-sm leading-relaxed">
                <li>• E-commerce visual search &amp; product deduplication.</li>
                <li>• Asset management for design teams and photographers.</li>
                <li>• “Find similar” for inspiration boards or mood-matching.</li>
              </ul>
            </div>
          </Reveal>
        </section>

        <Reveal>
          <section className="mt-6 md:mt-8 glass p-6 rounded-2xl">
            <h3 className="text-xl font-semibold mb-4">What users say</h3>
            <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {reviews.map((r, i) => (
                <Reveal key={r.name} delay={i * 0.06}>
                  <article className="rounded-2xl bg-white/5 ring-1 ring-white/10 p-4">
                    <div className="flex items-center gap-3 mb-2">
                      <div
                        className="w-10 h-10 rounded-full grid place-items-center text-sm font-semibold text-white
                                   bg-gradient-to-br from-sky-400/70 to-violet-500/70 ring-1 ring-white/20"
                        aria-hidden="true"
                      >
                        {initials(r.name)}
                      </div>
                      <div>
                        <div className="font-medium">{r.name}</div>
                        <div className="text-xs text-white/70">{r.role}</div>
                      </div>
                    </div>
                    <StarRating value={r.rating} />
                    <p className="mt-2 text-sm text-white/85 leading-relaxed">{r.text}</p>
                  </article>
                </Reveal>
              ))}
            </div>
          </section>
        </Reveal>

        <p className="text-center text-xs text-white/70 mt-8 px-3">
          Built with React, Vite &amp; Tailwind. Similarity: CLIP (transformers.js) with MobileNet fallback + COCO-SSD. Catalog via precomputed embeddings or local compute.
        </p>
      </div>
    </footer>
  )
}

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

function AppShell() {
  const location = useLocation()
  const isMobile = useIsMobile()

  useEffect(() => {
    warmModelsOnce()
  }, [])

  return (
    <div className="min-h-screen bg-aurora text-slate-100">
      <Snowfall enabled density={isMobile ? 0.4 : 0.8} zIndex={1} />
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[2000] bg-white/90 text-slate-900 px-3 py-2 rounded-md">Skip to content</a>
      <Navbar />
      <main id="main" className="relative z-[30] max-w-7xl mx-auto px-3 sm:px-6 lg:px-8 py-6 md:py-8 flex flex-col gap-6">
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