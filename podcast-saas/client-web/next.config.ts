import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['shared'],
  experimental: {
    typedRoutes: true,
  },
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:8080',
  },
  webpack: (config, { dev }) => {
    if (dev) {
      // pnpm symlinks into .pnpm virtual store cause watchpack to open file
      // descriptors for every transitive dependency file, hitting EMFILE and
      // breaking route registration (causing 404s). Stop watchpack from
      // following symlinks — module resolution (resolve.symlinks) is unaffected
      // so transpilePackages: ['shared'] still works.
      config.watchOptions = {
        ...config.watchOptions,
        followSymlinks: false,
        ignored: ['**/node_modules/**', '**/.git/**'],
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
