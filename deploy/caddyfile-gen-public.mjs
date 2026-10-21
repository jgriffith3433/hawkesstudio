// Standalone Caddyfile for the public commercial Hawkes Gen Cloud server (hawkesgen.com),
// separate from the internal Hawkes Studio control server.
// Installed by deploy/deploy-gen-public.mjs.

/**
 * @param {string | { domain?: string, email?: string }} [domainOrOpts='hawkesgen.com']
 * @param {{ email?: string }} [opts]
 * @returns {string}
 */
export function genPublicCaddyfile(domainOrOpts = 'hawkesgen.com', opts = {}) {
  const domain = typeof domainOrOpts === 'object' && domainOrOpts !== null
    ? (domainOrOpts.domain ?? 'hawkesgen.com')
    : domainOrOpts;
  const email = (typeof domainOrOpts === 'object' && domainOrOpts !== null ? domainOrOpts.email : opts.email)
    ?? 'jgriffith3433@gmail.com';

  return `{
	email ${email}
}

(access) {
	log {
		output file /var/log/caddy/access.log {
			roll_size 10MiB
			roll_keep 5
		}
		format json
	}
}

https://${domain} {
	import access
	encode zstd gzip

	request_body {
		max_size 64MB
	}

	header {
		Strict-Transport-Security "max-age=31536000; includeSubDomains"
		X-Content-Type-Options "nosniff"
		Referrer-Policy "strict-origin-when-cross-origin"
		-Server
	}

	# Server-Sent Events (/v1/events) and MCP streaming (/mcp/*)
	@events {
		path /v1/events /v1/events/* /mcp /mcp/*
	}
	handle @events {
		reverse_proxy 127.0.0.1:8790 {
			flush_interval -1
			header_up X-Forwarded-For {remote_host}
		}
	}

	# Public Hawkes Gen Cloud routes (/, /app/*, /v1/*, /mcp/*, /client/*, /sdk/*)
	@public {
		path / /app/* /v1/* /mcp/* /client/* /sdk/*
	}
	handle @public {
		reverse_proxy 127.0.0.1:8790 {
			header_up X-Forwarded-For {remote_host}
		}
	}

	handle {
		reverse_proxy 127.0.0.1:8790 {
			header_up X-Forwarded-For {remote_host}
		}
	}
}

www.${domain} {
	redir https://${domain}{uri} permanent
}
`;
}
