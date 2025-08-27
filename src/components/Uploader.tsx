import React, { useRef } from 'react'

export default function Uploader({ onFile, onUrl }: { onFile: (f: File)=>void, onUrl:(url:string)=>void }){
  const inputRef = useRef<HTMLInputElement>(null)
  const urlRef = useRef<HTMLInputElement>(null)

  return (
    <div className="card p-4 flex flex-col md:flex-row gap-3 items-center">
      <input ref={inputRef} type="file" accept="image/*"
             onChange={(e)=>{ const f = e.target.files?.[0]; if(f) onFile(f) }}
             className="block w-full text-sm file:mr-4 file:py-2 file:px-4 file:rounded-xl file:border-0 file:text-sm file:font-semibold file:bg-slate-100 file:text-slate-900 hover:file:opacity-80" />
      <div className="text-sm opacity-70">or</div>
      <div className="flex gap-2 w-full">
        <input ref={urlRef} type="url" placeholder="Paste image URL (https://...)"
               className="flex-1 rounded-xl bg-slate-900 border border-slate-800 px-3 py-2 text-sm outline-none"
        />
        <button onClick={()=>{ const v = urlRef.current?.value?.trim(); if(v) onUrl(v) }}
                className="px-3 py-2 rounded-xl bg-slate-100 text-slate-900 text-sm font-semibold hover:opacity-80">
          Use URL
        </button>
      </div>
    </div>
  )
}
