function value(env, key, fallback = '') {
  const raw = env[key]
  return raw === undefined || raw === null || String(raw).trim() === '' ? fallback : String(raw).trim()
}

export function hi5RuntimeConfigPlugin() {
  return {
    name: 'hi5central-local-runtime-config',
    configureServer(server) {
      server.middlewares.use('/runtime-config.js', (_req, res) => {
        const env = process.env
        const runtimeEnvironment = value(env, 'VITE_RUNTIME_ENVIRONMENT', 'dev')
        const config = {
          deploymentMode: value(env, 'VITE_DEPLOYMENT_MODE', 'managed'),
          selfHostEdition: value(env, 'VITE_SELF_HOST_EDITION', 'standard'),
          tenancyMode: value(env, 'VITE_TENANCY_MODE', 'multi'),
          runtimeEnvironment,
          featureMode: value(
            env,
            'VITE_FEATURE_MODE',
            runtimeEnvironment === 'dev' || runtimeEnvironment === 'test' ? 'all_enabled' : 'controlled',
          ),
          rootDomain: value(env, 'VITE_ROOT_DOMAIN', 'hi5central.com'),
          primaryTenantSlug: value(env, 'VITE_PRIMARY_TENANT_SLUG', ''),
          appUrl: value(env, 'VITE_APP_URL', ''),
          apiUrl: value(env, 'VITE_API_URL', ''),
          portalUrl: value(env, 'VITE_PORTAL_URL', ''),
          rmmUrl: value(env, 'VITE_RMM_URL', ''),
          adminUrl: value(env, 'VITE_ADMIN_URL', ''),
          marketingUrl: value(env, 'VITE_MARKETING_URL', ''),
          downloadsUrl: value(env, 'VITE_DOWNLOADS_URL', ''),
          turnUrl: value(env, 'VITE_TURN_URL', ''),
        }

        const serialized = JSON.stringify(config)
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(
          'window.__HI5_CONFIG__ = Object.freeze(' + serialized + ');\n' +
          'window.__HI5_API_BASE__ = window.__HI5_CONFIG__.apiUrl || window.location.origin;\n'
        )
      })
    },
  }
}
