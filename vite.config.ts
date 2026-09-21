import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

export default defineConfig({
  /*
   * GitHub Pages serves a project site from /<repo>/, not from the domain
   * root, so every asset URL needs that prefix or the page loads a white
   * screen with 404s. `BASE_PATH` is set by the deploy workflow; local `dev`
   * and `preview` leave it unset and serve from '/'.
   */
  base: process.env.BASE_PATH ?? '/',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  build: {
    target: 'es2022',
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        manualChunks: { pixi: ['pixi.js'] },
      },
    },
  },
})
