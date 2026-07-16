import type { NextConfig } from 'next';
import { buildFrontendCsp } from 'shared/src/csp';

// ── Fail-closed resolution of browser-visible URLs ──────────────────────────────
// In a PRODUCTION build these MUST be public https origins. A missing value, a
// localhost/loopback value, an internal-docker host, or a non-https value FAILS the
// build — production can never silently bake http://localhost:8080 (the incident).
// Localhost is allowed ONLY in development (next dev / a non-production build).
const IS_PROD = process.env.NODE_ENV === 'production';
const NON_PUBLIC = /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)|^https?:\/\/(backend|worker|nginx|client-web|admin-web)(:|\/|$)/i;

function resolvePublicUrl(name: string, devDefault: string): string {
  const v = process.env[name]?.trim();
  if (IS_PROD) {
    if (!v) throw new Error(`[client-web build] ${name} must be set for a production build (public https origin).`);
    if (NON_PUBLIC.test(v)) throw new Error(`[client-web build] ${name} must be a public URL in production, got: ${v}`);
    if (!/^https:\/\//i.test(v)) throw new Error(`[client-web build] ${name} must be https in production, got: ${v}`);
    return v;
  }
  return v || devDefault; // dev-only localhost fallback (never reached in a prod build)
}

const PUBLIC_API_URL = resolvePublicUrl('NEXT_PUBLIC_API_URL', 'http://localhost:8080');
const PUBLIC_APP_URL = resolvePublicUrl('NEXT_PUBLIC_APP_URL', 'http://localhost:3000');
const PUBLIC_SITE_URL = process.env.PUBLIC_SITE_URL?.trim()
  ? resolvePublicUrl('PUBLIC_SITE_URL', 'http://localhost:3000')
  : PUBLIC_APP_URL;

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
  const csp = buildFrontendCsp({
    apiUrl: PUBLIC_API_URL,
    // Firebase Auth iframe origin (<project>.firebaseapp.com) — required for sign-in.
    firebaseAuthDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    includeStripe: true, // client-web loads the Stripe checkout iframe
    dev: !IS_PROD,
  });
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
  // Bake the RESOLVED values (never a raw localhost literal) so every reference inlines
  // the validated origin and the dev fallback never ships in the production bundle.
  env: {
    NEXT_PUBLIC_API_URL: PUBLIC_API_URL,
    NEXT_PUBLIC_APP_URL: PUBLIC_APP_URL,
    PUBLIC_SITE_URL: PUBLIC_SITE_URL,
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
