/**
 * proxy-fetch.ts
 * ─────────────────────────────────────────────────────────────────────────────
 * Proxy-aware fetch wrapper. Routes DexScreener and external API requests
 * through a residential proxy when RESIDENTIAL_PROXY_URL is configured.
 *
 * Bun's fetch() supports a non-standard `proxy` option at the runtime level.
 * This does NOT affect MongoDB or Telegram API connections.
 * ─────────────────────────────────────────────────────────────────────────────
 */

interface BunRequestInit extends RequestInit {
  proxy?: string;
}

const PROXY_URL = process.env.RESIDENTIAL_PROXY_URL?.trim() || null;

if (PROXY_URL) {
  const masked = PROXY_URL.replace(/:\/\/[^@]+@/, '://***:***@');
  console.log(`🌐 [ProxyFetch] Residential proxy active: ${masked}`);
} else {
  console.log('🌐 [ProxyFetch] No RESIDENTIAL_PROXY_URL set — using direct connections');
}

/**
 * Drop-in replacement for fetch() that tunnels through the residential proxy
 * when RESIDENTIAL_PROXY_URL is configured.
 */
export async function proxyFetch(
  url: string | URL,
  init?: RequestInit,
): Promise<Response> {
  const bunInit: BunRequestInit = { ...init };
  if (PROXY_URL) {
    bunInit.proxy = PROXY_URL;
  }
  return fetch(url as string, bunInit);
}
