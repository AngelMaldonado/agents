import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// In dev (`just dev`) Vite runs on this Mac at http://localhost:5173 and proxies the API, the
// inbound hooks and the live WebSocket to the backend on :8787.
const api = process.env.AGENTS_API ?? 'http://localhost:8787';

export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: { alias: { '@': new URL('./src', import.meta.url).pathname } },
	server: {
		allowedHosts: ['localhost'],
		proxy: {
			'/api': { target: api, changeOrigin: false },
			'/hooks': { target: api, changeOrigin: false },
			'/ws': { target: api.replace(/^http/, 'ws'), ws: true },
		},
	},
});
