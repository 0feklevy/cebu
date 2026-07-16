import type { NextConfig } from 'next';

// Fail the build rather than bake a localhost API URL into the shipped admin bundle.
// NEXT_PUBLIC_API_URL is passed as a Docker build arg (deploy/docker-compose.yml) and
// auto-inlined by Next; in production it MUST be the public https API origin.
if (process.env.NODE_ENV === 'production' && !process.env.NEXT_PUBLIC_API_URL) {
  throw new Error(
    'NEXT_PUBLIC_API_URL must be set at build time for admin-web (public https API origin).',
  );
}

// Production CSP for admin pages. Admin is never embedded (frame-ancestors 'none') and
// talks only to the API + its own origin. Scheme sources (https:) keep third-party SDKs
// (Firebase/Google) working while blocking http/mixed-content (e.g. http://localhost).
// Defined as a const BEFORE nextConfig (Next's compiled config can ReferenceError on a
// function declaration referenced from a config method — mirror client-web).
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
    `frame-src 'self' ${api}${devApi}`,
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
  // Resolve the API base at build time (in Node) so the localhost dev fallback lives ONLY
  // here and never ships as a dead-code string literal in the browser bundle. Next replaces
  // process.env.NEXT_PUBLIC_API_URL with this clean literal, so `?? 'http://localhost:8080'`
  // in the lib files folds away. (Mirrors client-web/next.config.ts.)
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080',
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
