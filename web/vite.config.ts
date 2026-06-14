import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// 대시보드는 상대경로 /api 로 호출. 로컬(dev/preview)은 vite 프록시가 localhost:8080 으로 전달,
// Vercel은 vercel.json rewrite 가 서버 IP:8080 으로 전달 → .env 불필요(번들에 호스트 안 박힘).
const proxy = { '/api': { target: 'http://localhost:8080', changeOrigin: true } };

export default defineConfig({
  plugins: [react()],
  server: { host: '0.0.0.0', port: 5174, proxy },
  preview: { host: '0.0.0.0', port: 5174, proxy },
});
