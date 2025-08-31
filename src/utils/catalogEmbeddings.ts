import pLimit from "p-limit";

export type Product = { id: string; name?: string; title?: string; category?: string; image: string };

// downscale to 256x256 (works in Chrome; falls back for Safari/older)
async function to256(url: string): Promise<Blob> {
  const smallUrl = url.replace(/\/640\/640$/, "/256/256");
  const blob = await fetch(smallUrl, { mode: "cors" }).then(r => r.blob());

  // OffscreenCanvas path
  if ("OffscreenCanvas" in window) {
    const bmp = await createImageBitmap(blob);
    const canvas = new OffscreenCanvas(256, 256);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(bmp, 0, 0, 256, 256);
    return await canvas.convertToBlob({ type: "image/webp", quality: 0.9 }) as Blob;
  }

  // Fallback to normal <canvas>
  const img = await new Promise<HTMLImageElement>((res, rej) => {
    const i = new Image();
    i.crossOrigin = "anonymous";
    i.onload = () => res(i);
    i.onerror = rej;
    i.src = URL.createObjectURL(blob);
  });
  const canvas = document.createElement("canvas");
  canvas.width = 256; canvas.height = 256;
  const ctx = canvas.getContext("2d")!;
  ctx.drawImage(img, 0, 0, 256, 256);
  return await new Promise<Blob>(r => canvas.toBlob(b => r(b!), "image/webp", 0.9));
}

export async function computeCatalogEmbeddings(
  items: Product[],
  embedImage: (b: Blob) => Promise<number[]>,
  opts?: { concurrency?: number; onProgress?: (done: number, total: number) => void; cacheKey?: string }
) {
  const concurrency = opts?.concurrency ?? 8;
  const cacheKey = opts?.cacheKey ?? "vpm:catalogEmbeddings";
  const onProgress = opts?.onProgress ?? (() => {});

  const limit = pLimit(concurrency);
  const cached: Record<string, number[]> = JSON.parse(localStorage.getItem(cacheKey) || "{}");
  const out: Record<string, number[]> = { ...cached };

  const missing = items.filter(p => !out[p.id]);
  let done = 0;
  const tasks = missing.map(p => limit(async () => {
    const img = await to256(p.image);
    out[p.id] = await embedImage(img);
    done++; onProgress(done, missing.length);
  }));

  await Promise.all(tasks);
  localStorage.setItem(cacheKey, JSON.stringify(out));
  return out;
}