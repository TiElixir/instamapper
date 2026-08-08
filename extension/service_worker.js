const state = {
  api: 'http://127.0.0.1:8000',
  scanId: null,
  tabId: null,
  depth: 1,
  attached: false,
  queue: [],
  current: null,
  seenAccounts: new Set(),
  responseUrls: new Map(),
  responseMeta: new Map(),
  processedRequests: new Set(),
  collectedBySource: new Map(),
  pendingBodyReads: new Set(),
  advancing: false,
  captureGeneration: 0,
  captureInFlight: false,
  finishingAccount: false,
}

const DEBUGGER_VERSION = '1.3'
const USERNAME_RE = /^[A-Za-z0-9._]{1,30}$/
const RESERVED_PATHS = new Set([
  'explore', 'accounts', 'p', 'reel', 'reels', 'stories', 'direct',
  'about', 'privacy', 'terms', 'locations', 'api', 'jobs', 'help',
  'press', 'meta', 'verified', 'following', 'followers', 'posts',
  'tagged', 'saved', 'channel', 'live', 'directory', 'web', 'graphql',
  'inbox', 'notifications', 'nametag', 'create', 'share',
])
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))

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

function isLikelyFollowingResponseUrl(url) {
  if (!url) return false
  const lower = String(url).toLowerCase()

  // Hard excludes first — never treat these as following lists.
  if (/\/friendships\/[^/]+\/followers/i.test(lower)) return false
  if (/edge_followed_by|followed_by/i.test(lower) && !/edge_follow[^_a-z]/i.test(lower)) return false
  if (/\/web_profile_info|\/feed\/|\/timeline|\/media\/|\/clips\//i.test(lower)) {
    // Still allow if explicitly friendships/following.
    if (!/friendships|following/i.test(lower)) return false
  }

  if (/friendships\/[^/]+\/following/i.test(lower)) return true
  if (/\/api\/v1\/friendships\//i.test(lower) && /following/i.test(lower)) return true
  if (/\/api\/v1\/friendships\//i.test(lower)) return true
  if (/graphql/i.test(lower)) return true
  if (/\/ajax\//i.test(lower) && /follow/i.test(lower)) return true
  if (/[?&](query_hash|doc_id|fb_api_req_friendly_name|variables)=/i.test(lower)) return true
  if (/friendships/i.test(lower)) return true
  // Polaris / www endpoints sometimes omit "graphql" in the path.
  if (/instagram\.com\/api\//i.test(lower)) return true
  return false
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
    value.profile_pic_id != null
  )
}

function userFromObject(value) {
  const username = String(value.username ?? value.user_name).toLowerCase()
  const rawId = value.id ?? value.pk ?? value.pk_id ?? value.instagram_id ?? null
  return {
    username,
    instagram_id: rawId == null ? null : String(rawId),
  }
}

function pathSuggestsFollowing(path) {
  const lower = path.toLowerCase()
  if (/(?:^|\.)edge_followed_by(?:\.|\[|$)/.test(lower)) return false
  if (/(suggested|recommend|discover|similar|chain|seo_social|follow_requests)/i.test(lower)) return false
  if (/(?:^|\.)edge_follow(?:\.|\[|$)/.test(lower)) return true
  if (/(?:^|\.)following(?:\.|\[|$)/.test(lower)) return true
  if (/(?:^|\.)(users|items|sections|member_list|follow_list|relationships)(?:\.|\[|$)/.test(lower)) return true
  // GraphQL connection edges under many renamed fields.
  if (/(?:^|\.)edges(?:\.|\[|$)/.test(lower) && !/followed_by/.test(lower)) return true
  return false
}

function addFollowingUsers(value, path, output, opts = {}) {
  if (!value || typeof value !== 'object') return
  if (Array.isArray(value)) {
    value.forEach((item, index) => addFollowingUsers(item, `${path}[${index}]`, output, opts))
    return
  }

  if (looksLikeUserObject(value)) {
    if (opts.allowLoose || pathSuggestsFollowing(path) || path === '') {
      const user = userFromObject(value)
      output.set(user.username, user)
    }
  } else if (value.user && looksLikeUserObject(value.user)) {
    if (opts.allowLoose || pathSuggestsFollowing(path) || pathSuggestsFollowing(`${path}.user`)) {
      const user = userFromObject(value.user)
      output.set(user.username, user)
    }
  } else if (value.node && looksLikeUserObject(value.node)) {
    if (opts.allowLoose || pathSuggestsFollowing(path) || pathSuggestsFollowing(`${path}.node`)) {
      const user = userFromObject(value.node)
      output.set(user.username, user)
    }
  }

  for (const [key, child] of Object.entries(value)) {
    const nextPath = path ? `${path}.${key}` : key
    const lowerKey = key.toLowerCase()
    if (lowerKey === 'edge_followed_by') continue
    if (/(suggested|recommend|discover_more|similar_user|chaining|follow_request)/i.test(lowerKey)) continue
    addFollowingUsers(child, nextPath, output, opts)
  }
}

function extractFollowingUsers(payload, responseUrl = '') {
  const users = new Map()
  const lowerUrl = String(responseUrl || '').toLowerCase()
  const urlIsFollowingEndpoint =
    /friendships\/[^/]+\/following|\/following\/|follow_list|friendships\/[^/?]+\/following/i.test(lowerUrl)
  const urlIsFriendships = /\/friendships\//i.test(lowerUrl)
  const urlIsGraphql = /graphql|doc_id|query_hash|fb_api_req_friendly_name/i.test(lowerUrl)

  // Strict pass first.
  addFollowingUsers(payload, '', users, { allowLoose: false })

  // REST friendships following is often { users: [...], big_list, next_max_id }.
  if (!users.size && (urlIsFollowingEndpoint || urlIsFriendships)) {
    addFollowingUsers(payload, '', users, { allowLoose: true })
  }

  // GraphQL: accept loose user objects when the body mentions following-ish keys.
  if (!users.size && urlIsGraphql) {
    let blob = ''
    try {
      blob = JSON.stringify(payload).toLowerCase()
    } catch {
      blob = ''
    }
    const hasFollowingBranch =
      /edge_follow\b|"following"\s*:|friendship|"users"\s*:\s*\[|follow_list/.test(blob)
    // Avoid pure followers payloads.
    const followersOnly =
      /edge_followed_by/.test(blob) && !/edge_follow[^_a-z]/.test(blob) && !/"following"\s*:/.test(blob)
    if (hasFollowingBranch && !followersOnly) {
      addFollowingUsers(payload, '', users, { allowLoose: true })
    }
  }

  // Ultimate fallback: any Instagram API JSON that is clearly a user list while we
  // are actively capturing a Following dialog. Still skips follower-named URLs.
  if (!users.size && state.captureInFlight && !/followers/i.test(lowerUrl)) {
    if (Array.isArray(payload?.users) || Array.isArray(payload?.items)) {
      addFollowingUsers(payload, '', users, { allowLoose: true })
    }
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
    bucket.set(username, {
      username,
      instagram_id: user.instagram_id || prev?.instagram_id || null,
    })
  }
  state.collectedBySource.set(source, bucket)
  return added
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

async function startFollowingCapture() {
  if (state.tabId == null || !state.scanId || !state.current) return
  if (state.captureInFlight) return
  state.captureInFlight = true
  const generation = ++state.captureGeneration
  const username = state.current.username
  // Fresh collection bucket for this hop (keep any early DOM scraps if present).
  if (!state.collectedBySource.has(username)) {
    state.collectedBySource.set(username, new Map())
  }
  await logStatus(`Opening Following for @${username}`)
  const ready = await ensureContentScript(state.tabId)
  if (!ready) {
    state.captureInFlight = false
    await finishCurrentAccount('Could not inject content script into the Instagram tab')
    return
  }

  try {
    const response = await chrome.tabs.sendMessage(state.tabId, { type: 'OPEN_AND_SCROLL_FOLLOWING' })
    if (response && response.ok === false) {
      state.captureInFlight = false
      if (generation === state.captureGeneration) {
        await finishCurrentAccount(response.error || 'Following control was not found')
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
      const response = await chrome.tabs.sendMessage(state.tabId, { type: 'OPEN_AND_SCROLL_FOLLOWING' })
      if (response && response.ok === false && generation === state.captureGeneration) {
        state.captureInFlight = false
        await finishCurrentAccount(response.error || 'Following control was not found')
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

  state.current = next
  await logStatus(`Opening profile @${next.username}`)
  state.advancing = true
  const tab = await chrome.tabs.get(state.tabId)
  const current = usernameFromUrl(tab.url || '')
  if (current === next.username) {
    state.advancing = false
    await startFollowingCapture()
    return
  }
  await chrome.tabs.update(state.tabId, { url: `https://www.instagram.com/${next.username}/` })
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
      // Common: "No resource with given identifier found" if we read too early/late.
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
      // atob is fine for many payloads; large ones may need chunking.
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
  if (!isLikelyFollowingResponseUrl(responseUrl)) return
  if (state.processedRequests.has(requestId)) return

  // Skip non-JSON mime types early when known.
  const mime = String(meta.mimeType || '').toLowerCase()
  if (mime && !/json|javascript|text|octet-stream|empty/.test(mime) && !mime.includes('*')) {
    // Still try GraphQL-ish URLs.
    if (!/graphql|friendships|following/i.test(responseUrl)) return
  }

  state.processedRequests.add(requestId)

  let body
  try {
    body = await getResponseBodyWithRetry(requestId)
  } catch {
    // Body gone — not fatal; DOM scrape may still fill users.
    return
  }

  const raw = decodeBody(body)
  if (!raw) return

  // Some Instagram endpoints wrap JSON in for(;;); or return NDJSON-ish.
  let text = raw.trim()
  if (text.startsWith('for (;;);')) text = text.slice(9).trim()
  if (text.startsWith('while(1);')) text = text.slice(9).trim()

  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    // Try to find an embedded JSON object.
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

  const following = extractFollowingUsers(payload, responseUrl)
  if (!following.length || !state.current) return

  const source = state.current.username
  const added = mergeUsers(source, following)
  const total = state.collectedBySource.get(source)?.size || 0
  if (added > 0) {
    await logStatus(`@${source}: ${total} following captured so far (+${added} net)`)
  }
}

async function finishCurrentAccount(errorMessage = null, finalDomUsers = null) {
  if (!state.scanId || !state.current) return
  const source = state.current.username
  const depth = state.current.remaining_depth
  state.current = null
  state.captureInFlight = false
  state.captureGeneration += 1

  if (finalDomUsers?.length) {
    mergeUsers(source, finalDomUsers)
  }

  // Give the debugger stream time to flush late loadingFinished events.
  await sleep(2500)
  await Promise.all([...state.pendingBodyReads])
  await sleep(1000)
  await Promise.all([...state.pendingBodyReads])
  // One last DOM-merge window in case a final batch arrives concurrently.
  await sleep(400)

  const following = [...(state.collectedBySource.get(source)?.values() || [])]
  if (depth > 1) {
    for (const user of following) {
      if (state.seenAccounts.has(user.username)) continue
      state.seenAccounts.add(user.username)
      state.queue.push({ username: user.username, remaining_depth: depth - 1 })
    }
  }

  try {
    await sendApi(`/extension/scans/${state.scanId}/accounts`, {
      source_username: source,
      depth,
      following,
      pending: state.queue,
      ...(following.length
        ? {}
        : {
            error_type: errorMessage ? 'following_unavailable' : 'following_empty',
            error_message: errorMessage || 'Following list returned no explicit relationship users',
          }),
    })
  } catch (error) {
    await logStatus(`Ingest failed for @${source}: ${error.message}`)
  }

  await logStatus(
    errorMessage
      ? `@${source}: ${errorMessage}`
      : `Captured @${source}: ${following.length} following`,
  )

  state.collectedBySource.delete(source)
  state.advancing = false
  await navigateToNext()
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (source.tabId !== state.tabId) return

  if (method === 'Network.requestWillBeSent') {
    // Track early so we still know the URL if responseReceived is thin.
    const url = params.request?.url
    if (url) {
      state.responseUrls.set(params.requestId, url)
      state.responseMeta.set(params.requestId, {
        url,
        mimeType: null,
        status: null,
      })
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
  // /user/following/ still belongs to readyUsername === user
  if (readyUsername && readyUsername !== state.current.username) return
  setTimeout(() => {
    if (state.scanId && state.current) startFollowingCapture()
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
      const target = message.target.toLowerCase()
      state.queue = [{ username: target, remaining_depth: state.depth }]
      state.current = null
      state.seenAccounts = new Set([target])
      state.responseUrls.clear()
      state.responseMeta.clear()
      state.processedRequests.clear()
      state.collectedBySource.clear()
      state.captureGeneration += 1
      state.captureInFlight = false
      const result = await sendApi('/extension/scans', { target, depth: state.depth })
      state.scanId = result.scan_id
      await logStatus(`Scan #${state.scanId} started`)
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

    if (message.type === 'CAPTURE_CURRENT') {
      const tab = await activeTab()
      if (!tab.url || !tab.url.includes('instagram.com')) {
        throw new Error('Active tab must be Instagram')
      }
      state.api = (message.api || state.api).replace(/\/$/, '')
      const username = usernameFromUrl(tab.url) || message.target?.toLowerCase()
      if (!username) throw new Error('Open a profile page first')
      if (!state.scanId) {
        const result = await sendApi('/extension/scans', { target: username, depth: 1 })
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
      await startFollowingCapture()
      return { ok: true, message: `Capturing Following for @${username}` }
    }

    return { ok: false, error: 'Unknown command' }
  })()
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error.message }))
  return true
})

chrome.runtime.onMessage.addListener((message, sender) => {
  if (message.type === 'NAVIGATE_FOLLOWING') {
    const tabId = sender.tab?.id || state.tabId
    if (tabId == null) return
    const username = String(message.username || '').toLowerCase()
    const url = message.url || (username ? `https://www.instagram.com/${username}/following/` : null)
    if (!url) return
    state.captureInFlight = false
    logStatus(`Navigating to Following route for @${username || 'account'}`)
    chrome.tabs.update(tabId, { url }).catch((error) => console.warn('following navigate failed', error))
    return
  }

  if (message.type === 'FOLLOWING_DOM_BATCH') {
    const source =
      (message.source_username || state.current?.username || '').toLowerCase() || null
    if (!source || !state.scanId) return
    // Ignore batches for a different hop.
    if (state.current && state.current.username !== source) return
    const users = Array.isArray(message.following) ? message.following : []
    const added = mergeUsers(source, users)
    const total = state.collectedBySource.get(source)?.size || 0
    if (added > 0) {
      logStatus(`@${source}: ${total} following via DOM (+${added})`)
    }
    return
  }

  if (message.type === 'FOLLOWING_CAPTURE_DONE') {
    const finalUsers = Array.isArray(message.following) ? message.following : null
    if (message.ok) {
      finishCurrentAccount(null, finalUsers).catch((error) => console.warn('account finish failed', error))
    } else {
      finishCurrentAccount(message.error, finalUsers).catch((error) =>
        console.warn('account finish failed', error),
      )
    }
  }
})
