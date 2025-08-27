// src/lib/mobilenet.ts
import * as mobilenet from '@tensorflow-models/mobilenet'
import * as cocoSsd from '@tensorflow-models/coco-ssd'
import '@tensorflow/tfjs'

let model: mobilenet.MobileNet | null = null
let detector: cocoSsd.ObjectDetection | null = null

export async function getModel() {
  if (!model) model = await mobilenet.load({ version: 2, alpha: 1.0 })
  return model!
}

export async function getDetector() {
  if (!detector) detector = await cocoSsd.load()
  return detector!
}

/**
 * Detects objects and returns a cropped image focused on the target classes.
 * Falls back to the original image if nothing relevant is found.
 */
export async function detectAndCrop(
  img: HTMLImageElement,
  target: string[] = ['backpack', 'handbag', 'suitcase']
): Promise<HTMLImageElement> {
  try {
    const det = await getDetector()
    const preds = await det.detect(img)
    const match = preds
      .filter(p => target.includes(p.class) && (p.score ?? 0) >= 0.4)
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0]
    if (!match) return img

    // Clamp bbox to image bounds
    const [bx, by, bw, bh] = match.bbox
    const x = Math.max(0, Math.floor(bx))
    const y = Math.max(0, Math.floor(by))
    const w = Math.max(1, Math.min(Math.floor(bw), img.naturalWidth - x))
    const h = Math.max(1, Math.min(Math.floor(bh), img.naturalHeight - y))

    const canvas = document.createElement('canvas')
    canvas.width = w
    canvas.height = h
    const ctx = canvas.getContext('2d')!
    ctx.drawImage(img, x, y, w, h, 0, 0, w, h)

    const out = new Image()
    out.crossOrigin = 'anonymous'
    out.src = canvas.toDataURL('image/jpeg', 0.92)
    await new Promise(res => (out.onload = () => res(null)))
    return out
  } catch {
    return img
  }
}

export async function imageToEmbedding(img: HTMLImageElement) {
  const net = await getModel()
  // 1000-D logits from conv_preds – fine for similarity
  const act = net.infer(img, 'conv_preds') as any
  const data = (await act.data()) as Float32Array
  act.dispose?.()
  return data
}

export async function classifyImage(img: HTMLImageElement, topK = 3) {
  const net = await getModel()
  // @ts-ignore (tfjs types)
  return (await net.classify(img, topK)) as Array<{ className: string; probability: number }>
}