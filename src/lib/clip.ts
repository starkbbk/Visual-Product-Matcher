// src/lib/clip.ts
import { pipeline } from '@xenova/transformers'

// CLIP image embedding via transformers.js
let extractor: any = null

export async function getClipExtractor() {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', 'Xenova/clip-vit-base-patch32', {
      quantized: true, // lighter/faster in browser
    })
  }
  return extractor
}

export async function clipImageEmbedding(img: HTMLImageElement) {
  const ex = await getClipExtractor()
  // Mean-pool to a single vector and normalize
  const output = await ex(img, { pooling: 'mean', normalize: true })
  const data = Float32Array.from(output.data as Float32Array)
  // @ts-ignore optional dispose
  output.dispose?.()
  return data
}