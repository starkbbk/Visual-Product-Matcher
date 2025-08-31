import React from "react";
import { Product } from "../data/products";

type Props = {
  item: Product;
  score: number;
  label: string;
  onSelect?: () => void;
};

export default function ProductCard({ item, score, label, onSelect }: Props) {
  const pct = Math.max(0, Math.min(1, score));

  // derive a number from id like "shoes-19" or from a title that ends with digits
  const numFromId = /(\d+)$/.exec(item.id || "")?.[1];
  const numFromTitle = /(\d+)$/.exec(item.title || "")?.[1];
  const num = numFromId ?? numFromTitle ?? "";
  const displayTitle = num ? `Image ${num}` : "Image";

  return (
    <button
      className="group relative w-full overflow-hidden rounded-2xl ring-1 ring-white/10 bg-white/[0.06] hover:bg-white/[0.09] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
      aria-label={label}
      onClick={onSelect}
    >
      <div className="aspect-[4/3] w-full overflow-hidden bg-black/30">
        <img
          src={item.image}
          alt={displayTitle}
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).src =
              `https://picsum.photos/seed/${encodeURIComponent(item.id)}/420/300`;
          }}
          className="h-full w-full object-cover"
        />
      </div>

      <div className="p-3 text-left">
        <div className="text-sm font-medium line-clamp-2">{displayTitle}</div>
        <div className="mt-1 text-xs text-white/70">{item.category}</div>

        <div className="mt-2 h-1.5 w-full rounded-full bg-white/10 overflow-hidden" aria-hidden="true">
          <div className="h-full w-0 rounded-full bg-white/80" style={{ width: `${(pct * 100).toFixed(0)}%` }} />
        </div>
        <div className="mt-1 text-[11px] text-white/70 tabular-nums">
          Similarity: {(pct * 100).toFixed(0)}%
        </div>
      </div>
    </button>
  );
}