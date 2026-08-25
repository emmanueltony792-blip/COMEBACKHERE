import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_INVOICE_CONTRACT_ID': '"CDUMMYCONTRACT"',
    'import.meta.env.VITE_SOROBAN_RPC': '"https://dummy-rpc.example.com"',
    'import.meta.env.VITE_NETWORK_PASSPHRASE': '"Test SDF Future Network ; September 2025"',
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/tests/setup.ts'],
    globals: true,
    exclude: ['e2e/**', 'node_modules/**'],
  },
})
