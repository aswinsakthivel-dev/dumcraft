export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  // Fetch the static team.html from Pages assets
  const assetUrl = new URL('/team.html', url.origin);
  const response = await env.ASSETS.fetch(new Request(assetUrl, request));

  const headers = new Headers(response.headers);
  headers.set('X-Robots-Tag', 'noindex, nofollow');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}
