export async function embedRemote(blob: Blob): Promise<Float32Array> {
  const res = await fetch('/api/embed', { method: 'POST', body: blob })
  if (!res.ok) throw new Error('remote embed failed')
  const data = await res.json()
  if (!data || !Array.isArray(data.embedding)) throw new Error('bad embed response')
  return Float32Array.from(data.embedding as number[])
}
