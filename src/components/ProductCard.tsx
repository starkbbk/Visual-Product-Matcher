import React from "react";
import type { Product } from "../data/products";

type Props = {
  item: Product;
  score: number;              // 0..1
  label: string;              // e.g., "Image 12"
  onSelect?: () => void;
};

export default function ProductCard({ item, score, label, onSelect }: Props) {
  const [loaded, setLoaded] = React.useState(false);
  const percent = Math.round(score * 100);

  return (
    <div
      className="
        group relative overflow-hidden rounded-2xl
        bg-white/5 ring-1 ring-white/10
        transition-all duration-300
        hover:ring-indigo-400/60 hover:shadow-[0_0_0_4px_rgba(99,102,241,0.25)]
        hover:shadow-indigo-500/20
        focus-within:ring-indigo-400/60
      "
    >
      {/* score badge */}
      <div className="pointer-events-none absolute right-2 top-2 z-10 rounded-full bg-amber-500 px-2 py-1 text-xs font-semibold text-black/90 shadow">
        {percent}%
      </div>

      {/* image (click → new tab) */}
      <a
        href={item.image}
        onClick={onSelect}
        target="_blank"
        rel="noreferrer"
        className="block"
        aria-label={`Open ${label} in a new tab`}
        title="Open image"
      >
        <div className="relative aspect-[4/3] w-full overflow-hidden bg-black/30">
          {/* skeleton */}
          {!loaded && (
            <div className="absolute inset-0 animate-pulse bg-white/5" />
          )}

          <img
            src={item.image}
            alt={item.title}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onLoad={() => setLoaded(true)}
            onError={(e) => {
              const img = e.currentTarget as HTMLImageElement;
              img.src = `https://picsum.photos/seed/${encodeURIComponent(
                item.id
              )}/800/600`;
              setLoaded(true);
            }}
            className="
              h-full w-full object-cover
              transition-transform duration-500 ease-out
              group-hover:scale-[1.04] active:scale-[1.02]
            "
          />

          {/* subtle gradient overlay on hover */}
          <div
            className="
              pointer-events-none absolute inset-0
              bg-gradient-to-t from-black/25 via-black/0 to-transparent
              opacity-0 transition-opacity duration-300
              group-hover:opacity-100
            "
          />
        </div>
      </a>

      {/* caption */}
      <div className="flex flex-col gap-1 px-4 pb-3 pt-3">
        <div className="text-[15px] font-medium leading-tight text-white">
          {label}
        </div>
        <div className="text-xs text-white/70">{item.category}</div>

        {/* similarity bar */}
        <div className="mt-2 h-2 w-full rounded-full bg-white/10">
          <div
            className="h-2 rounded-full bg-white/70"
            style={{ width: `${percent}%` }}
            aria-label={`Similarity ${percent}%`}
          />
        </div>
      </div>
    </div>
  );
}