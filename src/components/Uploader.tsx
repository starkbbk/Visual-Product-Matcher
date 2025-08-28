import React, { useState } from 'react'

export default function Uploader({
  onFile,
  onUrl,
}: {
  onFile: (file: File) => void
  onUrl: (url: string) => void
}) {
  const [url, setUrl] = useState('')

  return (
    <div className="glass-strong p-4 md:p-5 flex flex-col md:flex-row gap-3 items-stretch md:items-center card-hover">
      <label className="flex items-center gap-3 grow">
        <input
          type="file"
          accept="image/*"
          className="file:mr-3 file:btn-glass file:rounded-xl file:border-0 file:cursor-pointer
                     file:shadow-none file:text-sm file:px-4 file:py-2 text-slate-200"
          onChange={(e) => {
            const f = e.target.files?.[0]
            if (f) onFile(f)
          }}
        />
      </label>

      <div className="flex gap-2 grow">
        <input
          className="glass w-full px-3 py-2 rounded-xl placeholder:text-slate-300 text-slate-100
                     focus:outline-none focus:ring-2 focus:ring-white/40"
          placeholder="Paste image URL (https://...)"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && url.trim() && onUrl(url.trim())}
        />
        <button
          className="btn-glass"
          onClick={() => url.trim() && onUrl(url.trim())}
          disabled={!url.trim()}
        >
          Use URL
        </button>
      </div>
    </div>
  )
}