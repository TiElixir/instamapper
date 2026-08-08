declare module 'cytoscape-cose-bilkent' {
  import cytoscape from 'cytoscape'
  const register: (instance: typeof cytoscape) => void
  export default register
}
