import { useEffect, useRef, useCallback } from 'react'
import cytoscape, { Core, EventObject } from 'cytoscape'
import { GraphResponse } from '../api/client'
import { nodeSize } from '../lib/graphColors'

let coseBilkentRegistered = false
async function registerCose() {
  if (coseBilkentRegistered) return
  const mod = await import('cytoscape-cose-bilkent')
  cytoscape.use(mod.default)
  coseBilkentRegistered = true
}

interface Props {
  data: GraphResponse
  searchQuery: string
  onSelectNode?: (username: string) => void
}

const STATUS_COLORS: Record<string, string> = {
  available: '#4e80ee',
  private: '#a855f7',
  unavailable: '#94a3b8',
  rate_limited: '#f97316',
  blocked: '#ef4444',
  error: '#ef4444',
}

/** Emphasize a node (or set) plus its 1-hop neighborhood; fade everything else. */
function applyFocus(cy: Core, focusNodes: cytoscape.NodeCollection | cytoscape.NodeSingular) {
  const seeds = cy.collection().union(focusNodes as cytoscape.NodeCollection)

  cy.elements().removeClass('highlighted faded neighbor neighbor-edge')
  cy.elements().addClass('faded')

  seeds.removeClass('faded').addClass('highlighted')

  // 1st-degree neighbors (nodes + edges connected to any seed).
  const neighborhood = seeds.neighborhood()
  neighborhood.nodes().forEach((n) => {
    if (n.hasClass('highlighted')) return
    n.removeClass('faded').addClass('neighbor')
  })
  neighborhood.edges().removeClass('faded').addClass('neighbor-edge')
  seeds.connectedEdges().removeClass('faded').addClass('neighbor-edge')
}

function applySearchHighlight(cy: Core, searchQuery: string) {
  cy.elements().removeClass('highlighted faded neighbor neighbor-edge')
  const q = searchQuery.trim().toLowerCase()
  if (!q) return

  const matched = cy.nodes().filter((n) => {
    const label = String(n.data('label') || n.id() || '').toLowerCase()
    return label.includes(q)
  })
  if (!matched.length) return

  applyFocus(cy, matched)

  // Fit to match + neighbors so the 1-hop ring is visible, not just the hit.
  const focusSet = matched.union(matched.neighborhood())
  cy.fit(focusSet, 60)
}

export default function GraphView({ data, searchQuery, onSelectNode }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const cyRef = useRef<Core | null>(null)

  const handleFit = useCallback(() => { cyRef.current?.fit(undefined, 40) }, [])
  const handleZoomIn = useCallback(() => {
    const cy = cyRef.current; if (!cy) return
    cy.zoom({ level: cy.zoom() * 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
  }, [])
  const handleZoomOut = useCallback(() => {
    const cy = cyRef.current; if (!cy) return
    cy.zoom({ level: cy.zoom() / 1.3, renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } })
  }, [])

  useEffect(() => {
    if (!containerRef.current) return
    ;(async () => {
      await registerCose()

      const nodeCount = data.nodes.length
      const isLarge = nodeCount > 150
      const isHuge = nodeCount > 400

      const elements: cytoscape.ElementDefinition[] = []
      for (const node of data.nodes) {
        elements.push({
          group: 'nodes',
          data: {
            id: node.username,
            label: node.username,
            follower_count: node.follower_count,
            following_count: node.following_count,
            verified: node.verified,
            is_private: node.is_private,
            status: node.status,
          },
        })
      }
      for (const edge of data.edges) {
        elements.push({
          group: 'edges',
          data: {
            id: edge.id,
            source: edge.source,
            target: edge.target,
            mutual: edge.mutual,
            relationship_type: edge.relationship_type,
          },
        })
      }

      const cy = cytoscape({
        container: containerRef.current,
        elements,
        minZoom: 0.1,
        maxZoom: 4,
        pixelRatio: isHuge ? 1 : (isLarge ? 1.5 : 'auto'),
        textureOnViewport: isLarge,
        hideEdgesOnViewport: isHuge,
        hideLabelsOnViewport: isHuge,
        style: [
          {
            selector: 'node',
            style: {
              label: isHuge ? '' : 'data(label)',
              'font-size': isLarge ? '8px' : '10px',
              'text-valign': 'bottom',
              'text-margin-y': 4,
              color: '#d1d5db',
              width: (ele: any) => nodeSize(ele.data('follower_count')),
              height: (ele: any) => nodeSize(ele.data('follower_count')),
              'background-color': (ele: any) => STATUS_COLORS[ele.data('status')] ?? '#4e80ee',
              'border-width': (ele: any) => (ele.data('verified') ? 3 : 0),
              'border-color': '#3b82f6',
              opacity: (ele: any) => (ele.data('is_private') ? 0.5 : 1),
              shape: (ele: any) => (ele.data('status') === 'unavailable' ? 'diamond' : 'ellipse'),
            } as any,
          },
          {
            selector: 'edge',
            style: {
              width: (ele: any) => (ele.data('mutual') ? (isLarge ? 1.2 : 2.4) : (isLarge ? 0.8 : 1.5)),
              'curve-style': isLarge ? 'haystack' : 'bezier',
              'target-arrow-shape': isLarge ? 'none' : 'triangle',
              'target-arrow-color': (ele: any) => (ele.data('mutual') ? '#22c55e' : '#6b7280'),
              'line-color': (ele: any) => (ele.data('mutual') ? '#22c55e' : '#6b7280'),
              opacity: (ele: any) => (ele.data('mutual') ? (isLarge ? 0.45 : 0.85) : (isLarge ? 0.3 : 0.6)),
            } as any,
          },
          {
            selector: ':selected',
            style: {
              'border-width': 4,
              'border-color': '#f97316',
            },
          },
          {
            // Direct search / selection hit — strongest emphasis.
            selector: '.highlighted',
            style: {
              label: 'data(label)',
              'font-size': '11px',
              'font-weight': 600,
              'background-color': '#facc15',
              'border-width': 4,
              'border-color': '#f97316',
              'text-outline-width': 2,
              'text-outline-color': '#0f172a',
              color: '#f8fafc',
              opacity: 1,
              'z-index': 999,
            },
          },
          {
            // 1st-degree neighbors of a search hit or selection — softer highlight.
            selector: '.neighbor',
            style: {
              label: 'data(label)',
              'font-size': '10px',
              'background-color': '#38bdf8',
              'border-width': 2,
              'border-color': '#7dd3fc',
              'text-outline-width': 1,
              'text-outline-color': '#0f172a',
              color: '#e2e8f0',
              opacity: 0.92,
              'z-index': 500,
            },
          },
          {
            // Keep primary hit dominant when a node is both match and neighbor.
            selector: '.highlighted.neighbor',
            style: {
              'background-color': '#facc15',
              'border-width': 4,
              'border-color': '#f97316',
              opacity: 1,
              'z-index': 999,
            },
          },
          {
            selector: '.faded',
            style: { opacity: 0.08 },
          },
          {
            selector: '.neighbor-edge',
            style: {
              opacity: 0.85,
              width: 2.5,
              'line-color': '#38bdf8',
              'target-arrow-color': '#38bdf8',
              'z-index': 400,
            },
          },
        ],
        layout: {
          name: isLarge ? 'cose-bilkent' : 'cose-bilkent',
          animate: false,
          nodeRepulsion: isHuge ? 20000 : (isLarge ? 12000 : 8000),
          idealEdgeLength: isHuge ? 180 : (isLarge ? 140 : 120),
          nodeDimensionsIncludeLabels: !isHuge,
          numIter: isHuge ? 1000 : 2500,
          tile: true,
          tilingPaddingVertical: 20,
          tilingPaddingHorizontal: 20,
        } as any,
      })

      cy.on('tap', 'node', (evt: EventObject) => {
        const node = evt.target
        const username = node.data('id')
        onSelectNode?.(username)
        applyFocus(cy, node)
      })

      cy.on('tap', (evt: EventObject) => {
        if (evt.target === cy) {
          cy.elements().removeClass('highlighted faded neighbor neighbor-edge')
        }
      })

      cyRef.current = cy
      // Re-apply search after graph rebuild (data reload races the search effect).
      applySearchHighlight(cy, searchQuery)
    })()
    return () => { cyRef.current?.destroy(); cyRef.current = null }
  }, [data])

  useEffect(() => {
    const cy = cyRef.current
    if (!cy) return
    applySearchHighlight(cy, searchQuery)
  }, [searchQuery])

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <div className="graph-controls">
        <button onClick={handleFit} title="Fit graph">⊞</button>
        <button onClick={handleZoomIn} title="Zoom in">+</button>
        <button onClick={handleZoomOut} title="Zoom out">−</button>
      </div>
      <div
        ref={containerRef}
        className="graph-container"
        style={{ width: '100%', height: '100%', minHeight: 500, background: 'var(--bg-secondary)' }}
      />
    </div>
  )
}
