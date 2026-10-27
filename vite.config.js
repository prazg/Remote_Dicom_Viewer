import { defineConfig, loadEnv } from 'vite';

// Builds the Content-Security-Policy for index.html. Only this site and the
// configured Supabase project may be contacted; no third-party scripts.
function cspPlugin(supabaseUrl) {
  let origin = '';
  try { origin = new URL(supabaseUrl).origin; } catch { /* not configured */ }
  const wsOrigin = origin.replace(/^http/, 'ws');
  const policy = [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval'", // WebAssembly image decoders
    "worker-src 'self' blob:",
    `connect-src 'self' data: blob: ${origin} ${wsOrigin}`.trim(),
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
  return {
    name: 'csp',
    transformIndexHtml: { order: 'pre', handler: (html) => html.replaceAll('__CSP__', policy) },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  return {
    // Relative paths: the build works under any GitHub Pages repository name.
    base: './',
    plugins: [cspPlugin(env.VITE_SUPABASE_URL)],
    // The DICOM image loader starts its decode worker with
    // `new URL('./decodeImageFrameWorker.js', import.meta.url)`; pre-bundling
    // it in dev breaks that URL, so it is excluded from optimisation.
    optimizeDeps: {
      exclude: ['@cornerstonejs/dicom-image-loader'],
      include: ['dicom-parser'],
    },
    worker: { format: 'es' },
    build: { target: 'es2022', chunkSizeWarningLimit: 6000 },
  };
});
