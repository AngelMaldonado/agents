import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In dev (reko-3) Traefik serves this at https://agents-dev.cubytest.space and Vite proxies the
// API and the live WebSocket to the backend container.
const api = process.env.BUYER_API ?? 'http://localhost:8787';

export default defineConfig({
	plugins: [react()],
	server: {
		allowedHosts: ['agents-dev.cubytest.space', 'localhost'],
		hmr: process.env.BUYER_API ? { clientPort: 443, protocol: 'wss' } : undefined,
		proxy: {
			'/api': { target: api, changeOrigin: false },
			'/ws': { target: api.replace(/^http/, 'ws'), ws: true }
		}
	}
});
