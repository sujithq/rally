import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import instanceConfig from './rally.config.json' with { type: 'json' }

function htmlAttribute(value: string) {
  return value
    .split('&').join('&amp;')
    .split('"').join('&quot;')
    .split('<').join('&lt;')
    .split('>').join('&gt;')
}

const htmlReplacements: Record<string, string> = {
  '%RALLY_THEME_COLOR%': htmlAttribute(instanceConfig.site.themeColor),
  '%RALLY_DESCRIPTION%': htmlAttribute(instanceConfig.site.description),
  '%RALLY_TITLE%': htmlAttribute(instanceConfig.site.title),
}

export default defineConfig({
  // This site is only ever served from its custom domain root
  // (rally.quintelier.dev), never from the sujithq.github.io/rally/
  // project-pages path. The Pages workflow's VITE_BASE_PATH (derived from
  // actions/configure-pages) is intentionally ignored here: when that action
  // doesn't observe the custom domain for a given run, it falls back to the
  // default project-pages path and produces /rally/-prefixed asset URLs,
  // which 404 on the custom domain. Always building with a root base path
  // keeps asset URLs correct regardless of what configure-pages reports.
  base: '/',
  plugins: [
    react(),
    {
      name: 'rally-instance-config',
      transformIndexHtml(html) {
        return html.replace(
          /%RALLY_(?:THEME_COLOR|DESCRIPTION|TITLE)%/g,
          (placeholder) => htmlReplacements[placeholder],
        )
      },
    },
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:4174',
    },
  },
})