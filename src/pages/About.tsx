// src/pages/About.tsx
import React, { useEffect, useRef } from 'react'
import { useLocation } from 'react-router-dom'

export default function About({ scrollToContact }: { scrollToContact?: boolean }) {
  const contactRef = useRef<HTMLDivElement | null>(null)
  const { hash } = useLocation()

  useEffect(() => {
    if (scrollToContact || hash === '#contact') {
      contactRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }, [scrollToContact, hash])

  return (
    <>
      <section className="glass p-6 rounded-2xl">
        <h2 className="text-2xl font-semibold mb-2">About</h2>
        <p className="text-white/85">
          Visual Product Matcher is a demo that matches your uploaded image to visually similar items
          in a local catalog using client-side ML (CLIP with a MobileNet fallback and COCO-SSD for
          object detection). No server required.
        </p>
      </section>

      <section className="grid md:grid-cols-3 gap-4">
        <div className="glass p-5 rounded-2xl">
          <h3 className="font-semibold mb-1">Client-side Privacy</h3>
          <p className="text-white/85 text-sm">All inference runs locally in your browser.</p>
        </div>
        <div className="glass p-5 rounded-2xl">
          <h3 className="font-semibold mb-1">Fast Results</h3>
          <p className="text-white/85 text-sm">Embeddings are cached in memory for quick searching.</p>
        </div>
        <div className="glass p-5 rounded-2xl">
          <h3 className="font-semibold mb-1">Clean UI</h3>
          <p className="text-white/85 text-sm">Frosted glass theme with subtle rain/snow effects.</p>
        </div>
      </section>

      <section id="contact" ref={contactRef} className="glass p-6 rounded-2xl">
        <h2 className="text-2xl font-semibold mb-3">Contact</h2>
        <form
          className="grid md:grid-cols-2 gap-4"
          onSubmit={(e) => {
            e.preventDefault()
            const fd = new FormData(e.currentTarget)
            console.log('Contact form:', Object.fromEntries(fd as any))
            alert('Thanks! We received your message.')
            e.currentTarget.reset()
          }}
        >
          <input name="name" required placeholder="Your name" className="glass px-3 py-2 rounded-xl" />
          <input name="email" required type="email" placeholder="Your email" className="glass px-3 py-2 rounded-xl" />
          <textarea name="message" required placeholder="Message" rows={4} className="glass px-3 py-2 rounded-xl md:col-span-2" />
          <button className="btn-glass md:col-span-2">Send message</button>
        </form>
      </section>
    </>
  )
}