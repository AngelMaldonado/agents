import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In dev (reko-3) Traefik serves this at https://agents-dev.cubytest.space and Vite proxies the
// API and the live WebSocket to the backend container.
const api = process.env.AGENTS_API ?? 'http://localhost:8787';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
	server: {
		allowedHosts: ['agents-dev.cubytest.space', 'localhost'],
		hmr: process.env.AGENTS_API ? { clientPort: 443, protocol: 'wss' } : undefined,
		proxy: {
			'/api': { target: api, changeOrigin: false },
			'/hooks': { target: api, changeOrigin: false },
			'/ws': { target: api.replace(/^http/, 'ws'), ws: true },
		},
	},
});
