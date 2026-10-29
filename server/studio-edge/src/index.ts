// The whole Worker: the same request to Studio on Cloud Run, the answer streamed back as it comes (the dashboard's
// event stream and Talk's answers included). The host goes along as X-Forwarded-Host, so Studio's session cookie is set
// for .hawkesgen.ai and its sign-in pages accept their own forms (auth.ts, auth-pages.ts); the visitor's address as
// X-Forwarded-For (the sign-in log and its limits).
export default {
  async fetch(request: Request, env: { STUDIO_ORIGIN: string }): Promise<Response> {
    const url = new URL(request.url);
    const origin = new URL(env.STUDIO_ORIGIN);
    url.protocol = origin.protocol;
    url.hostname = origin.hostname;
    url.port = '';
    const headers = new Headers(request.headers);
    headers.set('X-Forwarded-Host', new URL(request.url).host);
    headers.set('X-Forwarded-Proto', 'https');
    headers.set('X-Forwarded-For', request.headers.get('CF-Connecting-IP') ?? '');
    return fetch(url, { method: request.method, headers, body: request.body, redirect: 'manual' });
  },
};
