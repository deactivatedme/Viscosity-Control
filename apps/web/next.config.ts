import type { NextConfig } from 'next';
import path from 'node:path';

const api = process.env.API_URL ?? 'http://127.0.0.1:4000';

const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.join(import.meta.dirname, '../..'),
  transpilePackages: ['@viscosity/protocol'],
  poweredByHeader: false,
  // Dev convenience and a fallback: in production Caddy routes /api and /ws straight to the API.
  async rewrites() {
    return [
      { source: '/api/:path*', destination: `${api}/api/:path*` },
      { source: '/install.sh', destination: `${api}/install.sh` },
    ];
  },
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'DENY' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'same-origin' },
      ],
    }];
  },
};
export default config;
