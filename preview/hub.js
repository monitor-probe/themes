// A stand-in hub for theme previews, run in the visitor's browser: loaded first
// in the theme's own page, it answers the five reads a theme may make from
// generated data in the shapes hub 1.3.2 returns, through fetch,
// XMLHttpRequest and WebSocket. Values follow the clock, so a theme polling or
// listening on the socket sees them move. When the hub's public API changes,
// this file changes with it.
//
// Nothing here reaches the network: the site is static files only, which
// Cloudflare Pages serves without counting requests, whereas a server-side
// stand-in is billed for every poll a theme makes (one theme measured 180 a
// minute). Wrapped in a function so no name leaks into the theme's scope.

(() => {
  "use strict"

  const HISTORY_DAYS = 30
  const GiB = 1 << 30

  // Deterministic noise in [0, 1) from integers, so a metric at a given second is
  // the same for every request.
  function noise(...xs) {
    let h = 2166136261
    for (const x of xs) h = Math.imul(h ^ (x | 0), 16777619) ^ (h >>> 13)
    return ((h >>> 0) % 100000) / 100000
  }

  // name, country, group, cycle, currency, price, expires (days from today or null), remark, state
  const SEED = [
    ["东京 · 软银", "JP", "亚洲", "monthly", "CNY", 29.9, 12, "", "ok"],
    ["香港 · CMI", "HK", "亚洲", "quarterly", "HKD", 120, 0, "今天到期", "ok"],
    ["新加坡", "SG", "亚洲", "yearly", "USD", 49.99, -3, "", "offline"],
    ["首尔", "KR", "亚洲", "60m", "KRW", 150000, 900, "", "ok"],
    ["洛杉矶 · CN2 GIA", "US", "美洲", "yearly", "USD", 39.9, 397, "晚高峰三网直连", "ok"],
    ["圣何塞", "US", "美洲", "once", "USD", 120, null, "", "ok"],
    ["达拉斯 · 一个名字特别特别长的节点用来测试截断", "US", "美洲", "monthly", "USD", 5, 40, "", "ok"],
    ["法兰克福", "DE", "欧洲", "biennial", "EUR", 79, 500, "", "ok"],
    ["阿姆斯特丹", "NL", "欧洲", "semiannual", "EUR", 18, 60, "", "fresh"],
    ["伦敦", "GB", "欧洲", "triennial", "GBP", 99, 1000, "", "ok"],
    ["悉尼", "AU", "", "monthly", "AUD", 8.5, 20, "", "ok"],
    ["家里的 NAS", "CN", "", "once", "CNY", 0, null, "", "ok"],
  ]
  // Thirty nodes: the seed list, then numbered copies to show a long page.
  const NODES = Array.from({ length: 30 }, (_, i) => {
    const s = SEED[i % SEED.length]
    return { id: i + 1, seed: s, name: i < SEED.length ? s[0] : `${s[0]} ${Math.floor(i / SEED.length) + 1}` }
  })

  function today() {
    return new Date().toISOString().slice(0, 10)
  }
  function plusDays(days) {
    return new Date(Date.now() + days * 86400e3).toISOString().slice(0, 10)
  }

  // A metric sample for node `id` at second `t`.
  function sample(id, t) {
    const day = Math.sin(((t % 86400) / 86400) * 2 * Math.PI)
    const n = (k) => noise(id, k, Math.floor(t / 2))
    const cpu = Math.min(100, 5 + 20 * (1 + day) * noise(id, 1) + 15 * n(2))
    const rx = Math.round((2e5 + 3e6 * noise(id, 3) * (1 + day)) * (0.5 + n(4)))
    const tx = Math.round(rx * (0.3 + noise(id, 5)))
    return { cpu, rx, tx }
  }

  // Fixed sizes per node, shared by the snapshot and its history.
  function sizes(id) {
    return {
      memTotal: (1 + Math.floor(noise(id, 6) * 8)) * GiB,
      diskTotal: (20 + Math.floor(noise(id, 7) * 200)) * GiB,
    }
  }

  // Seconds since the node last reported: an offline node stopped five hours ago.
  const OFFLINE_FOR = 5 * 3600

  function node(n, now) {
    const [, country, group, cycle, currency, price, expires, remark, state] = n.seed
    const { memTotal, diskTotal } = sizes(n.id)
    // Whole even GiB, so every half below is a whole number of bytes as well.
    const month = 2 * Math.round(noise(n.id, 8) * 400) * GiB
    const total = month * 6
    const s = sample(n.id, now)
    const online = state !== "offline"
    const metrics = state === "ok" ? {
      cpu: s.cpu, load: [s.cpu / 50, s.cpu / 60, s.cpu / 70],
      mem_total: memTotal, mem_used: Math.round(memTotal * (0.2 + 0.5 * noise(n.id, 9))),
      swap_total: GiB, swap_used: 0,
      disk_total: diskTotal, disk_used: Math.round(diskTotal * (0.1 + 0.8 * noise(n.id, 10))),
      net_rx: s.rx, net_tx: s.tx, tcp: 20 + n.id, udp: 5, procs: 90 + n.id,
      uptime: 86400 * 30 + now % 86400,
      total_rx: total, total_tx: total / 2, month_rx: month, month_tx: month / 2,
    } : null
    return {
      id: n.id, name: n.name, sort: n.id, public: true, online, metrics,
      country, group, public_remark: remark,
      os: "Debian GNU/Linux 13 (trixie)", kernel: "6.12.0-amd64", arch: "x86_64", virt: "kvm",
      cpu_name: "AMD EPYC 9654 96-Core Processor", cpu_cores: 1 + (n.id % 4),
      mem_total: memTotal, swap_total: GiB, disk_total: diskTotal, agent_version: "1.2.0",
      // As the hub answers: a node connected but never reported has no last
      // report, so 0 and null rather than a time.
      ...(state === "fresh" ? { last_seen: 0, last_seen_ago: null }
        : { last_seen: online ? now : now - OFFLINE_FOR, last_seen_ago: online ? 0 : OFFLINE_FOR }),
      billing_cycle: cycle, currency, price,
      expires_at: expires === null ? null : plusDays(expires), expires_in: expires,
      traffic_limit: 1024 * GiB, traffic_mode: "sum", traffic_reset_day: 1, month_start: today().slice(0, 8) + "01",
      month_rx: month, month_tx: month / 2, month_used: month * 1.5,
      day_rx: Math.round(month / 20), day_tx: Math.round(month / 40), total_rx: total, total_tx: total / 2,
    }
  }

  const snapshot = () => {
    const now = Math.floor(Date.now() / 1000)
    return { admin: false, nodes: NODES.map((n) => node(n, now)) }
  }

  // Same bucketing as the hub: steps of a minute up to a week, of an hour beyond.
  function history(n, url) {
    const q = url.searchParams
    const hours = Math.min(Math.max(Number(q.get("hours")) || 6, 1), HISTORY_DAYS * 24)
    const budget = Math.min(Math.max(Number(q.get("points")) || 1440, 60), 1440)
    const unit = hours > 7 * 24 ? 3600 : 60
    const step = unit * Math.max(1, Math.ceil((hours * 3600) / unit / budget))
    const now = Math.floor(Date.now() / 1000)
    const since = Math.floor((now - hours * 3600) / step) * step
    const state = n.seed[8]
    // A node that has not reported yet has no history; an offline one stops
    // where it went offline.
    const until = state === "fresh" ? since - 1 : state === "offline" ? now - OFFLINE_FOR : now
    const { memTotal, diskTotal } = sizes(n.id)
    const series = q.get("series")
    const metrics = [], ping = [], loss = {}
    if (series !== "ping") for (let ts = since; ts <= until; ts += step) {
      const minutes = ts + step > until ? Math.max(1, Math.floor((until - ts) / 60)) : step / 60
      const s = sample(n.id, ts), peak = 1 + 2 * noise(n.id, ts, 11)
      metrics.push({
        ts, minutes, cpu: s.cpu, cpu_max: Math.min(100, s.cpu * peak),
        mem_used: Math.round(memTotal * (0.3 + 0.2 * noise(n.id, ts, 12))),
        disk_used: Math.round(diskTotal * (0.1 + 0.8 * noise(n.id, 10))),
        net_rx: s.rx, net_tx: s.tx, net_rx_max: Math.round(s.rx * peak), net_tx_max: Math.round(s.tx * peak),
      })
    }
    // Probe by probe, as the hub orders them. A bucket of several samples carries
    // the band they spread over, and the window's loss is listed only where some
    // was lost.
    if (series !== "metrics") for (const task_id of [1, 2, 3]) {
      let lost = 0, rows = 0
      for (let ts = since; ts <= until; ts += step, rows++) {
        if (noise(n.id, ts, task_id) < 0.03) {
          lost++
          ping.push({ ts, task_id, latency: null, loss: 100 })
          continue
        }
        const latency = Math.round(30 * task_id + 40 * noise(n.id, task_id) + 10 * noise(n.id, ts, task_id, 1))
        const spread = Math.round(2 + 15 * noise(n.id, ts, task_id, 2))
        const row = { ts, task_id, latency }
        if (step > 60) row.band = [latency - spread, latency + spread]
        ping.push(row)
      }
      if (lost) loss[task_id] = (100 * lost) / rows
    }
    return { metrics, ping, step, probes: series === "metrics" ? {} : { 1: "电信", 2: "联通", 3: "移动" }, loss }
  }

  // ---- routing ----

  const json = (body) => ({ status: 200, type: "application/json", body: JSON.stringify(body) })
  const text = (status, body) => ({ status, type: "text/plain; charset=utf-8", body })

  // The hub's answer to a request for `url`, or null for one that is not the
  // hub's to answer and goes out as usual.
  function answer(method, url) {
    if (url.origin !== location.origin || !url.pathname.startsWith("/api/")) return null
    const path = url.pathname
    if (method.toUpperCase() !== "GET") return text(403, "这是主题预览站，不能修改设置")
    if (path === "/api/me") {
      return json({ authed: false, github: false, history_days: HISTORY_DAYS, public_page: true, site: url.origin, site_name: "主题预览" })
    }
    if (path === "/api/nodes") return json(snapshot())
    if (path === "/api/ws") return text(426, "需要 WebSocket")
    const m = /^\/api\/nodes\/(\d+)\/metrics$/.exec(path)
    const target = m && NODES.find((n) => n.id === +m[1])
    if (target) return json(history(target, url))
    if (/^\/api\/themes\/[^/]+\/config$/.test(path)) return json({})
    return text(404, "主题预览站没有这个接口")
  }

  // Against the document's base, as the browser resolves a relative address.
  const resolve = (url) => new URL(url, document.baseURI)

  // Read off the arguments rather than through `new Request`, which would take
  // the body of a Request passed in and leave nothing for the native fetch.
  const nativeFetch = window.fetch
  window.fetch = function fetch(input, init) {
    let a = null
    try {
      const request = input instanceof Request ? input : null
      a = answer(init?.method ?? request?.method ?? "GET", resolve(request ? request.url : String(input)))
    } catch {}
    if (!a) return nativeFetch.call(this, input, init)
    return Promise.resolve(new Response(a.body, { status: a.status, headers: { "content-type": a.type } }))
  }

  // The answer is served from a blob URL, so every part of the native object
  // works as usual. A blob always answers 200: refusals and unknown paths keep
  // their text but not their status, which only writes and mistakes ever see.
  // `open` resolves the blob URL, so it is revoked at once.
  const NativeXHR = window.XMLHttpRequest
  window.XMLHttpRequest = class XMLHttpRequest extends NativeXHR {
    open(method, url, ...rest) {
      const a = answer(method, resolve(url))
      if (!a) return super.open(method, url, ...rest)
      const blob = URL.createObjectURL(new Blob([a.body], { type: a.type }))
      super.open("GET", blob, ...rest)
      URL.revokeObjectURL(blob)
    }
  }

  // ---- the socket ----

  // Pushes every two seconds like the hub's, the first at once. With `gzip`, as
  // the hub answers `?gzip`: the same JSON gzipped, in a binary message. The
  // browser sends nothing but its close, so whatever `send` is given is dropped.
  class PreviewSocket extends EventTarget {
    constructor(url, gzip) {
      super()
      Object.assign(this, {
        url: url.href.replace(/^http/, "ws"), readyState: 0, binaryType: "blob", protocol: "", extensions: "", bufferedAmount: 0,
        onopen: null, onmessage: null, onerror: null, onclose: null,
      })
      this._gzip = gzip
      setTimeout(() => {
        if (this.readyState !== 0) return
        this.readyState = 1
        this._emit(new Event("open"))
        this._push()
        this._timer = setInterval(() => this._push(), 2000)
      })
    }
    _emit(event) {
      this.dispatchEvent(event)
      this[`on${event.type}`]?.call(this, event)
    }
    async _push() {
      let data = JSON.stringify(snapshot())
      if (this._gzip) {
        const packed = new Response(new Blob([data]).stream().pipeThrough(new CompressionStream("gzip")))
        data = this.binaryType === "arraybuffer" ? await packed.arrayBuffer() : await packed.blob()
      }
      if (this.readyState === 1) this._emit(new MessageEvent("message", { data, origin: new URL(this.url).origin }))
    }
    send() {
      if (this.readyState === 0) throw new DOMException("Still in CONNECTING state.", "InvalidStateError")
    }
    close(code = 1000, reason = "") {
      if (this.readyState >= 2) return
      this.readyState = 2
      clearInterval(this._timer)
      setTimeout(() => {
        this.readyState = 3
        this._emit(new CloseEvent("close", { code, reason, wasClean: true }))
      })
    }
  }
  for (const [i, name] of ["CONNECTING", "OPEN", "CLOSING", "CLOSED"].entries()) PreviewSocket.prototype[name] = i

  // A Proxy rather than a subclass, so a socket elsewhere is the native one and
  // `WebSocket.OPEN` and the like still read from the native class. A stand-in
  // passes `instanceof WebSocket` as well.
  window.WebSocket = new Proxy(window.WebSocket, {
    get(Native, key) {
      if (key === Symbol.hasInstance) return (v) => v instanceof PreviewSocket || v instanceof Native
      return Reflect.get(Native, key)
    },
    construct(Native, args, newTarget) {
      const url = resolve(args[0])
      const hub = url.host === location.host && url.pathname === "/api/ws"
      return hub ? new PreviewSocket(url, url.searchParams.has("gzip")) : Reflect.construct(Native, args, newTarget)
    },
  })

  // Themes link to the hub's sign-in page, which a preview does not have: the
  // static host answers /admin with the theme's own page, stopped here before
  // the theme starts.
  if (/^\/admin(\/|$)/.test(location.pathname)) {
    window.stop()
    document.documentElement.innerHTML = "<head><meta charset=utf-8><meta name=viewport content='width=device-width'></head>"
      + "<body style='font:15px/1.6 system-ui,sans-serif;padding:16px'>这是主题预览站，没有后台。把主题装到你自己的 hub 上，再在那里登录。</body>"
  }
})()
