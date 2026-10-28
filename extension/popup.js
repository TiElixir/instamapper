const $ = (id) => document.getElementById(id)
const defaults = { api: 'http://127.0.0.1:8000', mode: 'following', maxFollowing: '' }

chrome.storage.local.get({ ...defaults, instarlStatus: 'Idle' }, (saved) => {
  $('api').value = saved.api
  $('mode').value = saved.mode || 'following'
  $('max-following').value = saved.maxFollowing || ''
  updateCaptureLabel()
  status(saved.instarlStatus)
})
function status(text, error = false) { $('status').textContent = text; $('status').style.color = error ? '#fca5a5' : '#93c5fd' }
function selectedMode() { return $('mode').value === 'followers' ? 'followers' : 'following' }
function selectedMaxFollowing() {
  const value = $('max-following').value.trim()
  return value ? Number(value) : null
}
function updateCaptureLabel() {
  $('capture').textContent = `Capture current ${selectedMode() === 'followers' ? 'Followers' : 'Following'} list`
}
async function send(message) {
  const response = await chrome.runtime.sendMessage(message)
  if (!response?.ok) throw new Error(response?.error || 'Extension request failed')
  return response
}
$('mode').onchange = () => updateCaptureLabel()
$('start').onclick = async () => {
  try {
    const api = $('api').value.replace(/\/$/, '')
    const target = $('target').value.trim().toLowerCase()
    const depth = Number($('depth').value)
    const mode = selectedMode()
    const maxFollowing = selectedMaxFollowing()
    if (!target) throw new Error('Enter a starting username')
    if (maxFollowing != null && (!Number.isFinite(maxFollowing) || maxFollowing < 1)) {
      throw new Error('Max following must be a positive number')
    }
    await chrome.storage.local.set({ api, mode, maxFollowing: maxFollowing == null ? '' : String(maxFollowing) })
    const result = await send({ type: 'START_SCAN', api, target, depth, mode, maxFollowing })
    status(`Capturing ${mode} scan #${result.scan_id}. Open Instagram.`)
  } catch (error) { status(error.message, true) }
}
$('stop').onclick = async () => { try { await send({ type: 'STOP_SCAN' }); status('Capture stopped') } catch (error) { status(error.message, true) } }
$('skip').onclick = async () => {
  try {
    const result = await send({ type: 'SKIP_CURRENT' })
    status(result.message || 'Skipped current user')
  } catch (error) {
    status(error.message, true)
  }
}
$('capture').onclick = async () => {
  try {
    const api = $('api').value.replace(/\/$/, '')
    const target = $('target').value.trim().toLowerCase()
    const mode = selectedMode()
    await chrome.storage.local.set({ api, mode })
    const result = await send({ type: 'CAPTURE_CURRENT', api, target: target || undefined, mode })
    status(result.message || `Capturing current ${mode} list`)
  } catch (error) {
    status(error.message, true)
  }
}
setInterval(() => chrome.storage.local.get({ instarlStatus: 'Idle' }, (saved) => status(saved.instarlStatus)), 1000)
