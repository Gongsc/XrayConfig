{
  admin off
  http_port 8080
  https_port 8443
__ACME_EMAIL_OPTION__
}

__DOMAIN__ {
  handle /api/60s {
    rewrite * /v2/60s?encoding=json
    reverse_proxy news-api:4399
  }

  handle {
    root * /srv
    encode zstd gzip
    file_server
  }

  header {
    -Server
    Strict-Transport-Security "max-age=31536000"
    X-Content-Type-Options "nosniff"
    X-Frame-Options "DENY"
    Referrer-Policy "no-referrer"
    Content-Security-Policy "default-src 'self'; script-src 'self'; connect-src 'self'; img-src 'self'; style-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
    Permissions-Policy "camera=(), geolocation=(), microphone=()"
  }

  log {
    output stdout
    format console
  }
}
