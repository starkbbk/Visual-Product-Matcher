export function cosineSimilarity(a: Float32Array | number[], b: Float32Array | number[]) {
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    const x = +a[i], y = +b[i]
    dot += x * y
    na += x * x
    nb += y * y
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb) || 1
  return dot / denom
}
