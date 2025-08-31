// src/pages/Pricing.tsx
import React from 'react'

export default function Pricing() {
  return (
    <>
      <section className="glass p-6 rounded-2xl" id="subscribe">
        <h2 className="text-2xl font-semibold mb-2">Pricing</h2>
        <p className="text-white/85">
          Start free, upgrade to Pro when you’re ready. All plans run 100% client-side.
        </p>
      </section>

      <section className="grid md:grid-cols-2 gap-4">
        <div className="glass p-6 rounded-2xl">
          <h3 className="text-xl font-semibold">Free</h3>
          <ul className="mt-2 space-y-1 text-sm text-white/85">
            <li>• Upload via file/URL</li>
            <li>• Similarity search on sample catalog</li>
            <li>• Local-only processing</li>
          </ul>
          <a href="#subscribe" className="btn-glass mt-4 inline-block">Get Free</a>
        </div>

        <div className="glass p-6 rounded-2xl" id="pro">
          <h3 className="text-xl font-semibold">Pro</h3>
          <ul className="mt-2 space-y-1 text-sm text-white/85">
            <li>• Larger catalogs</li>
            <li>• Faster CLIP model</li>
            <li>• Priority support</li>
          </ul>
          <a href="#subscribe" className="btn-glass mt-4 inline-block">Buy Pro</a>
        </div>
      </section>
    </>
  )
}