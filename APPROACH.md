**Approach (≤200 words)**

I solved visual similarity fully in the browser to keep hosting simple and costs at $0. The app loads the TensorFlow.js MobileNet model and converts both the query image and each catalog image into a numeric embedding (activations of the `conv_preds` layer). I normalize these vectors and compute cosine similarity to rank products. A progress bar shows embedding status; errors are surfaced with friendly messages. Results can be filtered by minimum similarity, limited by Top‑K, and optionally narrowed by category.

The UI is a single‑page React app (Vite + TypeScript + Tailwind). It supports file upload and image‑URL input, shows the query preview, and renders a responsive card grid of matches. The “product database” is a static JSON/TS file with 50 items (name, category, price, image). Images use CORS‑enabled placeholders (`picsum.photos`) so TFJS can read pixels cross‑origin.

This design is production‑friendly: the ML runs client‑side (no key/secrets), the code is clean and typed, and deployment is a static build to Netlify/Vercel/GitHub Pages. To scale, move the product store to a DB and precompute embeddings server‑side, then serve a compact vector index (e.g., cosine‑normalized float32) to the client.
