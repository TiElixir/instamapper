(() => {
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  const USERNAME_RE = /^[a-z0-9._]{1,30}$/
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

  function isFollowingHref(href) {
    if (!href) return false
    try {
      const url = new URL(href, location.origin)
      if (url.hostname && !url.hostname.endsWith('instagram.com')) return false
      return /\/following\/?(?:$|\?)/.test(url.pathname)
    } catch {
      return /\/following\/?(?:\?|$)/.test(href)
    }
  }

  function isFollowersHref(href) {
    if (!href) return false
    try {
      const url = new URL(href, location.origin)
      if (url.hostname && !url.hostname.endsWith('instagram.com')) return false
      return /\/followers\/?(?:$|\?)/.test(url.pathname)
    } catch {
      return /\/followers\/?(?:\?|$)/.test(href)
    }
  }

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
    if (
      /(options|more options|more|menu|settings|see more|ellipsis|overflow)/i.test(label)
    ) {
      return true
    }
    // Bare icon buttons with no useful text are almost never the Following count.
    const text = normalizeText(node.textContent)
    const tag = node.tagName
    if ((tag === 'BUTTON' || node.getAttribute?.('role') === 'button') && !text) {
      if (node.querySelector?.('svg') && !isFollowingHref(node.getAttribute?.('href') || '')) {
        return true
      }
    }
    // Unicode / glyph three-dots.
    if (/^[⋅·•⋯⋮…]+$/.test(text)) return true
    if (text === 'options' || text === 'more') return true
    return false
  }

  function isRelationshipCta(node) {
    // Blue/grey Follow / Following / Requested button next to Message — NOT the count link.
    if (!node) return false
    const href = node.getAttribute?.('href') || ''
    if (isFollowingHref(href) || isFollowersHref(href)) return false
    const text = normalizeText(node.textContent)
    const label = normalizeText(node.getAttribute?.('aria-label'))
    const combined = `${text} ${label}`
    if (/^(follow|following|requested|unfollow|message|email|subscribe)$/i.test(text)) return true
    if (/\b(follow|following|requested|unfollow)\b/i.test(label) && !/\d/.test(combined)) {
      // "Following" CTA has no count; the stats link is "123 following".
      if (!isFollowingHref(href)) return true
    }
    return false
  }

  function clickableAncestor(node) {
    let current = node
    while (current && current !== document.body) {
      if (current.matches?.('a[href]')) return current
      if (current.matches?.('button, [role="link"], [role="button"]')) {
        // Prefer not to promote into options / CTA chrome.
        if (!isOptionsOrMenuControl(current) && !isRelationshipCta(current)) return current
      }
      current = current.parentElement
    }
    return node
  }

  function followingLink() {
    const username = profileUsername()
    const anchors = [...document.querySelectorAll('a[href]')]

    // 1) Exact profile Following href — only reliable control on modern Instagram.
    if (username) {
      const scoped = anchors.find((node) => {
        if (isOptionsOrMenuControl(node) || isRelationshipCta(node)) return false
        const href = (node.getAttribute('href') || '').toLowerCase()
        return isFollowingHref(href) && href.includes(`/${username}/following`)
      })
      if (scoped) return scoped
    }

    const byHref = anchors.find((node) => {
      if (isOptionsOrMenuControl(node) || isRelationshipCta(node)) return false
      return isFollowingHref(node.getAttribute('href') || '')
    })
    if (byHref) return byHref

    // 2) Header stat cells: must look like "123 following" and preferably be an <a>.
    //    Never accept the relationship "Following" button (no digits).
    const scope =
      document.querySelector('header') ||
      document.querySelector('section main') ||
      document.body
    const candidates = [...scope.querySelectorAll('a[href], span, div, li')]
    const scored = []
    for (const node of candidates) {
      if (isOptionsOrMenuControl(node)) continue
      if (isRelationshipCta(node)) continue
      if (node.children?.length > 8) continue
      const text = normalizeText(node.textContent)
      if (!text || text.length > 40) continue
      // Must include a count — this rejects the Follow/Following CTA and ⋯ menu.
      if (!/\d/.test(text)) continue
      if (!/\bfollowing\b/.test(text)) continue
      if (/\bfollowers\b/.test(text) && !/\bfollowing\b/.test(text)) continue
      const href = (node.getAttribute?.('href') || '').toLowerCase()
      let score = 0
      if (isFollowingHref(href)) score += 30
      if (node.tagName === 'A') score += 10
      if (/^\d[\d.,\s]*[km]?\s*following$/.test(text)) score += 20
      if (/^following\s*\d[\d.,\s]*[km]?$/.test(text)) score += 18
      if (/\d[\d.,\s]*[km]?\s*following/.test(text)) score += 12
      // Prefer nodes inside header.
      if (node.closest?.('header')) score += 5
      if (score > 0) scored.push({ node, score, text })
    }
    scored.sort((a, b) => b.score - a.score)
    if (scored[0]) {
      const picked = clickableAncestor(scored[0].node)
      if (!isOptionsOrMenuControl(picked) && !isRelationshipCta(picked)) return picked
      // If ancestor promotion failed, try the raw anchor child.
      const innerLink = scored[0].node.closest?.('a[href]') || scored[0].node.querySelector?.('a[href]')
      if (innerLink && isFollowingHref(innerLink.getAttribute('href') || '')) return innerLink
    }

    return null
  }

  function isFollowingListDialog(node) {
    if (!node) return false
    const text = normalizeText(node.textContent).slice(0, 800)
    const links = node.querySelectorAll('a[href^="/"]').length
    const hasSearch = Boolean(
      node.querySelector('input[placeholder*="Search" i], input[aria-label*="Search" i]'),
    )
    const hasFollowingWord = /\bfollowing\b/.test(text)
    const hasFollowersWord = /\bfollowers\b/.test(text)
    // Options / share / unfollow sheets are small and link-poor.
    if (links < 2 && !hasSearch) return false
    if (/(log out|report|block|restrict|copy link|qr code|settings)/i.test(text) && links < 5) {
      return false
    }
    // Unfollow confirmation sheet.
    if (/\bunfollow\b/.test(text) && links < 3 && !hasSearch) return false
    if (hasFollowingWord || hasSearch || links >= 3) return true
    if (hasFollowersWord && links >= 3) return true
    return false
  }

  function dialog(listType = 'following') {
    const dialogs = [...document.querySelectorAll('[role="dialog"], [aria-modal="true"]')]
    if (!dialogs.length) return null
    const ranked = dialogs
      .map((node) => {
        const text = normalizeText(node.textContent).slice(0, 500)
        let score = 0
        if (!isFollowingListDialog(node)) score -= 20
        const links = node.querySelectorAll('a[href^="/"]').length
        score += Math.min(8, links)
        if (listType === 'following' && /\bfollowing\b/.test(text)) score += 6
        if (listType === 'followers' && /\bfollowers\b/.test(text)) score += 6
        if (node.querySelector('input[placeholder*="Search" i], input[aria-label*="Search" i]')) {
          score += 5
        }
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
      .sort(
        (left, right) =>
          right.scrollHeight - right.clientHeight - (left.scrollHeight - left.clientHeight),
      )
    return candidates[0] || root
  }

  function listAlreadyOpen(listType = 'following') {
    const path = location.pathname.toLowerCase()
    if (listType === 'following' && /\/following\/?$/.test(path)) {
      const d = dialog('following')
      if (d) return true
      // Full-page following route without role=dialog.
      if (document.querySelector('a[href^="/"]')) return true
    }
    if (listType === 'followers' && /\/followers\/?$/.test(path)) return true

    const current = dialog(listType)
    if (!current) return false
    return isFollowingListDialog(current)
  }

  async function waitForDialog(timeoutMs = 12000) {
    const started = Date.now()
    while (Date.now() - started < timeoutMs) {
      if (listAlreadyOpen('following')) return dialog('following') || document.body
      await sleep(300)
    }
    const d = dialog('following')
    return d && isFollowingListDialog(d) ? d : null
  }

  function scrapeFollowingUsernames(root, selfUsername) {
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
      found.set(username, { username, instagram_id: null })
    }
    return [...found.values()]
  }

  function pushDomBatch(users, selfUsername) {
    if (!users.length) return
    try {
      chrome.runtime.sendMessage({
        type: 'FOLLOWING_DOM_BATCH',
        source_username: selfUsername || profileUsername(),
        following: users,
      })
    } catch {}
  }

  async function openFollowingByNavigation(username) {
    if (!username) return false
    if (/\/following\/?$/i.test(location.pathname)) {
      const opened = await waitForDialog(15000)
      return Boolean(opened)
    }
    try {
      chrome.runtime.sendMessage({
        type: 'NAVIGATE_FOLLOWING',
        username,
        url: `https://www.instagram.com/${username}/following/`,
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
      node.dispatchEvent(
        new PointerEvent('pointerdown', { ...opts, pointerId: 1, pointerType: 'mouse' }),
      )
      node.dispatchEvent(new MouseEvent('mousedown', opts))
      node.dispatchEvent(
        new PointerEvent('pointerup', { ...opts, pointerId: 1, pointerType: 'mouse' }),
      )
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

  function closeOpenDialog() {
    const current = dialog('following') || document.querySelector('[role="dialog"]')
    if (!current) return
    const closeBtn = current.querySelector(
      '[aria-label*="Close" i], [aria-label*="close" i], button[type="button"]',
    )
    if (closeBtn && !isRelationshipCta(closeBtn)) {
      try {
        closeBtn.click()
      } catch {}
    }
    try {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
      document.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }))
    } catch {}
  }

  async function scrollFollowing() {
    const selfUsername = profileUsername()
    let currentDialog = await waitForDialog(10000)
    if (!currentDialog) {
      if (/\/following\/?$/i.test(location.pathname)) {
        currentDialog = document.body
      } else {
        chrome.runtime.sendMessage({
          type: 'FOLLOWING_CAPTURE_DONE',
          ok: false,
          error: 'Following dialog did not open',
        })
        return false
      }
    }

    const seen = new Map()
    const reportProgress = () => {
      const batch = scrapeFollowingUsernames(currentDialog, selfUsername)
      let added = 0
      for (const user of batch) {
        if (!seen.has(user.username)) {
          seen.set(user.username, user)
          added += 1
        }
      }
      if (added > 0) {
        pushDomBatch([...seen.values()], selfUsername)
      }
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

      currentDialog = dialog('following') || currentDialog
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

      // Nudge last row into view without thrashing when already at end.
      if (!nearBottom) {
        const anchors = currentDialog.querySelectorAll('a[href^="/"]')
        if (anchors.length) {
          try {
            anchors[anchors.length - 1].scrollIntoView({ block: 'end' })
          } catch {}
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

      // Primary exit: list stopped producing users.
      if (noGrowthPasses >= NO_GROWTH_EXIT && total > 0) break
      // Empty list that cannot scroll.
      if (noGrowthPasses >= NO_GROWTH_EXIT && stillNearBottom) break
      // At bottom repeatedly with no growth.
      if (bottomPasses >= BOTTOM_EXIT) break
    }

    await sleep(400)
    reportProgress()
    // Push final full set once more.
    if (seen.size) pushDomBatch([...seen.values()], selfUsername)

    closeOpenDialog()

    chrome.runtime.sendMessage({
      type: 'FOLLOWING_CAPTURE_DONE',
      ok: true,
      dom_count: seen.size,
      following: [...seen.values()],
    })
    return true
  }

  async function openAndScrollFollowing() {
    // Already on following route / open list → scroll only.
    if (listAlreadyOpen('following') || /\/following\/?$/i.test(location.pathname)) {
      const completed = await scrollFollowing()
      return { ok: completed !== false }
    }

    // Prefer direct navigation over fragile clicks. Instagram's header click
    // targets change often; /{user}/following/ is stable and opens the same list.
    const username = profileUsername()
    let link = followingLink()

    // Short wait for header hydration before we decide to navigate.
    for (let attempt = 0; attempt < 10 && !link; attempt += 1) {
      await sleep(300)
      if (listAlreadyOpen('following')) {
        const completed = await scrollFollowing()
        return { ok: completed !== false }
      }
      link = followingLink()
    }

    if (link) {
      const clicked = safeClick(link)
      if (clicked) {
        const opened = await waitForDialog(8000)
        if (opened) {
          const completed = await scrollFollowing()
          return { ok: completed !== false }
        }
      }
    }

    // Click failed or hit the wrong chrome → hard-navigate to Following route.
    if (username) {
      const navigated = await openFollowingByNavigation(username)
      if (navigated === 'navigating') return { ok: true, deferred: true }
      if (navigated) {
        const completed = await scrollFollowing()
        return { ok: completed !== false }
      }
    }

    const pathUser = (location.pathname || '').split('/').filter(Boolean)[0]
    if (pathUser && !RESERVED.has(pathUser.toLowerCase())) {
      const navigated = await openFollowingByNavigation(pathUser.toLowerCase())
      if (navigated === 'navigating') return { ok: true, deferred: true }
    }

    if (!username && !link) {
      return { ok: false, error: 'Not on a profile page with a Following control' }
    }
    return { ok: false, error: 'Following list did not open' }
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message.type === 'INSTARL_PING') {
      sendResponse({
        ok: true,
        pong: true,
        href: location.href,
        username: profileUsername(),
        following_open: listAlreadyOpen('following'),
      })
      return false
    }
    if (message.type !== 'OPEN_AND_SCROLL_FOLLOWING') return false
    sendResponse({ ok: true, accepted: true })
    openAndScrollFollowing()
      .then((result) => {
        if (result.ok) return
        chrome.runtime.sendMessage({
          type: 'FOLLOWING_CAPTURE_DONE',
          ok: false,
          error: result.error,
        })
      })
      .catch((error) => {
        chrome.runtime.sendMessage({
          type: 'FOLLOWING_CAPTURE_DONE',
          ok: false,
          error: error.message,
        })
      })
    return false
  })
})()
