import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// GitHub Pages project site: https://gintasz.github.io/microfoom
// `basePath` must match the repo name so asset URLs resolve under /microfoom.
const basePath = '/microfoom';

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  reactStrictMode: true,
  basePath,
  // Next's default image optimizer needs a server; static export can't use it.
  images: { unoptimized: true },
  // Silence the workspace-root inference warning (multiple lockfiles nearby).
  turbopack: { root: import.meta.dirname },
  env: {
    NEXT_PUBLIC_BASE_PATH: basePath,
  },
};

export default withMDX(config);
