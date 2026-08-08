import { useState } from 'react'

interface Props {
  onSearch: (query: string) => void
}

export default function SearchBar({ onSearch }: Props) {
  const [value, setValue] = useState('')

  return (
    <div className="search-bar">
      <input
        type="text"
        placeholder="Search nodes…"
        value={value}
        onChange={e => {
          setValue(e.target.value)
          onSearch(e.target.value)
        }}
      />
      {value && (
        <button className="clear-btn" onClick={() => { setValue(''); onSearch('') }}>✕</button>
      )}
    </div>
  )
}
