import type { CSSProperties } from 'react'
import type { SupportedSite } from '../../data/supportedSites'

export function SiteGrid({ sites, onSelect }: { sites: SupportedSite[]; onSelect: (site: SupportedSite) => void }) {
  if (sites.length === 0) return null

  return (
    <ul data-testid="site-grid" className="site-grid" aria-label="灵感来源站点">
      {sites.map((site) => (
        <li key={site.id}>
          <button
            type="button"
            data-testid={`site-row-${site.id}`}
            aria-label={`打开 ${site.label}`}
            className="site-grid-card"
            style={{ '--site-tint': site.tint } as CSSProperties}
            onClick={() => onSelect(site)}
          >
            <span className="site-grid-logo"><img src={site.logo} alt="" /></span>
            <span className="site-grid-name">{site.label}</span>
          </button>
        </li>
      ))}
    </ul>
  )
}
