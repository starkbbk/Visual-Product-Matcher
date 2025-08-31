// scripts/build-catalog.ts
import fs from "node:fs/promises";
import fetch from "node-fetch";
import pLimit from "p-limit";

import products from "../src/data/products.json"; // your JSON

const limit = pLimit(8);

async function fetch256(url: string) {
  const u = url.replace(/\/640\/640$/, "/256/256");
  const res = await fetch(u);
  return Buffer.from(await res.arrayBuffer());
}

async function embedImage(buf: Buffer): Promise<number[]> {
  // TODO: call your existing image-embedding client here
  // return await client.embedImage(buf);
  throw new Error("wire up your embed call here");
}

(async () => {
  const entries = await Promise.all(products.map(p => limit(async () => {
    const buf = await fetch256(p.image);
    const vec = await embedImage(buf);
    return { id: p.id, category: p.category, image: p.image, title: p.name ?? p.title, embedding: vec };
  })));
  await fs.writeFile("public/catalog-embeddings.v1.json", JSON.stringify(entries));
  console.log("Wrote catalog-embeddings.v1.json");
})();