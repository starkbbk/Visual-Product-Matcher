import { pipeline } from '@xenova/transformers'
import fs from 'node:fs/promises'

const DIM = 512
const OUT = 'public/embeddings.v1.f16'

function f32toF16(v:number){const f32=new Float32Array(1);const i32=new Int32Array(f32.buffer);f32[0]=v;const x=i32[0];const s=(x>>16)&0x8000;let m=(x>>12)&0x07ff;let e=(x>>23)&0xff;if(e<103)return s;if(e>142)return s|0x7c00;e=e-112;m=m+0x1000;if(m&0x800000){m=0;e++}if(e>30)return s|0x7c00;return s|(e<<10)|((m>>13)&0x03ff)}
async function main(){
  const products = JSON.parse(await fs.readFile('public/products.v1.json','utf8')) as {id:string;name:string;category:string;image:string}[]
  console.log(`Embedding ${products.length} items…`)
  const extractor:any = await pipeline('feature-extraction','Xenova/clip-vit-base-patch32')
  const f16 = new Uint16Array(products.length * DIM)
  for (let i=0;i<products.length;i++){
    const p = products[i]
    const out = await extractor(p.image,{pooling:'mean',normalize:true})
    const vec = out.data as Float32Array
    for (let d=0; d<DIM; d++) f16[i*DIM+d] = f32toF16(vec[d])
    if ((i+1)%50===0) console.log(`  ${i+1}/${products.length}`)
  }
  await fs.writeFile(OUT, Buffer.from(f16.buffer))
  console.log(`Wrote ${OUT} (${(f16.byteLength/1024/1024).toFixed(1)} MB)`)
}
main().catch(e=>{console.error(e);process.exit(1)})
