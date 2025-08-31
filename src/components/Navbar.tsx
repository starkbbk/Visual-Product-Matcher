// src/components/Navbar.tsx
import React, { useState } from 'react'
import { NavLink, useNavigate } from 'react-router-dom'

const linkBase =
  'px-3 py-2 rounded-xl text-sm md:text-[15px] transition-colors'
const linkActive = 'text-white bg-white/15'
const linkIdle = 'text-white/85 hover:text-white hover:bg-white/10'

export default function Navbar() {
  const [open, setOpen] = useState(false)
  const nav = useNavigate()

  const Item = ({ to, children }: { to: string; children: React.ReactNode }) => (
    <NavLink
      to={to}
      className={({ isActive }) =>
        `${linkBase} ${isActive ? linkActive : linkIdle}`
      }
      onClick={() => setOpen(false)}
    >
      {children}
    </NavLink>
  )

  return (
    <header className="sticky top-0 z-40 px-4 md:px-6 py-3">
      <div className="glass-strong px-4 py-3 rounded-2xl flex items-center justify-between">
        <button
          className="text-lg md:text-xl font-semibold tracking-tight"
          onClick={() => nav('/')}
          aria-label="Visual Product Matcher"
        >
          Visual Product Matcher
        </button>

        {/* Desktop */}
        <nav className="hidden md:flex items-center gap-2">
          <Item to="/">Home</Item>
          <Item to="/about">About</Item>
          <Item to="/pricing">Pricing</Item>

          {/* “Extra options” that point to the right pages/anchors */}
          <NavLink to="/pricing#subscribe" className={`${linkBase} ${linkIdle}`}>
            Subscribe
          </NavLink>
          <NavLink to="/pricing#pro" className={`${linkBase} ${linkIdle}`}>
            Buy Pro
          </NavLink>
          <NavLink to="/about#contact" className={`${linkBase} ${linkIdle}`}>
            Contact
          </NavLink>
        </nav>

        {/* Mobile */}
        <button
          className="md:hidden glass px-3 py-2 rounded-xl"
          onClick={() => setOpen(!open)}
          aria-label="Toggle menu"
        >
          ☰
        </button>
      </div>

      {open && (
        <div className="md:hidden mt-2 glass-strong px-3 py-3 rounded-2xl flex flex-col gap-2">
          <Item to="/">Home</Item>
          <Item to="/about">About</Item>
          <Item to="/pricing">Pricing</Item>
          <NavLink to="/pricing#subscribe" className={`${linkBase} ${linkIdle}`} onClick={() => setOpen(false)}>
            Subscribe
          </NavLink>
          <NavLink to="/pricing#pro" className={`${linkBase} ${linkIdle}`} onClick={() => setOpen(false)}>
            Buy Pro
          </NavLink>
          <NavLink to="/about#contact" className={`${linkBase} ${linkIdle}`} onClick={() => setOpen(false)}>
            Contact
          </NavLink>
        </div>
      )}
    </header>
  )
}