import React from 'react'
import type { Product } from '../data/products'

export default function ProductCard({ item, score }: { item: Product, score?: number }) {
  return (
    <div className="card p-3 flex flex-col gap-3">
      <img src={item.image} alt={item.name} className="w-full h-48 object-cover rounded-xl" crossOrigin="anonymous"/>
      <div className="flex justify-between items-center">
        <div>
          <div className="font-semibold">{item.name}</div>
          <div className="text-xs text-slate-300">{item.category}</div>
        </div>
        <div className="text-sm opacity-80">₹{item.price}</div>
      </div>
      {typeof score === 'number' && (
        <div>
          <div className="text-xs mb-1 opacity-80">Similarity: {(score*100).toFixed(1)}%</div>
          <div className="w-full h-2 bg-slate-800 rounded">
            <div className="h-2 bg-slate-100 rounded" style={{width: `${Math.max(0, Math.min(100, score*100)).toFixed(0)}%`}}/>
          </div>
        </div>
      )}
    </div>
  )
}
