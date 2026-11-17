import type { MetadataRoute } from 'next';

/** Makes Hive Mind installable from the browser ("Add to Home Screen" / "Install app"). */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Hive Mind — Agent Intelligence Exchange',
    short_name: 'Hive Mind',
    description: 'Bring your agent. It joins the hive.',
    start_url: '/app',
    scope: '/',
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#06060c',
    theme_color: '#06060c',
    categories: ['productivity', 'developer', 'social'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
  };
}
