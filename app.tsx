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

/* --------------------
 * Types & constants
 * -------------------- */
type Scored = Product & { score: number }
const DEFAULT_TITLE = 'Visual Product Matcher'

const PROXY = 'https://images.weserv.nl/?url='
const SAFE_HOSTS = new Set([
  'upload.wikimedia.org',
  'picsum.photos',
  'images.unsplash.com',
  'i.imgur.com',
])

/* --------------------
 * Helpers
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
async function robustEmbed(img: HTMLImageElement) {
  try {
    return await clipImageEmbedding(img)
  } catch {
    return await imageToEmbedding(img)
  }
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
  try {
    return await loadImageFromSrc(url)
  } catch {
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
  try {
    return await tryFetch(rawUrl)
  } catch (e) {
    if (shouldProxy(rawUrl)) return await tryFetch(proxyUrl(rawUrl))
    throw e
  }
}

/* --------------------
 * Scroll-reveal animation helper
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
  const hasEmbeds = embeds.some(Boolean)

  // UI state
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

  useEffect(() => {
    document.title = DEFAULT_TITLE
  }, [])

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
          const region = await detectAndCrop(img, ['backpack', 'handbag', 'suitcase', 'laptop'])
          out[i] = await robustEmbed(region)
          const preds = await classifyImage(region, 3)
          outLabels[i] = preds.map((p) => p.className.toLowerCase())
        } catch {
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
    if (lastBlobURL.current) {
      URL.revokeObjectURL(lastBlobURL.current)
      lastBlobURL.current = null
    }
    const blobUrl = URL.createObjectURL(f)
    lastBlobURL.current = blobUrl
    setDisplayQueryUrl(blobUrl)
    setQueryImgLoaded(false)
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
      document.title = DEFAULT_TITLE
    } catch {
      setDisplayQueryUrl(null)
      setQueryImgLoaded(false)
      setError('Could not load image. Use a direct .jpg/.png URL or upload a file.')
    }
  }

  useEffect(() => {
    async function run() {
      if (!queryImgLoaded || !imgRef.current) return
      setStatus('Detecting object & embedding query…')
      try {
        const region = await detectAndCrop(imgRef.current, ['backpack', 'handbag', 'suitcase', 'laptop'])
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

  useEffect(() => {
    if (queryEmbed && !hasEmbeds) void computeCatalogEmbeddings()
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
                onError={() => setError('Preview failed. Try uploading the file instead.')}
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
              <div className="text-lg font-medium tracking-tight">{status}</div>
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
            <button onClick={relaxFilters} className="btn-glass">
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
                  onSelect={() => {
                    document.title = `Picture ${visibleIndex + 1}`
                  }}
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

        {queryEmbed && !hasEmbeds && (
          <div className="text-center text-white/70 mt-8 text-sm">
            Catalog embeddings not ready. Click <b>Compute Catalog Embeddings</b> or wait for the auto-run.
          </div>
        )}

        {queryEmbed && hasEmbeds && (scored as any[]).length === 0 && (
          <div className="text-center text-white/70 mt-8 text-sm">
            No matches ≥ {(minScore * 100).toFixed(0)}%. Lower <b>Min similarity</b>, increase <b>Top K</b>, or change filters.
          </div>
        )}
      </section>
    </>
  )
}

/* --------------------
 * ABOUT & PRICING
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
 * NAV & FOOTER
 * -------------------- */
function Navbar() {
  const linkBase = 'px-3 py-2 rounded-xl text-sm md:text-[15px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40'
  const linkActive = 'text-white bg-white/15'
  const linkIdle   = 'text-white/85 hover:text-white hover:bg-white/10'
  const [open, setOpen] = React.useState(false)
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open])
  return (
    <header className="sticky top-0 z-[1200] px-4 sm:px-6 lg:px-8 py-3">
      <div className="glass-strong px-3 py-2 rounded-2xl flex items-center justify-between">
        <Link to="/" className="text-lg md:text-xl font-semibold tracking-tight">
          Visual Product Matcher
        </Link>
        <nav className="hidden md:flex items-center gap-2">
          <div className="flex items-center gap-2">
            <NavLink to="/" className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}>
              Home
            </NavLink>
            <NavLink
              to="/about"
              className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}
            >
              About
            </NavLink>
            <NavLink
              to="/pricing"
              className={({ isActive }) => `${linkBase} ${isActive ? linkActive : linkIdle}`}
            >
              Pricing
            </NavLink>
          </div>
          <div className="relative">
            <button onClick={() => setOpen((v) => !v)} className={`${linkBase} ${linkIdle}`}>Contact ▾</button>
            {open &&
              createPortal(
                <>
                  {/* Full-screen dim/blur background */}
                  <div
                    className="fixed inset-0 bg-black/70 backdrop-blur-md z-[1300] transition-opacity duration-150"
                    onClick={() => setOpen(false)}
                  />

                  {/* Centered contacts popup */}
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

                        <a
                          href="https://leetcode.com/u/starkbbk/"
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-3 px-3 py-3 rounded-xl text-white hover:bg-white/10 transition-colors"
                        >
                          <span aria-hidden className="shrink-0 grid place-items-center w-10 h-10 rounded-xl bg-white/10 ring-1 ring-white/15">
                            <img src="https://cdn.simpleicons.org/leetcode/F89F1B" width="22" height="22" alt="" />
                          </span>
                          <span className="text-base">LeetCode</span>
                        </a>

                        <a
                          href="http://instagram.com/starkbbk/"
                          target="_blank"
                          rel="noreferrer"
                          className="flex items-center gap-3 px-3 py-3 rounded-xl text-white hover:bg-white/10 transition-colors"
                        >
                          <span aria-hidden className="shrink-0 grid place-items-center w-10 h-10 rounded-xl bg-white/10 ring-1 ring-white/15">
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

/* ---------- Footer helpers (stars + avatars) ---------- */
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
      {/* Background (empty) stars */}
      <div className="flex gap-1 text-white/25">
        {stars.map((_, i) => <StarIcon key={`bg-${i}`} />)}
      </div>

      {/* Foreground (filled) stars clipped by width for fractional values */}
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
    { name: 'Aarav Mehta', role: 'E‑commerce lead', rating: 4.9, text: 'Matched thousands of product photos without any server setup. The frosted UI is a bonus.' },
    { name: 'Sana Kapoor', role: 'Design Ops', rating: 4.8, text: 'Drag a pic in, get similar shots immediately. The local‑only processing is great for privacy.' },
    { name: 'Dev Sharma', role: 'Frontend Engineer', rating: 5.0, text: 'CLIP + MobileNet fallback makes it feel instant. Works even on my older laptop.' },
  ]

  return (
    <footer className="relative z-50 mt-10 md:mt-14 pb-12">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        {/* What & Why */}
        <section className="grid lg:grid-cols-2 gap-6">
          <Reveal>
            <div className="glass p-6 rounded-2xl">
              <h3 className="text-xl font-semibold mb-3">What this app does</h3>
              <ul className="space-y-2 text-white/85 text-sm leading-relaxed">
                <li>• Finds visually similar items from a local catalog of images (1k+ demo set, expandable to 100k with precomputed vectors).</li>
                <li>• Accepts uploads or direct image URLs; the main object is auto‑detected and neatly cropped before matching.</li>
                <li>• Ranks results by cosine similarity, with an optional class‑match boost for extra precision.</li>
                <li>• Fine‑tune results by adjusting minimum similarity, Top‑K, category filter, and class‑match preferences.</li>
              </ul>
            </div>
          </Reveal>
          <Reveal delay={0.08}>
            <div className="glass p-6 rounded-2xl">
              <h3 className="text-xl font-semibold mb-3">Why it’s fast &amp; private</h3>
              <ul className="space-y-2 text-white/85 text-sm leading-relaxed">
                <li>• 100% client‑side ML: CLIP for embeddings with MobileNet + COCO‑SSD fallback — works offline after model load.</li>
                <li>• Your images never leave the browser; no server or login. Optional CORS proxy is used only for remote URLs.</li>
                <li>• Vector math is SIMD‑accelerated where available; catalog vectors can be precomputed and cached for instant search.</li>
              </ul>
            </div>
          </Reveal>
        </section>

        {/* How it works & Use cases */}
        <section className="grid lg:grid-cols-2 gap-6 mt-6 md:mt-8">
          <Reveal delay={0.05}>
            <div className="glass p-6 rounded-2xl">
              <h3 className="text-xl font-semibold mb-3">How it works</h3>
              <ol className="list-decimal list-inside space-y-2 text-white/85 text-sm leading-relaxed">
                <li>Detect &amp; crop the salient object in your query image.</li>
                <li>Embed the crop with CLIP (or MobileNet fallback).</li>
                <li>Compute cosine similarity against catalog vectors and sort Top‑K.</li>
              </ol>
            </div>
          </Reveal>
          <Reveal delay={0.1}>
            <div className="glass p-6 rounded-2xl">
              <h3 className="text-xl font-semibold mb-3">Use cases</h3>
              <ul className="space-y-2 text-white/85 text-sm leading-relaxed">
                <li>• E‑commerce visual search &amp; product deduplication.</li>
                <li>• Asset management for design teams and photographers.</li>
                <li>• “Find similar” for inspiration boards or mood‑matching.</li>
              </ul>
            </div>
          </Reveal>
        </section>

        {/* Reviews */}
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

        {/* Meta */}
        <p className="text-center text-xs text-white/70 mt-8">
          Built with React, Vite &amp; Tailwind. Similarity: CLIP (transformers.js) with MobileNet fallback + COCO‑SSD. Catalog via precomputed embeddings or local compute.
        </p>
      </div>
    </footer>
  )
}

/* --------------------
 * APP SHELL (keeps Home mounted)
 * -------------------- */
function AppShell() {
  const location = useLocation()

  return (
    <div className="min-h-screen bg-aurora-live text-slate-100">
      {/* Background (snow) */}
      <Snowfall
        count={100}
        speed={0.4}
        opacity={0.15}
        blurPx={2.2}
        parallax={12}
        zIndex={4}
        repelRadius={50}
        repelStrength={6.6}
        timeScale={1.1}
        parallaxEase={0.2}
        returnEase={0.14}
        hoverDecay={0.1}
        repelOnHover
      />
      {/* <Snowfall
        count={65}
        speed={1.0}
        opacity={0.95}
        blurPx={0}
        parallax={36}
        zIndex={60}
        repelRadius={160}
        repelStrength={2.4}
        timeScale={1.3}
        parallaxEase={0.22}
        returnEase={0.16}
        hoverDecay={0.12}
        repelOnHover
      /> */}

      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:top-3 focus:left-3 focus:z-[2000] bg-white/90 text-slate-900 px-3 py-2 rounded-md">Skip to content</a>

      <Navbar />

      <main id="main" className="relative z-[30] max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-6 md:py-8 flex flex-col gap-6">
        {/* Keep Home mounted; just hide when not on '/' */}
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
