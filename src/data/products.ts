// src/data/products.ts
export type Product = {
  id: string
  title: string     // <- what the app expects
  category: string
  image: string
}

import raw from './products.v1.json' // your big JSON above

type Raw = { id: string; name: string; category: string; image: string }

export const PRODUCTS: Product[] = (raw as Raw[]).map(r => ({
  id: r.id,
  title: r.name,     // <- map "name" -> "title"
  category: r.category,
  image: r.image,
}))