// DumCraft Cloudflare Worker Entry Point (Worker with Static Assets)
import { onRequest } from './functions/api/[[route]].js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. API routes (/api/*)
    if (url.pathname.startsWith('/api')) {
      return onRequest({ request, env, params: {}, ctx });
    }

    // 2. Team dashboard route (/team or /team/<key>)
    if (url.pathname === '/team' || url.pathname.startsWith('/team/')) {
      // Fetch the static team.html from assets
      const assetUrl = new URL('/team.html', url.origin);
      const res = await env.ASSETS.fetch(new Request(assetUrl, request));
      
      const headers = new Headers(res.headers);
      headers.set('X-Robots-Tag', 'noindex, nofollow');
      headers.set('Referrer-Policy', 'no-referrer');
      headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');

      return new Response(res.body, {
        status: res.status,
        statusText: res.statusText,
        headers
      });
    }

    // 3. Static Assets (/index.html, /style.css, /team.js, etc.)
    return env.ASSETS.fetch(request);
  }
};
