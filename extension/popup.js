const $ = (id) => document.getElementById(id)
const defaults = { api: 'http://127.0.0.1:8000' }

chrome.storage.local.get({ ...defaults, instarlStatus: 'Idle' }, (saved) => {
  $('api').value = saved.api
  status(saved.instarlStatus)
})
function status(text, error = false) { $('status').textContent = text; $('status').style.color = error ? '#fca5a5' : '#93c5fd' }
async function send(message) {
  const response = await chrome.runtime.sendMessage(message)
  if (!response?.ok) throw new Error(response?.error || 'Extension request failed')
  return response
}
$('start').onclick = async () => {
  try {
    const api = $('api').value.replace(/\/$/, '')
    const target = $('target').value.trim().toLowerCase()
    const depth = Number($('depth').value)
    if (!target) throw new Error('Enter a starting username')
    await chrome.storage.local.set({ api })
    const result = await send({ type: 'START_SCAN', api, target, depth })
    status(`Capturing scan #${result.scan_id}. Open Instagram.`)
  } catch (error) { status(error.message, true) }
}
$('stop').onclick = async () => { try { await send({ type: 'STOP_SCAN' }); status('Capture stopped') } catch (error) { status(error.message, true) } }
$('capture').onclick = async () => {
  try {
    const api = $('api').value.replace(/\/$/, '')
    const target = $('target').value.trim().toLowerCase()
    await chrome.storage.local.set({ api })
    const result = await send({ type: 'CAPTURE_CURRENT', api, target: target || undefined })
    status(result.message || 'Capturing current Following list')
  } catch (error) {
    status(error.message, true)
  }
}
setInterval(() => chrome.storage.local.get({ instarlStatus: 'Idle' }, (saved) => status(saved.instarlStatus)), 1000)
