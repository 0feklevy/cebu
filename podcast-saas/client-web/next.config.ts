import type { NextConfig } from 'next';

// Fail the build rather than bake a localhost API URL into the shipped browser bundle.
// NEXT_PUBLIC_API_URL is passed as a Docker build arg (deploy/docker-compose.yml); in
// production it MUST be the public https API origin (never localhost/an internal host).
if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_API_URL) {
  throw new Error(
    'NEXT_PUBLIC_API_URL must be set at build time for client-web (public https API origin).',
  );
}

// Production CSP for app pages. Two framing concerns kept separate:
//   frame-ancestors 'none'  → nobody may embed OUR app pages (anti-clickjacking).
//   frame-src               → which iframes our pages may load: sims (served from the API
//                             origin /sim-public) + Stripe. Scheme sources (https:) keep
//                             Firebase/Anam/Stripe/Supabase working while http/mixed-content
//                             (e.g. http://localhost:8080) is blocked at the CSP layer too.
// Defined as a const BEFORE nextConfig: Next compiles this file to next.config.compiled.js
// and its bundler does not reliably resolve a helper referenced inside a config method when
// that helper is a function *declaration* placed after the config object (ReferenceError).
const securityHeaders = (): { key: string; value: string }[] => {
  const api = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080';
  const dev = process.env.NODE_ENV !== 'production';
  const devApi = dev ? ' http://localhost:8080' : '';
  const csp = [
    "default-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `frame-src 'self' ${api} https://js.stripe.com${devApi}`,
    "script-src 'self' 'unsafe-inline' 'unsafe-eval' https:" + (dev ? ' http:' : ''),
    "style-src 'self' 'unsafe-inline' https:",
    "font-src 'self' data: https:",
    `img-src 'self' data: blob: https:${devApi}`,
    `media-src 'self' blob: https:${devApi}`,
    `connect-src 'self' https: wss:${dev ? ' http://localhost:8080 ws://localhost:8080' : ''}`,
  ].join('; ');
  return [
    { key: 'Content-Security-Policy', value: csp },
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  ];
};

const nextConfig: NextConfig = {
  transpilePackages: ['shared'],
  experimental: {
    typedRoutes: true,
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080',
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders() }];
  },
  webpack: (config, { dev }) => {
    if (dev) {
      config.watchOptions = {
        ...config.watchOptions,
        poll: 1000,
        aggregateTimeout: 300,
        ignored: [
          '**/.git/**',
          '**/.next/**',
          '**/node_modules/**',
          '../node_modules/**',
          '../../node_modules/**',
        ],
      };
    }
    // TypeScript files in the shared workspace use .js extensions for ESM compat.
    // Tell webpack to try .ts/.tsx when .js can't be found.
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
