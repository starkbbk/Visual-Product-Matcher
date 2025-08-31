export const runtime = 'edge'
export default async function handler(req: Request): Promise<Response> {
  if (req.method !== 'POST') return new Response('Use POST', { status: 405 })
  const token = process.env.HF_TOKEN
  if (!token) return new Response(JSON.stringify({ error: 'HF_TOKEN not set' }), { status: 500, headers: { 'content-type': 'application/json' } })
  try {
    const blob = await req.blob()
    const upstream = await fetch('https://api-inference.huggingface.co/pipeline/feature-extraction/openai/clip-vit-base-patch32', {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': blob.type || 'application/octet-stream' },
      body: blob
    })
    const text = await upstream.text()
    if (!upstream.ok) return new Response(JSON.stringify({ error: 'hf_upstream', detail: text }), { status: 502, headers: { 'content-type': 'application/json' } })
    let parsed: any
    try { parsed = JSON.parse(text) } catch { return new Response(JSON.stringify({ error: 'bad_json', detail: text.slice(0,400) }), { status: 502, headers: { 'content-type': 'application/json' } }) }
    let vec: number[] = []
    if (Array.isArray(parsed)) {
      if (Array.isArray(parsed[0])) vec = parsed[0] as number[]
      else vec = parsed as number[]
    } else if (parsed && Array.isArray(parsed.embedding)) {
      vec = parsed.embedding as number[]
    }
    if (!vec.length) return new Response(JSON.stringify({ error: 'no_vector' }), { status: 502, headers: { 'content-type': 'application/json' } })
    return new Response(JSON.stringify({ embedding: vec }), { headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })
  } catch (e: any) {
    return new Response(JSON.stringify({ error: 'edge_fail', detail: String(e?.message || e) }), { status: 500, headers: { 'content-type': 'application/json' } })
  }
}
