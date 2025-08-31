import React from 'react'

type Props = {
  onFile: (file: File) => void
  onUrl: (url: string) => void | Promise<void>
}

export default function Uploader({ onFile, onUrl }: Props) {
  const fileInputRef = React.useRef<HTMLInputElement>(null)
  const [url, setUrl] = React.useState('')
  const [thumb, setThumb] = React.useState<string | null>(null)
  const [name, setName] = React.useState<string>('')

  // revoke objectURL on unmount / when thumb changes
  React.useEffect(() => {
    return () => {
      if (thumb) URL.revokeObjectURL(thumb)
    }
  }, [thumb])

  function handleChooseFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    if (thumb) URL.revokeObjectURL(thumb)
    const obj = URL.createObjectURL(f)
    setThumb(obj)
    setName(f.name)
    onFile(f)
  }

  function handleDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    e.stopPropagation()
    const f = e.dataTransfer.files?.[0]
    if (f) {
      if (thumb) URL.revokeObjectURL(thumb)
      const obj = URL.createObjectURL(f)
      setThumb(obj)
      setName(f.name)
      onFile(f)
      return
    }
    const text = e.dataTransfer.getData('text/plain')
    if (text) {
      setUrl(text)
      onUrl(text)
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    const items = e.clipboardData?.items
    if (!items) return
    for (const it of items) {
      if (it.kind === 'file') {
        const f = it.getAsFile()
        if (f) {
          if (thumb) URL.revokeObjectURL(thumb)
          const obj = URL.createObjectURL(f)
          setThumb(obj)
          setName(f.name)
          onFile(f)
          return
        }
      }
    }
    const text = e.clipboardData.getData('text')
    if (text) {
      setUrl(text)
      onUrl(text)
    }
  }

  function useUrlNow() {
    const v = url.trim()
    if (!v) return
    onUrl(v)
  }

  return (
    <section
      className="glass p-3 sm:p-4 rounded-2xl"
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      onPaste={handlePaste}
    >
      <div className="flex flex-col gap-3">
        {/* File picker */}
        <div className="flex items-center gap-3 min-w-0">
          <label className="btn-glass cursor-pointer">
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="sr-only"
              onChange={handleChooseFile}
            />
            Choose File
          </label>

          {thumb && (
            <img
              src={thumb}
              alt=""
              className="w-8 h-8 rounded-md object-cover ring-1 ring-white/20"
            />
          )}

          {name && (
            <span
              className="text-xs sm:text-sm text-white/85 truncate max-w-[48vw] sm:max-w-[320px]"
              title={name}
            >
              {name}
            </span>
          )}
        </div>

        {/* URL input */}
        <div className="flex items-center gap-2 min-w-0">
          <input
            type="url"
            inputMode="url"
            placeholder="https://example.com/image.jpg (Google/Bing/Drive links okay)"
            className="glass px-3 py-2 rounded-xl text-slate-100 w-full"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                useUrlNow()
              }
            }}
          />
          <button className="btn-glass shrink-0" onClick={useUrlNow}>
            Use URL
          </button>
        </div>
      </div>
    </section>
  )
}