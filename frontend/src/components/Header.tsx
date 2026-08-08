interface Props {
  dark: boolean
  onToggleDark: () => void
  activeTab: 'graph' | 'scans'
  onTabChange: (tab: 'graph' | 'scans') => void
}

export default function Header({ dark, onToggleDark, activeTab, onTabChange }: Props) {
  return (
    <header className="app-header">
      <h1>InstaRL</h1>
      <nav>
        <button className={activeTab === 'graph' ? 'active' : ''} onClick={() => onTabChange('graph')}>Graph</button>
        <button className={activeTab === 'scans' ? 'active' : ''} onClick={() => onTabChange('scans')}>Scans</button>
      </nav>
      <button className="theme-toggle" onClick={onToggleDark} title="Toggle dark mode">
        {dark ? '🌞' : '🌙'}
      </button>
    </header>
  )
}
