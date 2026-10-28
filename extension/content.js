(() => {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const USERNAME_RE = /^[a-z0-9._]{1,30}$/
  const RELATIONSHIP_MODES = new Set(['following', 'followers'])
  const RESERVED = new Set([
    'explore', 'accounts', 'p', 'reel', 'reels', 'stories', 'direct',
    'about', 'privacy', 'terms', 'locations', 'api', 'jobs', 'help',
    'press', 'meta', 'verified', 'following', 'followers', 'posts',
    'tagged', 'saved', 'channel', 'live', 'directory', 'web', 'graphql',
    'inbox', 'notifications', 'nametag', 'create', 'share',
  ])

  // Hard caps so a virtualized list can never spin forever.
  const SCROLL_MAX_ATTEMPTS = 90
  const SCROLL_MAX_MS = 90_000
  const NO_GROWTH_EXIT = 5
  const BOTTOM_EXIT = 4

  function scanMode(value) {
    return RELATIONSHIP_MODES.has(value) ? value : 'following'
  }

  function modeLabel(mode) {
    return mode === 'followers' ? 'Followers' : 'Following'
  }

  function profileUsername() {
    const path = (location.pathname || '').split('/').filter(Boolean)
    if (!path.length) return null
    const candidate = path[0].toLowerCase()
    if (RESERVED.has(candidate)) return null
    if (!USERNAME_RE.test(candidate)) return null
    return candidate
  }

  function normalizeText(value) {
    return (value || '').replace(/\s+/g, ' ').trim().toLowerCase()
  }

  function usernameFromHref(href) {
    if (!href) return null
    try {
      const url = new URL(href, location.origin)
      if (url.hostname && !url.hostname.endsWith('instagram.com')) return null
      let parts = url.pathname.split('/').filter(Boolean)
      if (!parts.length) return null
      if (parts[0].toLowerCase() === '_u' && parts[1]) parts = parts.slice(1)
      const head = parts[0].toLowerCase()
      if (RESERVED.has(head) || !USERNAME_RE.test(head)) return null
      if (parts.length >= 2) {
        const second = parts[1].toLowerCase()
        if (!['following', 'followers', 'reels', 'tagged', 'saved'].includes(second)) {
          if (['p', 'reel', 'reels', 'tv', 'stories', 'live', 'channel'].includes(second)) return null
        }
      }
      return head
    } catch {
      return null
    }
  }

  function isListHref(href, mode = 'following') {
    if (!href) return false
    try {
      const url = new URL(href, location.origin)
      if (url.hostname && !url.hostname.endsWith('instagram.com')) return false
      return new RegExp(`/${mode}/?(?:$|\\?)`).test(url.pathname)
    } catch {
      return new RegExp(`/${mode}/?(?:\\?|$)`).test(href)
    }
  }

  function isFollowingHref(href) { return isListHref(href, 'following') }
  function isFollowersHref(href) { return isListHref(href, 'followers') }

  function isOptionsOrMenuControl(node) {
    if (!node || node.nodeType !== 1) return true
    const label = normalizeText(
      [
        node.getAttribute?.('aria-label'),
        node.getAttribute?.('title'),
        node.getAttribute?.('alt'),
      ]
        .filter(Boolean)
        .join(' '),
    )
    if (/(options|more options|more|menu|settings|see more|ellipsis|overflow)/i.test(label)) {
      return true
    }
    const text = normalizeText(node.textContent)
    const tag = node.tagName
    if ((tag === 'BUTTON' || node.getAttribute?.('role') === 'button') && !text) {
      if (node.querySelector?.('svg') && !isFollowingHref(node.getAttribute?.('href') || '')) {
        return true
      }
    }
    if (/^[⋅·•⋯⋮…]+$/.test(text)) return true
    if (text === 'options' || text === 'more') return true
    return false
  }

  function isRelationshipCta(node) {
    if (!node) return false
    const href = node.getAttribute?.('href') || ''
    if (isFollowingHref(href) || isFollowersHref(href)) return false
    const text = normalizeText(node.textContent)
    const label = normalizeText(node.getAttribute?.('aria-label'))
    const combined = `${text} ${label}`
    if (/^(follow|following|requested|unfollow|message|email|subscribe)$/i.test(text)) return true
    if (/\b(follow|following|requested|unfollow)\b/i.test(label) && !/\d/.test(combined)) {
      if (!isFollowingHref(href) && !isFollowersHref(href)) return true
    }
    return false
  }

  function clickableAncestor(node) {
    let current = node
    while (current && current !== document.body) {
      if (current.matches?.('a[href]')) return current
      if (current.matches?.('button, [role="link"], [role="button"]')) {
        if (!isOptionsOrMenuControl(current) && !isRelationshipCta(current)) return current
      }
      current = current.parentElement
    }
    return node
  }

  function relationshipLink(mode = 'following') {
    const username = profileUsername()
    const anchors = [...document.querySelectorAll('a[href]')]

    if (username) {
      const scoped = anchors.find((node) => {
        if (isOptionsOrMenuControl(node) || isRelationshipCta(node)) return false
        const href = (node.getAttribute('href') || '').toLowerCase()
        return isListHref(href, mode) && href.includes(`/${username}/${mode}`)
      })
      if (scoped) return scoped
    }

    const byHref = anchors.find((node) => {
      if (isOptionsOrMenuControl(node) || isRelationshipCta(node)) return false
      return isListHref(node.getAttribute('href') || '', mode)
    })
    if (byHref) return byHref

    const scope = document.querySelector('header') || document.querySelector('section main') || document.body
    const candidates = [...scope.querySelectorAll('a[href], span, div, li')]
    const scored = []
    for (const node of candidates) {
      if (isOptionsOrMenuControl(node)) continue
      if (isRelationshipCta(node)) continue
      if (node.children?.length > 8) continue
      const text = normalizeText(node.textContent)
      if (!text || text.length > 40) continue
      if (!/\d/.test(text)) continue
      if (!new RegExp(`\\b${mode}\\b`).test(text)) continue
      const href = (node.getAttribute?.('href') || '').toLowerCase()
      let score = 0
      if (isListHref(href, mode)) score += 30
      if (node.tagName === 'A') score += 10
      if (new RegExp(`^\\d[\\d.,\\s]*[km]?\\s*${mode}$`).test(text)) score += 20
      if (new RegExp(`^${mode}\\s*\\d[\\d.,\\s]*[km]?$`).test(text)) score += 18
      if (new RegExp(`\\d[\\d.,\\s]*[km]?\\s*${mode}`).test(text)) score += 12
      if (node.closest?.('header')) score += 5
      if (score > 0) scored.push({ node, score, text })
    }
    scored.sort((a, b) => b.score - a.score)
    if (scored[0]) {
      const picked = clickableAncestor(scored[0].node)
      if (!isOptionsOrMenuControl(picked) && !isRelationshipCta(picked)) return picked
      const innerLink = scored[0].node.closest?.('a[href]') || scored[0].node.querySelector?.('a[href]')
      if (innerLink && isListHref(innerLink.getAttribute('href') || '', mode)) return innerLink
    }

    return null
  }

  function isRelationshipListDialog(node) {
    if (!node) return false
    const text = normalizeText(node.textContent).slice(0, 800)
    const links = node.querySelectorAll('a[href^="/"]').length
    const hasSearch = Boolean(
      node.querySelector('input[placeholder*="Search" i], input[aria-label*="Search" i]'),
    )
    const hasFollowingWord = /\bfollowing\b/.test(text)
    const hasFollowersWord = /\bfollowers\b/.test(text)
    if (links < 2 && !hasSearch) return false
    if (/(log out|report|block|restrict|copy link|qr code|settings)/i.test(text) && links < 5) {
      return false
    }
    if (/\bunfollow\b/.test(text) && links < 3 && !hasSearch) return false
    if (hasFollowingWord || hasFollowersWord || hasSearch || links >= 3) return true
    return false
  }

  function dialog(listType = 'following') {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
    if (!dialogs.length) return null
    const ranked = dialogs
      .map((node) => {
        const text = normalizeText(node.textContent).slice(0, 500)
        let score = 0
        if (!isRelationshipListDialog(node)) score -= 20
        const links = node.querySelectorAll('a[href^="/"]').length
        score += Math.min(8, links)
        if (listType === 'following' && /\bfollowing\b/.test(text)) score += 6
        if (listType === 'followers' && /\bfollowers\b/.test(text)) score += 6
        if (node.querySelector('input[placeholder*="Search" i], input[aria-label*="Search" i]')) score += 5
        if (node.querySelector('[aria-label*="Close" i]')) score += 1
        if (/(options|settings|report|block|qr code)/i.test(text) && links < 4) score -= 15
        score += Math.min(3, Math.floor((node.scrollHeight || 0) / 400))
        return { node, score }
      })
      .sort((left, right) => right.score - left.score)
    const best = ranked[0]
    if (!best || best.score < 0) return null
    return best.node
  }

  function scrollContainer(root) {
    const candidates = [root, ...root.querySelectorAll('div, ul, section')]
      .filter((node) => {
        try {
          const style = window.getComputedStyle(node)
          const overflowY = style.overflowY
          const scrollable = node.scrollHeight > node.clientHeight + 20
          const allowsScroll = /(auto|scroll|overlay)/.test(overflowY)
          return scrollable && (allowsScroll || node === root)
        } catch {
          return false
        }
      })
      .sort((left, right) => right.scrollHeight - right.clientHeight - (left.scrollHeight - left.clientHeight))
    return candidates[0] || root
  }

  function listAlreadyOpen(listType = 'following') {
    const path = location.pathname.toLowerCase()
    if (new RegExp(`/${listType}/?$`).test(path)) {
      const d = dialog(listType)
      if (d) return true
      if (document.querySelector('a[href^="/"]')) return true
    }
    const current = dialog(listType)
    if (!current) return false
    return isRelationshipListDialog(current)
  }

  async function waitForDialog(listType = 'following', timeoutMs = 12000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (listAlreadyOpen(listType)) return dialog(listType) || document.body
      await sleep(300)
    }
    const d = dialog(listType)
    return d && isRelationshipListDialog(d) ? d : null
  }

  function scrapeRelationshipUsernames(root, selfUsername) {
    const found = new Map()
    const scope = root || document
    const anchors = scope.querySelectorAll('a[href]')
    for (const anchor of anchors) {
      const href = anchor.getAttribute('href') || ''
      const username = usernameFromHref(href)
      if (!username) continue
      if (selfUsername && username === selfUsername) continue
      if (RESERVED.has(username)) continue
      let pathParts = href.split('?')[0].split('/').filter(Boolean)
      if (pathParts[0] === '_u') pathParts = pathParts.slice(1)
      if (pathParts.length > 2) continue
      found.set(username, { username, instagram_id: null, following_count: null })
    }
    return [...found.values()]
  }

  function pushDomBatch(users, selfUsername, mode = 'following') {
    if (!users.length) return
    try {
      chrome.runtime.sendMessage({
        type: 'RELATIONSHIP_DOM_BATCH',
        source_username: selfUsername || profileUsername(),
        mode,
        users,
      })
    } catch {}
  }

  function csrfToken() {
    const match = document.cookie.match(/(?:^|;\s*)csrftoken=([^;]+)/)
    return match ? decodeURIComponent(match[1]) : ''
  }

  function extractProfileIdFromPage(username) {
    const needle = username ? username.toLowerCase() : null
    const scripts = [...document.scripts].map((script) => script.textContent || '').join('\n')
    const patterns = [
      /"profile_id"\s*:\s*"?(\d+)"?/i,
      /"user_id"\s*:\s*"?(\d+)"?/i,
      /"pk"\s*:\s*"?(\d+)"?/i,
      /"id"\s*:\s*"?(\d+)"?\s*,\s*"username"\s*:\s*"([^"]+)"/i,
      /"username"\s*:\s*"([^"]+)"\s*,[\s\S]{0,400}?"id"\s*:\s*"?(\d+)"?/i,
    ]
    for (const pattern of patterns) {
      const match = scripts.match(pattern)
      if (!match) continue
      if (match.length >= 3) {
        const firstIsId = /^\d+$/.test(match[1])
        const id = firstIsId ? match[1] : match[2]
        const foundUsername = (firstIsId ? match[2] : match[1] || '').toLowerCase()
        if (!needle || !foundUsername || foundUsername === needle) return id
      } else if (match[1]) {
        return match[1]
      }
    }
    return null
  }

  async function instagramJson(url) {
    const headers = {
      Accept: 'application/json',
      'X-IG-App-ID': '936619743392459',
      'X-ASBD-ID': '129477',
      'X-Requested-With': 'XMLHttpRequest',
    }
    const csrf = csrfToken()
    if (csrf) headers['X-CSRFToken'] = csrf
    const response = await fetch(url, { credentials: 'include', headers })
    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText)
      if (response.status === 403) {
        throw new Error(`Instagram API blocked this request (403 Forbidden). Session may be invalid or the account is private.`)
      }
      if (response.status === 429) {
        await sleep(5000)
        throw new Error(`Instagram API rate-limited (429). Waited 5 s before giving up.`)
      }
      throw new Error(`Instagram API ${response.status}: ${text.slice(0, 180)}`)
    }
    const data = await response.json()
    // Instagram occasionally returns HTTP 200 with a JSON error body
    if (data && data.status === 'fail') {
      const msg = data.message || 'unknown error'
      if (/checkpoint|challenge|login/i.test(msg)) {
        throw new Error(`Instagram requires action on the account (${msg}). Scan stopped.`)
      }
      throw new Error(`Instagram API responded with failure: ${msg}`)
    }
    return data
  }

  function numberOrNull(value) {
    const number = Number(value)
    return Number.isFinite(number) ? number : null
  }

  function profileSummaryFromUser(user, fallbackUsername = null) {
    if (!user || typeof user !== 'object') return null
    const username = String(user.username || user.user_name || fallbackUsername || '').toLowerCase()
    if (!username || !USERNAME_RE.test(username) || RESERVED.has(username)) return null
    const rawId = user.id ?? user.pk ?? user.pk_id ?? user.instagram_id ?? null
    const followerCount =
      user.follower_count ??
      user.followers ??
      user.edge_followed_by?.count ??
      user.relationship_counts?.followers ??
      null
    const followingCount =
      user.following_count ??
      user.following ??
      user.edge_follow?.count ??
      user.relationship_counts?.following ??
      null
    return {
      username,
      instagram_id: rawId == null ? null : String(rawId),
      follower_count: numberOrNull(followerCount),
      following_count: numberOrNull(followingCount),
      verified: Boolean(user.is_verified ?? user.verified ?? false),
      is_private: Boolean(user.is_private ?? false),
    }
  }

  async function fetchProfileSummary(username) {
    const payload = await instagramJson(
      `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
    )
    const user = payload?.data?.user || payload?.user || payload
    const summary = profileSummaryFromUser(user, username)
    if (!summary) throw new Error(`Could not parse profile counts for @${username}`)
    return summary
  }

  async function resolveProfileId(username) {
    try {
      const summary = await fetchProfileSummary(username)
      if (summary.instagram_id) return String(summary.instagram_id)
    } catch (error) {
      console.warn('web profile id lookup failed; trying page bootstrap data', error)
    }

    const fromPage = extractProfileIdFromPage(username)
    if (fromPage) return fromPage
    throw new Error(`Could not resolve Instagram user id for @${username}`)
  }

  function usersFromRelationshipApi(payload) {
    const users = Array.isArray(payload?.users) ? payload.users : []
    return users
      .map((user) => {
        const summary = profileSummaryFromUser(user)
        if (summary) return summary
        return {
          username: String(user.username || user.user_name || '').toLowerCase(),
          instagram_id: user.pk != null || user.id != null || user.pk_id != null
            ? String(user.pk ?? user.id ?? user.pk_id)
            : null,
          follower_count: null,
          following_count: null,
        }
      })
      .filter((user) => user.username && USERNAME_RE.test(user.username) && !RESERVED.has(user.username))
  }

  async function captureRelationshipViaApi(mode = 'following') {
    const username = profileUsername()
    if (!username) throw new Error('Open a profile page first')
    const userId = await resolveProfileId(username)
    const seen = new Map()
    let maxId = ''
    let page = 0
    let consecutiveEmptyPages = 0

    do {
      const url = new URL(`https://www.instagram.com/api/v1/friendships/${userId}/${mode}/`)
      url.searchParams.set('count', '50')
      if (maxId) url.searchParams.set('max_id', maxId)
      const payload = await instagramJson(url.toString())
      const users = usersFromRelationshipApi(payload)
      let added = 0
      for (const user of users) {
        if (user.username === username) continue
        if (!seen.has(user.username)) {
          seen.set(user.username, user)
          added += 1
        }
      }
      if (added > 0) {
        pushDomBatch([...seen.values()], username, mode)
        consecutiveEmptyPages = 0
      } else {
        consecutiveEmptyPages += 1
      }
      maxId = payload?.next_max_id || payload?.next_max_id_v2 || ''
      page += 1
      if (!maxId || users.length === 0 || added === 0 || consecutiveEmptyPages >= 3 || page >= 200) break
      await sleep(650)
    } while (maxId)

    const users = [...seen.values()]
    chrome.runtime.sendMessage({
      type: 'RELATIONSHIP_CAPTURE_DONE',
      ok: true,
      mode,
      dom_count: users.length,
      users,
    })
    return true
  }

  async function openRelationshipByNavigation(username, mode = 'following') {
    if (!username) return false
    if (new RegExp(`/${mode}/?$`, 'i').test(location.pathname)) {
      const opened = await waitForDialog(mode, 15000)
      return Boolean(opened)
    }
    try {
      chrome.runtime.sendMessage({
        type: 'NAVIGATE_RELATIONSHIPS',
        mode,
        username,
        url: `https://www.instagram.com/${username}/${mode}/`,
      })
    } catch {}
    return 'navigating'
  }

  function safeClick(node) {
    if (!node) return false
    if (isOptionsOrMenuControl(node) || isRelationshipCta(node)) return false
    try {
      node.scrollIntoView?.({ block: 'center', inline: 'center', behavior: 'instant' })
    } catch {}
    const opts = { bubbles: true, cancelable: true, view: window, buttons: 1 }
    try {
      node.dispatchEvent(new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }))
      node.dispatchEvent(new MouseEvent('mousedown', opts))
      node.dispatchEvent(new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }))
      node.dispatchEvent(new MouseEvent('mouseup', opts))
      node.dispatchEvent(new MouseEvent('click', opts))
      if (typeof node.click === 'function') node.click()
      return true
    } catch {
      try {
        node.click()
        return true
      } catch {
        return false
      }
    }
  }

  function closeOpenDialog(mode = 'following') {
    const current = dialog(mode) || document.querySelector('[role="dialog"]')
    if (!current) return
    const closeBtn = current.querySelector(
      '[aria-label*="Close" i], [aria-label*="close" i], button[type="button"]',
    )
    if (closeBtn && !isRelationshipCta(closeBtn)) {
      try { closeBtn.click() } catch {}
    }
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }))
    } catch {}
  }

  async function scrollRelationship(mode = 'following') {
    const selfUsername = profileUsername()
    let currentDialog = await waitForDialog(mode, 10000)
    if (!currentDialog) {
      if (new RegExp(`/${mode}/?$`, 'i').test(location.pathname)) {
        currentDialog = document.body
      } else {
        chrome.runtime.sendMessage({
          type: 'RELATIONSHIP_CAPTURE_DONE',
          ok: false,
          mode,
          error: `${modeLabel(mode)} dialog did not open`,
        })
        return false
      }
    }

    const seen = new Map()
    const reportProgress = () => {
      const batch = scrapeRelationshipUsernames(currentDialog, selfUsername)
      let added = 0
      for (const user of batch) {
        if (!seen.has(user.username)) {
          seen.set(user.username, user)
          added += 1
        }
      }
      if (added > 0) pushDomBatch([...seen.values()], selfUsername, mode)
      return { total: seen.size, added }
    }

    reportProgress()

    const startedAt = Date.now()
    let noGrowthPasses = 0
    let bottomPasses = 0
    let lastCount = seen.size
    let lastHeight = 0

    for (let attempt = 0; attempt < SCROLL_MAX_ATTEMPTS; attempt += 1) {
      if (Date.now() - startedAt > SCROLL_MAX_MS) break

      currentDialog = dialog(mode) || currentDialog
      if (!currentDialog) break

      const active = scrollContainer(currentDialog)
      const beforeTop = active.scrollTop
      const view = active.clientHeight || 1
      const maxScroll = Math.max(0, active.scrollHeight - view)
      const nearBottom = beforeTop >= maxScroll - 40 || active.scrollHeight <= view + 8

      const step = Math.max(500, Math.floor(view * 0.9))
      const nextTop = Math.min(active.scrollHeight, beforeTop + step)
      active.scrollTop = nextTop
      active.dispatchEvent(new Event('scroll', { bubbles: true }))

      if (!nearBottom) {
        const anchors = currentDialog.querySelectorAll('a[href^="/"]')
        if (anchors.length) {
          try { anchors[anchors.length - 1].scrollIntoView({ block: 'end' }) } catch {}
        }
      }

      await sleep(500)

      const { total, added } = reportProgress()
      const heightNow = active.scrollHeight
      const topNow = active.scrollTop
      const stillNearBottom = topNow >= Math.max(0, heightNow - (active.clientHeight || 1) - 40)

      if (added === 0 && total === lastCount) noGrowthPasses += 1
      else noGrowthPasses = 0

      if (stillNearBottom && added === 0 && heightNow <= lastHeight + 2) bottomPasses += 1
      else if (!stillNearBottom) bottomPasses = 0
      else if (added > 0) bottomPasses = 0

      lastCount = total
      lastHeight = heightNow

      if (noGrowthPasses >= NO_GROWTH_EXIT && total > 0) break
      if (noGrowthPasses >= NO_GROWTH_EXIT && stillNearBottom) break
      if (bottomPasses >= BOTTOM_EXIT) break
    }

    await sleep(400)
    reportProgress()
    if (seen.size) pushDomBatch([...seen.values()], selfUsername, mode)

    closeOpenDialog(mode)

    chrome.runtime.sendMessage({
      type: 'RELATIONSHIP_CAPTURE_DONE',
      ok: true,
      mode,
      dom_count: seen.size,
      users: [...seen.values()],
    })
    return true
  }

  async function openAndScrollRelationship(mode = 'following') {
    mode = scanMode(mode)
    try {
      const completed = await captureRelationshipViaApi(mode)
      return { ok: completed !== false, via_api: true }
    } catch (error) {
      // Hard failures (403, checkpoint, rate-limit after cooldown) should not
      // silently fall through to DOM scrolling — surface them immediately.
      const msg = error.message || ''
      if (/403 Forbidden|blocked this request|requires action|rate-limited/i.test(msg)) {
        return { ok: false, error: msg }
      }
      console.warn(`${mode} API capture failed; falling back to dialog scroll`, error)
    }

    if (listAlreadyOpen(mode) || new RegExp(`/${mode}/?$`, 'i').test(location.pathname)) {
      const completed = await scrollRelationship(mode)
      return { ok: completed !== false }
    }

    const username = profileUsername()
    let link = relationshipLink(mode)

    for (let attempt = 0; attempt < 10 && !link; attempt += 1) {
      await sleep(300)
      if (listAlreadyOpen(mode)) {
        const completed = await scrollRelationship(mode)
        return { ok: completed !== false }
      }
      link = relationshipLink(mode)
    }

    if (link) {
      const clicked = safeClick(link)
      if (clicked) {
        const opened = await waitForDialog(mode, 8000)
        if (opened) {
          const completed = await scrollRelationship(mode)
          return { ok: completed !== false }
        }
      }
    }

    if (username) {
      const navigated = await openRelationshipByNavigation(username, mode)
      if (navigated === 'navigating') return { ok: true, deferred: true }
      if (navigated) {
        const completed = await scrollRelationship(mode)
        return { ok: completed !== false }
      }
    }

    const pathUser = (location.pathname || '').split('/').filter(Boolean)[0]
    if (pathUser && !RESERVED.has(pathUser.toLowerCase())) {
      const navigated = await openRelationshipByNavigation(pathUser.toLowerCase(), mode)
      if (navigated === 'navigating') return { ok: true, deferred: true }
    }

    if (!username && !link) {
      return { ok: false, error: `Not on a profile page with a ${modeLabel(mode)} control` }
    }
    return { ok: false, error: `${modeLabel(mode)} list did not open` }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'INSTARL_PING') {
      sendResponse({
        ok: true,
        pong: true,
        href: location.href,
        username: profileUsername(),
        following_open: listAlreadyOpen('following'),
        followers_open: listAlreadyOpen('followers'),
      })
      return false
    }
    if (message.type === 'GET_PROFILE_COUNTS') {
      const username = String(message.username || '').toLowerCase()
      if (!USERNAME_RE.test(username) || RESERVED.has(username)) {
        sendResponse({ ok: false, error: 'Invalid Instagram username' })
        return false
      }
      fetchProfileSummary(username)
        .then((profile) => sendResponse({ ok: true, profile }))
        .catch((error) => sendResponse({ ok: false, error: error.message }))
      return true
    }

    if (message.type !== 'OPEN_AND_SCROLL_RELATIONSHIPS' && message.type !== 'OPEN_AND_SCROLL_FOLLOWING') return false
    const mode = scanMode(message.mode || 'following')
    sendResponse({ ok: true, accepted: true })
    openAndScrollRelationship(mode)
      .then((result) => {
        if (result.ok) return
        chrome.runtime.sendMessage({
          type: 'RELATIONSHIP_CAPTURE_DONE',
          ok: false,
          mode,
          error: result.error,
        })
      })
      .catch((error) => {
        chrome.runtime.sendMessage({
          type: 'RELATIONSHIP_CAPTURE_DONE',
          ok: false,
          mode,
          error: error.message,
        })
      })
    return false
  })
})()
