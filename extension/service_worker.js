const state = {
  api: 'http://127.0.0.1:8000',
  scanId: null,
  tabId: null,
  depth: 1,
  mode: 'following',
  maxFollowing: null,
  attached: false,
  queue: [],
  current: null,
  seenAccounts: new Set(),
  responseUrls: new Map(),
  responseMeta: new Map(),
  processedRequests: new Set(),
  collectedBySource: new Map(),
  profileCounts: new Map(),
  pendingBodyReads: new Set(),
  advancing: false,
  captureGeneration: 0,
  captureInFlight: false,
  finishingAccount: false,
}

const DEBUGGER_VERSION = '1.3'
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/
const RELATIONSHIP_MODES = new Set(['following', 'followers'])
const RESERVED_PATHS = new Set([
  'explore', 'accounts', 'p', 'reel', 'reels', 'stories', 'direct',
  'about', 'privacy', 'terms', 'locations', 'api', 'jobs', 'help',
  'press', 'meta', 'verified', 'following', 'followers', 'posts',
  'tagged', 'saved', 'channel', 'live', 'directory', 'web', 'graphql',
  'inbox', 'notifications', 'nametag', 'create', 'share',
])
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

function scanMode(value) {
  return RELATIONSHIP_MODES.has(value) ? value : 'following'
}

function modeLabel(mode = state.mode) {
  return mode === 'followers' ? 'Followers' : 'Following'
}

async function logStatus(message) {
  await chrome.storage.local.set({ instarlStatus: message, instarlStatusAt: Date.now() })
}

async function sendApi(path, body, method = 'POST') {
  const response = await fetch(`${state.api}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  return response.json()
}

async function activeTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
  const tab = tabs[0]
  if (!tab?.id) throw new Error('No active browser tab')
  return tab
}

async function attach(tabId) {
  if (state.attached && state.tabId === tabId) return
  if (state.attached) await detach()
  await chrome.debugger.attach({ tabId }, DEBUGGER_VERSION)
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable', {
    maxResourceBufferSize: 100 * 1024 * 1024,
    maxTotalBufferSize: 200 * 1024 * 1024,
  })
  // Extra coverage for service workers / fetch that Instagram may use.
  try {
    await chrome.debugger.sendCommand({ tabId }, 'Network.setCacheDisabled', { cacheDisabled: false })
  } catch {}
  state.tabId = tabId
  state.attached = true
}

async function detach() {
  if (state.attached && state.tabId != null) {
    try { await chrome.debugger.detach({ tabId: state.tabId }) } catch {}
  }
  state.attached = false
  state.tabId = null
  state.responseUrls.clear()
  state.responseMeta.clear()
}

function usernameFromUrl(url) {
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.endsWith('instagram.com')) return null
    const candidate = (parsed.pathname.split('/').filter(Boolean)[0] || '').toLowerCase()
    if (!USERNAME_RE.test(candidate) || RESERVED_PATHS.has(candidate)) return null
    return candidate
  } catch {
    return null
  }
}

function isLikelyRelationshipResponseUrl(url) {
  if (!url) return false
  try {
    const parsed = new URL(url)
    if (!parsed.hostname.endsWith('instagram.com')) return false
    // Network capture is intentionally strict: only the active relationship-list
    // endpoint is allowed to create edges. GraphQL, profile, feed, suggestions,
    // and generic API responses can contain unrelated users and must never be
    // treated as immediate follower/following relationships.
    return new RegExp(`^/api/v1/friendships/[^/]+/${state.mode}/?$`, 'i').test(parsed.pathname)
  } catch {
    return new RegExp(`/api/v1/friendships/[^/]+/${state.mode}/?(?:[?#]|$)`, 'i').test(String(url))
  }
}

function looksLikeUserObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const username = value.username ?? value.user_name
  if (typeof username !== 'string' || !USERNAME_RE.test(username)) return false
  return (
    value.id != null ||
    value.pk != null ||
    value.pk_id != null ||
    value.profile_pic_url != null ||
    value.full_name != null ||
    value.is_private != null ||
    value.is_verified != null ||
    value.latest_reel_media != null ||
    value.has_anonymous_profile_picture != null ||
    value.profile_pic_id != null ||
    value.edge_follow != null ||
    value.following_count != null
  )
}

function userFromObject(value) {
  const username = String(value.username ?? value.user_name).toLowerCase()
  const rawId = value.id ?? value.pk ?? value.pk_id ?? value.instagram_id ?? null
  const followingCount =
    value.following_count ??
    value.following ??
    value.edge_follow?.count ??
    value.relationship_counts?.following ??
    null
  return {
    username,
    instagram_id: rawId == null ? null : String(rawId),
    following_count: Number.isFinite(Number(followingCount)) ? Number(followingCount) : null,
  }
}

function pathSuggestsRelationship(path) {
  const lower = path.toLowerCase()
  if (/(suggested|recommend|discover|similar|chain|seo_social|follow_requests)/i.test(lower)) return false
  if (state.mode === 'followers') {
    if (/(?:^|\.)edge_followed_by(?:\.|\[|$)/.test(lower)) return true
    if (/(?:^|\.)(followers|followed_by)(?:\.|\[|$)/.test(lower)) return true
  } else {
    if (/(?:^|\.)edge_followed_by(?:\.|\[|$)/.test(lower)) return false
    if (/(?:^|\.)edge_follow(?:\.|\[|$)/.test(lower)) return true
    if (/(?:^|\.)following(?:\.|\[|$)/.test(lower)) return true
  }
  if (/(?:^|\.)(users|items|sections|member_list|follow_list|relationships)(?:\.|\[|$)/.test(lower)) return true
  if (/(?:^|\.)edges(?:\.|\[|$)/.test(lower)) return true
  return false
}

function addRelationshipUsers(value, path, output, opts = {}) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => addRelationshipUsers(item, `${path}[${index}]`, output, opts))
    return
  }

  if (looksLikeUserObject(value)) {
    if (opts.allowLoose || pathSuggestsRelationship(path) || path === '') {
      const user = userFromObject(value)
      output.set(user.username, user)
    }
  } else if (value.user && looksLikeUserObject(value.user)) {
    if (opts.allowLoose || pathSuggestsRelationship(path) || pathSuggestsRelationship(`${path}.user`)) {
      const user = userFromObject(value.user)
      output.set(user.username, user)
    }
  } else if (value.node && looksLikeUserObject(value.node)) {
    if (opts.allowLoose || pathSuggestsRelationship(path) || pathSuggestsRelationship(`${path}.node`)) {
      const user = userFromObject(value.node)
      output.set(user.username, user)
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key
    const lowerKey = key.toLowerCase()
    if (state.mode === 'following' && lowerKey === 'edge_followed_by') continue
    if (state.mode === 'followers' && lowerKey === 'edge_follow') continue
    if (/(suggested|recommend|discover_more|similar_user|chaining|follow_request)/i.test(lowerKey)) continue
    addRelationshipUsers(child, nextPath, output, opts)
  }
}

function extractRelationshipUsers(payload, responseUrl = '') {
  if (!isLikelyRelationshipResponseUrl(responseUrl)) return []
  const directUsers = Array.isArray(payload?.users)
    ? payload.users
    : Array.isArray(payload?.items)
      ? payload.items
      : []
  const users = new Map()

  for (const item of directUsers) {
    const candidate = looksLikeUserObject(item)
      ? item
      : item?.user && looksLikeUserObject(item.user)
        ? item.user
        : item?.node && looksLikeUserObject(item.node)
          ? item.node
          : null
    if (!candidate) continue
    const user = userFromObject(candidate)
    if (!user.username || RESERVED_PATHS.has(user.username)) continue
    users.set(user.username, user)
  }

  return [...users.values()]
}

function mergeUsers(source, users) {
  if (!source || !users?.length) return 0
  const bucket = state.collectedBySource.get(source) || new Map()
  let added = 0
  for (const user of users) {
    const username = String(user.username || '').toLowerCase()
    if (!username || !USERNAME_RE.test(username)) continue
    if (username === source || RESERVED_PATHS.has(username)) continue
    if (!bucket.has(username)) added += 1
    const prev = bucket.get(username)
    const rawFollowerCount = user.follower_count ?? user.followerCount ?? prev?.follower_count ?? null
    const rawFollowingCount = user.following_count ?? user.followingCount ?? prev?.following_count ?? null
    bucket.set(username, {
      username,
      instagram_id: user.instagram_id || prev?.instagram_id || null,
      follower_count: Number.isFinite(Number(rawFollowerCount)) ? Number(rawFollowerCount) : null,
      following_count: Number.isFinite(Number(rawFollowingCount)) ? Number(rawFollowingCount) : null,
    })
  }
  state.collectedBySource.set(source, bucket)
  return added
}

function mergeProfileCounts(user, profile) {
  if (!user || !profile) return user
  return {
    ...user,
    instagram_id: user.instagram_id || profile.instagram_id || null,
    follower_count: user.follower_count ?? profile.follower_count ?? null,
    following_count: user.following_count ?? profile.following_count ?? null,
  }
}

function shouldQueue(user) {
  if (state.maxFollowing == null) return true
  if (user.following_count == null) return true
  return Number(user.following_count) <= state.maxFollowing
}

async function fetchProfileCounts(username) {
  const key = String(username || '').toLowerCase()
  if (!key || !state.tabId) return null
  if (state.profileCounts.has(key)) return state.profileCounts.get(key)
  const response = await chrome.tabs.sendMessage(state.tabId, { type: 'GET_PROFILE_COUNTS', username: key })
  if (!response?.ok || !response.profile) throw new Error(response?.error || `Could not fetch counts for @${key}`)
  const profile = response.profile
  state.profileCounts.set(key, profile)
  return profile
}

async function shouldScanQueuedUser(user) {
  if (state.maxFollowing == null) return { scan: true, user }
  if (user.remaining_depth === state.depth) return { scan: true, user }
  if (user.following_count != null) return { scan: Number(user.following_count) <= state.maxFollowing, user }
  try {
    const profile = await fetchProfileCounts(user.username)
    const merged = mergeProfileCounts(user, profile)
    return { scan: merged.following_count == null || Number(merged.following_count) <= state.maxFollowing, user: merged }
  } catch (error) {
    await logStatus(`Skipping @${user.username}: could not check following count (${error.message})`)
    return { scan: false, user, error: error.message }
  }
}

async function ensureContentScript(tabId) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'INSTARL_PING' })
    if (pong?.ok) return true
  } catch {}
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content.js'],
    })
    await sleep(300)
    const pong = await chrome.tabs.sendMessage(tabId, { type: 'INSTARL_PING' })
    return Boolean(pong?.ok)
  } catch (error) {
    await logStatus(`Content script inject failed: ${error.message}`)
    return false
  }
}

async function startRelationshipCapture() {
  if (state.tabId == null || !state.scanId || !state.current) return
  if (state.captureInFlight) return
  state.captureInFlight = true
  const generation = ++state.captureGeneration
  const username = state.current.username
  if (!state.collectedBySource.has(username)) {
    state.collectedBySource.set(username, new Map())
  }
  await logStatus(`Opening ${modeLabel()} for @${username}`)
  const ready = await ensureContentScript(state.tabId)
  if (!ready) {
    state.captureInFlight = false
    await finishCurrentAccount('Could not inject content script into the Instagram tab')
    return
  }

  const sendCaptureMessage = () => chrome.tabs.sendMessage(state.tabId, {
    type: 'OPEN_AND_SCROLL_RELATIONSHIPS',
    mode: state.mode,
  })

  try {
    const response = await sendCaptureMessage()
    if (response && response.ok === false) {
      state.captureInFlight = false
      if (generation === state.captureGeneration) {
        await finishCurrentAccount(response.error || `${modeLabel()} control was not found`)
      }
      return
    }
    setTimeout(() => {
      if (state.captureGeneration === generation && state.captureInFlight) {
        state.captureInFlight = false
      }
    }, 240000)
  } catch (error) {
    await sleep(1500)
    if (generation !== state.captureGeneration || !state.scanId) {
      state.captureInFlight = false
      return
    }
    try {
      await ensureContentScript(state.tabId)
      const response = await sendCaptureMessage()
      if (response && response.ok === false && generation === state.captureGeneration) {
        state.captureInFlight = false
        await finishCurrentAccount(response.error || `${modeLabel()} control was not found`)
        return
      }
      setTimeout(() => {
        if (state.captureGeneration === generation && state.captureInFlight) {
          state.captureInFlight = false
        }
      }, 240000)
    } catch (retryError) {
      state.captureInFlight = false
      if (generation === state.captureGeneration) {
        await finishCurrentAccount(retryError.message)
      }
    }
  }
}

async function navigateToNext() {
  if (state.advancing || !state.scanId) return

  while (state.scanId) {
    const next = state.queue.shift()
    if (!next) {
      await logStatus('Scan complete')
      await sendApi(`/extension/scans/${state.scanId}/finish`, { status: 'completed' })
      state.scanId = null
      state.current = null
      state.captureGeneration += 1
      await detach()
      return
    }

    const decision = await shouldScanQueuedUser(next)
    if (!decision.scan) {
      await logStatus(`Skipped @${next.username}: following count over limit or unavailable`)
      continue
    }

    state.current = decision.user
    await logStatus(`Opening profile @${decision.user.username}`)
    state.advancing = true
    const tab = await chrome.tabs.get(state.tabId)
    const current = usernameFromUrl(tab.url || '')
    if (current === decision.user.username) {
      state.advancing = false
      await startRelationshipCapture()
      return
    }
    await chrome.tabs.update(state.tabId, { url: `https://www.instagram.com/${decision.user.username}/` })
    return
  }
}

async function getResponseBodyWithRetry(requestId, attempts = 6) {
  let lastError = null
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const body = await chrome.debugger.sendCommand(
        { tabId: state.tabId },
        'Network.getResponseBody',
        { requestId },
      )
      if (body?.body != null && body.body !== '') return body
    } catch (error) {
      lastError = error
    }
    await sleep(120 + attempt * 80)
  }
  if (lastError) throw lastError
  return null
}

function decodeBody(body) {
  if (!body) return null
  let raw = body.body
  if (body.base64Encoded && raw) {
    try {
      raw = atob(raw)
    } catch {
      try {
        const binary = atob(raw)
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
        raw = new TextDecoder('utf-8').decode(bytes)
      } catch {
        return null
      }
    }
  }
  return raw || null
}

async function ingestResponse(requestId, responseUrl, meta = {}) {
  if (!state.scanId || state.tabId == null || !responseUrl) return
  if (!isLikelyRelationshipResponseUrl(responseUrl)) return
  if (state.processedRequests.has(requestId)) return

  const mime = String(meta.mimeType || '').toLowerCase()
  if (mime && !/json|javascript|text|octet-stream|empty/.test(mime) && !mime.includes('*')) {
    if (!/graphql|friendships|follow/i.test(responseUrl)) return
  }

  state.processedRequests.add(requestId)

  let body
  try {
    body = await getResponseBodyWithRetry(requestId)
  } catch {
    return
  }

  const raw = decodeBody(body)
  if (!raw) return

  let text = raw.trim()
  if (text.startsWith('for (;;);')) text = text.slice(9).trim()
  if (text.startsWith('while(1);')) text = text.slice(9).trim()

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start >= 0 && end > start) {
      try {
        payload = JSON.parse(text.slice(start, end + 1))
      } catch {
        return
      }
    } else {
      return
    }
  }

  const users = extractRelationshipUsers(payload, responseUrl)
  if (!users.length || !state.current) return

  const source = state.current.username
  const added = mergeUsers(source, users)
  const total = state.collectedBySource.get(source)?.size || 0
  if (added > 0) {
    await logStatus(`@${source}: ${total} ${state.mode} captured so far (+${added} net)`)
  }
}

async function finishCurrentAccount(errorMessage = null, finalDomUsers = null, skipped = false) {
  if (!state.scanId || !state.current) return
  const currentAccount = state.current
  const source = currentAccount.username
  const depth = currentAccount.remaining_depth
  state.current = null
  state.captureInFlight = false
  state.captureGeneration += 1

  if (finalDomUsers?.length) {
    mergeUsers(source, finalDomUsers)
  }

  if (!skipped) {
    await sleep(2500)
    await Promise.all([...state.pendingBodyReads])
    await sleep(1000)
    await Promise.all([...state.pendingBodyReads])
    await sleep(400)
  }

  const relationships = [...(state.collectedBySource.get(source)?.values() || [])]
  let filtered = 0
  if (!skipped && depth > 1) {
    for (const user of relationships) {
      if (!shouldQueue(user)) {
        filtered += 1
        continue
      }
      if (state.seenAccounts.has(user.username)) continue
      state.seenAccounts.add(user.username)
      state.queue.push({
        username: user.username,
        remaining_depth: depth - 1,
        follower_count: user.follower_count ?? null,
        following_count: user.following_count ?? null,
      })
    }
  }

  try {
    await sendApi(`/extension/scans/${state.scanId}/accounts`, {
      source_username: source,
      depth,
      mode: state.mode,
      source_instagram_id: currentAccount.instagram_id || null,
      source_follower_count: currentAccount.follower_count ?? null,
      source_following_count: currentAccount.following_count ?? null,
      following: relationships,
      pending: state.queue,
      ...(skipped
        ? { error_type: 'skipped', error_message: 'Skipped by user' }
        : relationships.length
          ? {}
          : {
              error_type: errorMessage ? `${state.mode}_unavailable` : `${state.mode}_empty`,
              error_message: errorMessage || `${modeLabel()} list returned no explicit relationship users`,
            }),
    })
  } catch (error) {
    await logStatus(`Ingest failed for @${source}: ${error.message}`)
  }

  await logStatus(
    skipped
      ? `Skipped @${source}`
      : errorMessage
        ? `@${source}: ${errorMessage}`
        : `Captured @${source}: ${relationships.length} ${state.mode}${filtered ? ` (${filtered} over threshold skipped)` : ''}`,
  )

  state.collectedBySource.delete(source)
  state.advancing = false
  await navigateToNext()
}

async function skipCurrentAccount() {
  if (!state.scanId || !state.current) throw new Error('No active scan user to skip')
  const skipped = state.current.username
  state.captureInFlight = false
  state.captureGeneration += 1
  await finishCurrentAccount(null, null, true)
  return skipped
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== state.tabId) return

  if (method === 'Network.requestWillBeSent') {
    const url = params.request?.url
    if (url) {
      state.responseUrls.set(params.requestId, url)
      state.responseMeta.set(params.requestId, { url, mimeType: null, status: null })
    }
    return
  }

  if (method === 'Network.responseReceived') {
    const url = params.response?.url || state.responseUrls.get(params.requestId)
    if (url) state.responseUrls.set(params.requestId, url)
    state.responseMeta.set(params.requestId, {
      url,
      mimeType: params.response?.mimeType || null,
      status: params.response?.status || null,
    })
    return
  }

  if (method === 'Network.loadingFinished') {
    const meta = state.responseMeta.get(params.requestId) || {}
    const url = state.responseUrls.get(params.requestId) || meta.url
    state.responseUrls.delete(params.requestId)
    state.responseMeta.delete(params.requestId)
    const read = ingestResponse(params.requestId, url, meta).catch((error) =>
      console.warn('response processing failed', error),
    )
    state.pendingBodyReads.add(read)
    read.finally(() => state.pendingBodyReads.delete(read))
  }
})

chrome.debugger.onDetach.addListener(() => {
  state.attached = false
  state.tabId = null
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (tabId !== state.tabId || !state.scanId || !state.current) return
  if (changeInfo.status !== 'complete') return
  state.advancing = false
  const pageUrl = changeInfo.url || tab?.url || ''
  const readyUsername = usernameFromUrl(pageUrl)
  if (readyUsername && readyUsername !== state.current.username) return
  setTimeout(() => {
    if (state.scanId && state.current) startRelationshipCapture()
  }, 1200)
})

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) detach()
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  ;(async () => {
    if (message.type === 'START_SCAN') {
      state.api = message.api.replace(/\/$/, '')
      state.depth = Number(message.depth)
      state.mode = scanMode(message.mode)
      state.maxFollowing = message.maxFollowing == null ? null : Number(message.maxFollowing)
      if (!Number.isFinite(state.maxFollowing)) state.maxFollowing = null
      const target = message.target.toLowerCase()
      state.queue = [{ username: target, remaining_depth: state.depth }]
      state.current = null
      state.seenAccounts = new Set([target])
      state.responseUrls.clear()
      state.responseMeta.clear()
      state.processedRequests.clear()
      state.collectedBySource.clear()
      state.profileCounts.clear()
      state.captureGeneration += 1
      state.captureInFlight = false
      const result = await sendApi('/extension/scans', { target, depth: state.depth, mode: state.mode })
      state.scanId = result.scan_id
      await logStatus(`Scan #${state.scanId} started (${state.mode})`)
      const tab = await activeTab()
      if (!tab.url || !tab.url.includes('instagram.com')) {
        throw new Error('Active tab must be Instagram (www.instagram.com)')
      }
      await attach(tab.id)
      state.tabId = tab.id
      await ensureContentScript(tab.id)
      await navigateToNext()
      return { ok: true, scan_id: state.scanId }
    }

    if (message.type === 'STOP_SCAN') {
      state.captureGeneration += 1
      if (state.scanId) {
        try {
          await sendApi(`/extension/scans/${state.scanId}/finish`, { status: 'cancelled' })
        } catch {}
      }
      state.scanId = null
      state.queue = []
      state.current = null
      await detach()
      await logStatus('Capture stopped')
      return { ok: true }
    }

    if (message.type === 'SKIP_CURRENT') {
      const skipped = await skipCurrentAccount()
      return { ok: true, message: `Skipped @${skipped}` }
    }

    if (message.type === 'CAPTURE_CURRENT') {
      const tab = await activeTab()
      if (!tab.url || !tab.url.includes('instagram.com')) {
        throw new Error('Active tab must be Instagram')
      }
      state.api = (message.api || state.api).replace(/\/$/, '')
      state.mode = scanMode(message.mode)
      const username = usernameFromUrl(tab.url) || message.target?.toLowerCase()
      if (!username) throw new Error('Open a profile page first')
      if (!state.scanId) {
        const result = await sendApi('/extension/scans', { target: username, depth: 1, mode: state.mode })
        state.scanId = result.scan_id
        state.depth = 1
        state.seenAccounts = new Set([username])
        state.queue = []
      }
      await attach(tab.id)
      state.tabId = tab.id
      state.current = { username, remaining_depth: 1 }
      state.collectedBySource.set(username, state.collectedBySource.get(username) || new Map())
      await ensureContentScript(tab.id)
      await startRelationshipCapture()
      return { ok: true, message: `Capturing ${modeLabel()} for @${username}` }
    }

    return { ok: false, error: 'Unknown command' }
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }))
  return true
})

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'NAVIGATE_RELATIONSHIPS' || message.type === 'NAVIGATE_FOLLOWING') {
    const tabId = sender.tab?.id || state.tabId
    if (tabId == null) return
    const username = String(message.username || '').toLowerCase()
    const mode = scanMode(message.mode || state.mode)
    const url = message.url || (username ? `https://www.instagram.com/${username}/${mode}/` : null)
    if (!url) return
    state.captureInFlight = false
    logStatus(`Navigating to ${modeLabel(mode)} route for @${username || 'account'}`)
    chrome.tabs.update(tabId, { url }).catch((error) => console.warn(`${mode} navigate failed`, error))
    return
  }

  if (message.type === 'RELATIONSHIP_DOM_BATCH' || message.type === 'FOLLOWING_DOM_BATCH') {
    const source = (message.source_username || state.current?.username || '').toLowerCase() || null
    if (!source || !state.scanId) return
    if (state.current && state.current.username !== source) return
    const messageMode = scanMode(message.mode || state.mode)
    if (messageMode !== state.mode) return
    const users = Array.isArray(message.users) ? message.users : (Array.isArray(message.following) ? message.following : [])
    const added = mergeUsers(source, users)
    const total = state.collectedBySource.get(source)?.size || 0
    if (added > 0) {
      logStatus(`@${source}: ${total} ${messageMode} via DOM (+${added})`)
    }
    return
  }

  if (message.type === 'RELATIONSHIP_CAPTURE_DONE' || message.type === 'FOLLOWING_CAPTURE_DONE') {
    const finalUsers = Array.isArray(message.users) ? message.users : (Array.isArray(message.following) ? message.following : null)
    if (message.ok) {
      finishCurrentAccount(null, finalUsers).catch((error) => console.warn('account finish failed', error))
    } else {
      finishCurrentAccount(message.error, finalUsers).catch((error) =>
        console.warn('account finish failed', error),
      )
    }
  }
})
