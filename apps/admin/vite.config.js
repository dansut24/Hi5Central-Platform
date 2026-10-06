import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

function envValue(key, fallback = '') {
  const raw = process.env[key]
  return raw === undefined || raw === null || String(raw).trim() === '' ? fallback : String(raw).trim()
}

function hi5RuntimeConfigPlugin() {
  return {
    name: 'hi5central-local-runtime-config',
    configureServer(server) {
      server.middlewares.use('/runtime-config.js', (_req, res) => {
        const runtimeEnvironment = envValue('VITE_RUNTIME_ENVIRONMENT', 'dev')
        const config = {
          deploymentMode: envValue('VITE_DEPLOYMENT_MODE', 'managed'),
          selfHostEdition: envValue('VITE_SELF_HOST_EDITION', 'standard'),
          tenancyMode: envValue('VITE_TENANCY_MODE', 'multi'),
          runtimeEnvironment,
          featureMode: envValue(
            'VITE_FEATURE_MODE',
            runtimeEnvironment === 'dev' || runtimeEnvironment === 'test' ? 'all_enabled' : 'controlled',
          ),
          rootDomain: envValue('VITE_ROOT_DOMAIN', 'hi5central.com'),
          primaryTenantSlug: envValue('VITE_PRIMARY_TENANT_SLUG', ''),
          appUrl: envValue('VITE_APP_URL', ''),
          apiUrl: envValue('VITE_API_URL', ''),
          portalUrl: envValue('VITE_PORTAL_URL', ''),
          rmmUrl: envValue('VITE_RMM_URL', ''),
          adminUrl: envValue('VITE_ADMIN_URL', ''),
          marketingUrl: envValue('VITE_MARKETING_URL', ''),
          downloadsUrl: envValue('VITE_DOWNLOADS_URL', ''),
          turnUrl: envValue('VITE_TURN_URL', ''),
        }

        res.statusCode = 200
        res.setHeader('Content-Type', 'application/javascript; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        res.end(
          'window.__HI5_CONFIG__ = Object.freeze(' + JSON.stringify(config) + ');\n' +
          'window.__HI5_API_BASE__ = window.__HI5_CONFIG__.apiUrl || window.location.origin;\n',
        )
      })
    },
  }
}

// Hi5Central is deployed at the site root. Using an absolute base keeps
// JS/CSS/assets loading from /assets/... when a user opens a deep SPA URL directly.
export default defineConfig({
  base: '/',
  plugins: [hi5RuntimeConfigPlugin(), react()],
})
