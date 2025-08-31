// src/lib/unsplash.ts

export async function searchUnsplash(query: string, perPage = 30) {
  const key = import.meta.env.VITE_UNSPLASH_ACCESS_KEY as string
  const app = (import.meta.env.VITE_UNSPLASH_APP_NAME as string) || 'visual-product-matcher'
  if (!key) throw new Error('Missing VITE_UNSPLASH_ACCESS_KEY')

  const url = new URL('https://api.unsplash.com/search/photos')
  url.searchParams.set('query', query)
  url.searchParams.set('per_page', String(perPage))
  url.searchParams.set('orientation', 'squarish')

  const res = await fetch(url.toString(), {
    headers: { Authorization: `Client-ID ${key}` },
  })
  if (!res.ok) throw new Error(`Unsplash ${res.status}`)

  const data = await res.json()

  // Return a compact, app-friendly shape with proper attribution (required by Unsplash)
  return data.results.map((p: any) => ({
    id: p.id,
    image: p.urls.regular as string,
    thumb: p.urls.small as string,
    creditHtml: `Photo by <a href="${p.user.links.html}?utm_source=${app}&utm_medium=referral">${p.user.name}</a> on <a href="https://unsplash.com/?utm_source=${app}&utm_medium=referral">Unsplash</a>`,
  }))
}

/**
 * Convenience helper that mirrors your snippet and returns the raw Unsplash JSON.
 * Useful if you need extra fields not included by `searchUnsplash`.
 */
export async function searchUnsplashRaw(query = 'laptop', perPage = 10) {
  const key = import.meta.env.VITE_UNSPLASH_ACCESS_KEY as string
  if (!key) throw new Error('Missing VITE_UNSPLASH_ACCESS_KEY')

  const res = await fetch(
    `https://api.unsplash.com/search/photos?query=${encodeURIComponent(query)}&per_page=${perPage}`,
    { headers: { Authorization: `Client-ID ${key}` } }
  )

  if (!res.ok) throw new Error(`Unsplash ${res.status}`)
  return res.json()
}