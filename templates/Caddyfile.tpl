{
  admin off
  http_port 8080
  https_port 8443
__ACME_EMAIL_OPTION__
}

__DOMAIN__ {
__NEWS_ROUTE__

  handle {
    root * __SITE_ROOT__
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
