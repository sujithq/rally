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
  base: process.env.VITE_BASE_PATH || '/',
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