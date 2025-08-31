import React from "react";

type Product = {
  id: string;
  name: string;
  category: string;
  image?: string;
  score?: number; // 0..1, optional
};

/** Wrap any remote image URL in a CORS-friendly proxy so hotlink-blocked
 * or redirecting hosts still render in <img>. Keeps data:/blob: as-is. */
function safeImageUrl(u?: string): string {
  if (!u) return "";
  if (/^(data|blob):/i.test(u)) return u; // keep local previews
  try {
    const normalized = u.trim().replace(/^http:\/\//i, "https://");
    const stripped = normalized.replace(/^https?:\/\//i, "");
    // images.weserv.nl returns proper headers & follows redirects
    return `https://images.weserv.nl/?url=${encodeURIComponent(
      stripped
    )}&w=640&h=480&fit=cover&we&il`;
  } catch {
    return u;
  }
}

export default function ProductCard({ product }: { product: Product }) {
  const [errored, setErrored] = React.useState(false);
  const originalSrc = React.useMemo(() => safeImageUrl(product.image), [product.image]);
  const [src, setSrc] = React.useState(originalSrc);
  React.useEffect(() => setSrc(originalSrc), [originalSrc]);
  const fallback = React.useMemo(
    () => `https://picsum.photos/seed/${encodeURIComponent(product.id)}/640/480`,
    [product.id]
  );

  return (
    <article className="relative group rounded-2xl bg-slate-900/60 ring-1 ring-white/10 overflow-hidden">
      {/* Image area */}
      <div className="relative aspect-[4/3]">
        {!errored ? (
          <img
            src={src}
            alt={product.name}
            loading="lazy"
            decoding="async"
            crossOrigin="anonymous"
            referrerPolicy="no-referrer"
            className="absolute inset-0 h-full w-full object-cover"
            onError={() => {
              if (src !== fallback) {
                setSrc(fallback);
              } else {
                setErrored(true);
              }
            }}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-xs text-white/60">
            No image
          </div>
        )}

        {/* Category chip */}
        <div className="absolute left-3 top-3 text-[10px] font-medium uppercase tracking-wide rounded-full bg-white/10 px-2 py-1 text-white/80 backdrop-blur">
          {product.category?.toLowerCase() || "item"}
        </div>

        {/* Optional score badge */}
        {typeof product.score === "number" && (
          <div className="absolute right-3 top-3 bg-amber-400 text-black text-xs font-bold rounded-full px-2 py-0.5">
            {Math.round(product.score * 100)}%
          </div>
        )}
      </div>

      {/* Footer */}
      <footer className="relative z-10 bg-slate-900/70 px-4 py-3">
        <div className="truncate text-[15px] font-medium text-white/90">
          {product.name}
        </div>
        <div className="text-[11px] text-white/50">#{product.id}</div>
      </footer>
    </article>
  );
}