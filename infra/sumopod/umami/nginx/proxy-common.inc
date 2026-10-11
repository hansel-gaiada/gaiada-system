# Included by every proxied location. Headers set to "" are NOT forwarded.
proxy_http_version 1.1;
proxy_set_header Connection "";
proxy_set_header Host $host;
proxy_set_header X-Real-IP $remote_addr;
proxy_set_header X-Forwarded-For $remote_addr;
proxy_set_header X-Forwarded-Proto https;
proxy_set_header Cookie "";

# Visitor-spoofable location headers: Umami would trust these over its MMDB (also off via SKIP_LOCATION_HEADERS).
proxy_set_header CF-IPCountry "";
proxy_set_header CF-Region-Code "";
proxy_set_header CF-IPCity "";
proxy_set_header X-Vercel-IP-Country "";
proxy_set_header X-Vercel-IP-Country-Region "";
proxy_set_header X-Vercel-IP-City "";
proxy_set_header CloudFront-Viewer-Country "";
proxy_set_header CloudFront-Viewer-Country-Region "";
proxy_set_header CloudFront-Viewer-City "";
proxy_set_header EO-IPCountry "";
proxy_set_header EO-Region-Code "";
proxy_set_header EO-IPCity "";

# GHSA-3xx8-742v-m4mq: the cache token from the collector is replayable as a share token. Never forward the
# share headers from the public side.
proxy_set_header x-umami-share-token "";
proxy_set_header x-umami-share-context "";

proxy_connect_timeout 3s;
proxy_read_timeout 15s;
