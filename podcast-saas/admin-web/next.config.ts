import type { NextConfig } from 'next';
import { buildFrontendCsp } from 'shared/src/csp';

// ── Fail-closed resolution of the browser-visible API URL ───────────────────────
// A production build requires a public https origin; missing/localhost/internal/non-https
// FAILS the build. Localhost allowed ONLY in development. (Mirrors client-web.)
const IS_PROD = process.env.NODE_ENV === 'production';
const NON_PUBLIC = /(localhost|127\.0\.0\.1|0\.0\.0\.0|\[?::1\]?)|^https?:\/\/(backend|worker|nginx|client-web|admin-web)(:|\/|$)/i;

function resolvePublicUrl(name: string, devDefault: string): string {
  const v = process.env[name]?.trim();
  if (IS_PROD) {
    if (!v) throw new Error(`[admin-web build] ${name} must be set for a production build (public https origin).`);
    if (NON_PUBLIC.test(v)) throw new Error(`[admin-web build] ${name} must be a public URL in production, got: ${v}`);
    if (!/^https:\/\//i.test(v)) throw new Error(`[admin-web build] ${name} must be https in production, got: ${v}`);
    return v;
  }
  return v || devDefault;
}

const PUBLIC_API_URL = resolvePublicUrl('NEXT_PUBLIC_API_URL', 'http://localhost:8080');

// Production CSP for admin pages. Admin is never embedded (frame-ancestors 'none') and
// talks only to the API + its own origin. Scheme sources (https:) keep third-party SDKs
// (Firebase/Google) working while blocking http/mixed-content (e.g. http://localhost).
// Defined as a const BEFORE nextConfig (Next's compiled config can ReferenceError on a
// function declaration referenced from a config method — mirror client-web).
const securityHeaders = (): { key: string; value: string }[] => {
  const csp = buildFrontendCsp({
    apiUrl: PUBLIC_API_URL,
    // Admin also uses Firebase Auth → its auth-domain iframe origin must be allowed.
    firebaseAuthDomain: process.env.NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN,
    includeStripe: false, // admin has no Stripe checkout
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
  // Resolve the API base at build time (in Node) so the localhost dev fallback lives ONLY
  // here and never ships as a dead-code string literal in the browser bundle. Next replaces
  // process.env.NEXT_PUBLIC_API_URL with this clean literal, so `?? 'http://localhost:8080'`
  // in the lib files folds away. (Mirrors client-web/next.config.ts.)
  env: {
    NEXT_PUBLIC_API_URL: PUBLIC_API_URL,
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders() }];
  },
  webpack: (config) => {
    config.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
    };
    return config;
  },
};

export default nextConfig;
