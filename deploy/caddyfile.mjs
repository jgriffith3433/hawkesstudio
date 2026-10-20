// The control server's Caddyfile, from one place: deploy/deploy.mjs installs it (--caddy-only, from J's PC, with DNS
// and the first setup), and deploy/hawkes-pull.mjs rebuilds it after every pull on the server (as root): when the text
// differs from /etc/caddy/Caddyfile, it is validated, swapped in, Caddy reloaded and the sites checked, else the old one
// goes back. So a merged change here reaches the web server on its own. Pure: no network, no keys (Caddy reads
// WEB_GEN_KEY from /etc/hawkes/keys.env itself). Agents may change this file only when J names it (src/agents.ts GUARDED).

/**
 * @param {{ domain: string, email: string, products: any, devHosts?: boolean }} o
 *   products: hawkesstudio/products.json, parsed; devHosts: also dev-<sub>.<domain> for the web products' devtools
 * @returns {string}
 */
export function caddyfile({ domain, email, products, devHosts: withDev = false }) {
  const caddy = `
{
	email ${email}
}

# The sign-in (src/auth.ts): Caddy asks Studio's /auth/check on every protected request. A signed-in session cookie
# (or the old j:<password> login from J's scripts) passes with X-Hawkes-User / X-Hawkes-Role; a browser without one is
# sent to https://studio.${domain}/auth/signin and back after signing in.
(login) {
	forward_auth 127.0.0.1:8791 {
		uri /auth/check
		copy_headers X-Hawkes-User X-Hawkes-Role
	}
}

# Who reached Studio and Gen, and with what status (a failed login is a 401). Caddy never logs credentials: the
# Authorization header shows as REDACTED, so a 401 says whether a login was sent, not what it was.
(access) {
	log {
		output file /var/log/caddy/access.log {
			roll_size 10MiB
			roll_keep 5
		}
		format json
	}
}

studio.${domain} {
	import access
	encode zstd gzip
	# MCP for Claude anywhere (src/mcp-http.ts): the Studio MCP key instead of the login, as a bearer header or in the
	# URL (/mcp/hs_...). Studio checks the key itself.
	@mcp {
		path /mcp /mcp/*
		header_regexp Authorization ^Bearer\\s+hs_
	}
	@mcpurl path_regexp ^/mcp/hs_[\\w-]+/?$
	# Pushes from the product repos (hawkes-studio.yml) and CI on main of hawkesstudio/hawkesgen: no login; Studio checks
	# GitHub's signed OIDC token itself (src/github-oidc.ts).
	@githook path /api/hooks/github /api/hooks/github-beta /api/hooks/self-deploy
	handle @githook {
		reverse_proxy 127.0.0.1:8791
	}
	# The sign-in pages themselves (no session needed to reach them).
	handle /auth/* {
		reverse_proxy 127.0.0.1:8791
	}
	handle @mcp {
		reverse_proxy 127.0.0.1:8791 {
			flush_interval -1
		}
	}
	handle @mcpurl {
		reverse_proxy 127.0.0.1:8791 {
			flush_interval -1
		}
	}
	# Hawkes Gen's files and API for Studio's pages (same origin, so one login covers screenshots and videos).
	handle_path /gen/* {
		import login
		reverse_proxy 127.0.0.1:8790 {
			header_up Authorization "Bearer {$WEB_GEN_KEY}"
		}
	}
	handle {
		import login
		reverse_proxy 127.0.0.1:8791
	}
}

gen.${domain} {
	import access
	encode zstd gzip
	# Programs (Unity, scripts, other machines) use their own Hawkes Gen API key.
	@apikey header_regexp Authorization ^Bearer\\s+hg_
	handle @apikey {
		reverse_proxy 127.0.0.1:8790 {
			flush_interval -1
		}
	}
	# MCP with the key in the URL (/mcp/hg_..., for claude.ai connectors); Gen checks the key (src/mcp-http.ts).
	@mcpurl path_regexp ^/mcp/hg_[\\w-]+/?$
	handle @mcpurl {
		reverse_proxy 127.0.0.1:8790 {
			flush_interval -1
		}
	}
	# Hawkes Analytics (hawkesgen docs/analytics.md): players' browsers send events with no login, so only these two
	# are public. Gen checks the origin against its product registry, the body (64 KB) and the rate per address; its
	# GeoIP reads the last X-Forwarded-For entry, set here to the address Caddy saw. No key is added, and any sent is dropped.
	@collect {
		method POST OPTIONS
		path /v1/analytics/collect
	}
	handle @collect {
		request_body {
			max_size 64KB
		}
		reverse_proxy 127.0.0.1:8790 {
			header_up -Authorization
			header_up -Cookie
			header_up X-Forwarded-For {remote_host}
		}
	}
	# The analytics SDK script the pages load (cacheable; Gen's own Cache-Control wins when it sends one).
	@sdk {
		method GET HEAD
		path /sdk/*
	}
	handle @sdk {
		request_body {
			max_size 1KB
		}
		header ?Cache-Control "public, max-age=3600"
		reverse_proxy 127.0.0.1:8790 {
			header_up -Authorization
			header_up -Cookie
		}
	}
	handle {
		import login
		reverse_proxy 127.0.0.1:8790 {
			header_up Authorization "Bearer {$WEB_GEN_KEY}"
		}
	}
}

# The public landing page (Hawkes Gen and Hawkes Studio, for people and the product sites' "Powered by HAWKES GEN"
# badge): plain static files from this repo's site/ folder, no login, nothing behind it. A push to main updates it
# (the server pulls main); only this block, the DNS and the certificate need deploy.mjs.
${domain} {
	import access
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options "nosniff"
		X-Frame-Options "DENY"
		Referrer-Policy "strict-origin-when-cross-origin"
		Permissions-Policy "camera=(), microphone=(), geolocation=()"
		# The page is still locked down. The one exception is the Twitch player in site/index.html: a frame
		# of https://player.twitch.tv (channel jgriffith3433, parent hawkesgen.com). The iframe asks the
		# parent page for nothing else, so script, image and connect stay closed.
		Content-Security-Policy "default-src 'none'; style-src 'self'; img-src 'self' data:; frame-src https://player.twitch.tv; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
		Cache-Control "public, max-age=300"
		-Server
	}
	root * /srv/hawkes/hawkesstudio/site
	file_server
}

www.${domain} {
	redir https://${domain}{uri} permanent
}
`.trimStart();
  return caddy + previewBlocks(domain, products, withDev);
}

/** The DNS names previewBlocks serves (deploy.mjs points them at the server). */
export function previewHosts(products, withDev = false) {
  const previews = products.previews ?? {};
  const subs = Object.keys(previews);
  const devHosts = withDev ? subs.filter((sub) => products.products.find((p) => p.id === previews[sub])?.dev?.port) : [];
  return { previews, subs, devHosts };
}

/**
 * Staging sites (src/previews.ts): <sub>.<domain> for each products.json "previews" entry, behind the same login.
 * / is the product built from its beta branch (previews/<product>/beta), /c/<change>/ an agent change, and /dev/ the
 * product's devtools running on this server (src/dev.ts, dev-front.ts): Studio's front door for the product
 * (products.json dev.front), which also takes Vite's HMR websocket.
 */
function previewBlocks(domain, products, withDev) {
  const { previews, subs, devHosts } = previewHosts(products, withDev);
  if (!subs.length) return '';
  const fronts = Object.fromEntries(products.products.filter((p) => p.dev?.front).map((p) => [p.id, p.dev.front]));
  const devBlocks = devHosts.map((sub) => `
dev-${sub}.${domain} {
	import login
	encode zstd gzip
	# The devtools at the root (no service worker needed); the same front door as ${sub}.${domain}/dev/.
	reverse_proxy 127.0.0.1:${fronts[previews[sub]]} {
		flush_interval -1
	}
}
`).join('');
  return devBlocks + subs.map((sub) => {
    const front = fronts[previews[sub]];
    const dev = front ? `
	# /dev/: the product's devtools on this server, in beta's working copy (Studio's front door; saves commit to beta).
	# Vite's HMR websocket connects to the site root with the vite-hmr protocol: it goes there too.
	@dev path /dev /dev/*
	@hmr header Sec-WebSocket-Protocol vite-hmr
	handle @dev {
		reverse_proxy 127.0.0.1:${front} {
			flush_interval -1
		}
	}
	handle @hmr {
		reverse_proxy 127.0.0.1:${front}
	}` : '';
    return `
${sub}.${domain} {
	import login
	encode zstd gzip${dev}
	handle {
		header Cache-Control "no-cache"
		root * /srv/hawkes/previews/${previews[sub]}
		# /c/<change>/ is an agent change; everything else is beta.
		@beta not path /c/*
		rewrite @beta /beta{uri}
		file_server
	}
}
`;
  }).join('');
}
