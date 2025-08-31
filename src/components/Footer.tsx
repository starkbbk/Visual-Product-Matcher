// src/components/Footer.tsx
import React from 'react'
import { Link } from 'react-router-dom'

export default function Footer() {
  return (
    <footer className="relative z-50 text-xs text-white/80 py-10">
      <div className="max-w-6xl mx-auto px-4 md:px-6 flex flex-col md:flex-row gap-6 md:gap-0 md:items-center md:justify-between">
        <div>
          <div className="font-semibold">Visual Product Matcher</div>
          <div className="opacity-80">Client-side ML · CLIP + MobileNet + COCO-SSD</div>
        </div>
        <nav className="flex flex-wrap gap-3">
          <Link to="/" className="hover:underline">Home</Link>
          <Link to="/about" className="hover:underline">About</Link>
          <Link to="/pricing" className="hover:underline">Pricing</Link>
          <Link to="/about#contact" className="hover:underline">Contact</Link>
        </nav>
      </div>
    </footer>
  )
}