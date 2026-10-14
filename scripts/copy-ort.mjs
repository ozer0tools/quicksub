// Copia o runtime do ONNX (WebAssembly) para dentro do site, para não depender de CDN.
import { cpSync, mkdirSync, readdirSync } from 'node:fs';
const src = 'node_modules/onnxruntime-web/dist/';
mkdirSync('dist/ort', { recursive: true });
for (const f of readdirSync(src)) {
  if (/^ort-wasm-simd-threaded.*\.(wasm|mjs)$/.test(f)) cpSync(src + f, 'dist/ort/' + f);
}
console.log('ort copiado');
