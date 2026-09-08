import type { NextConfig } from 'next';
const config: NextConfig = {
  poweredByHeader: false,
  output: 'standalone',
  outputFileTracingRoot: process.cwd().replace(/[\\/]apps[\\/]web$/, ''),
};
export default config;
