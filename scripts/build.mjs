// Checks every theme in themes.txt against a real hub and writes the site.
//
//   node scripts/build.mjs <hub binary> [--base <themes.txt of the target branch>]
//
// Output in out/: site/ (the gallery, themes.json, previews/) and
// themes/<alias>/ (one preview deployment per theme).
//
// Exit status: 0 when every entry passes, 2 when some fail (the output is still
// complete without them), 1 on an error of this script's own or when GitHub or
// the hub cannot be reached, leaving the site as it was. With --base, only
// entries absent from that list can cause a 2: a pull request is not failed for
// a theme it did not add.

import { spawn, execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import fs from "node:fs"
import path from "node:path"

const [hubBinary, ...rest] = process.argv.slice(2)
const base = rest[0] === "--base" ? rest[1] : null
if (!hubBinary) throw new Error("usage: build.mjs <hub binary> [--base <file>]")

const ROOT = path.resolve(import.meta.dirname, "..")
const OUT = path.join(ROOT, "out")
const WORK = path.join(OUT, ".hub")
const PROJECT = process.env.PAGES_PROJECT || "monitor-themes"
const PORT = 9911
const HUB = `http://127.0.0.1:${PORT}`

// Pages reads these from a deployment as configuration or server code: with
// _worker.js present, a theme would run its own code with the project's
// environment. 404.html is dropped so unknown paths fall back to index.html,
// as the hub serves them.
const STRIPPED = ["_worker.js", "_routes.json", "_redirects", "_headers", "404.html"]

// The stand-in hub, served beside each theme and loaded first in each of its
// pages. Root-relative, since a client route such as /node/3 is answered with
// index.html as well.
const HUB_SCRIPT = "monitor-preview-hub.js"
const HUB_TAG = `<script src="/${HUB_SCRIPT}"></script>`

// A branch alias is the name lowercased with every other character a hyphen.
// Beyond 28 characters Pages truncates it and appends a random suffix (measured
// 2026-10-04), which would leave the preview address unknowable in advance.
const alias = (short) => short.toLowerCase().replace(/[^a-z0-9]/g, "-")
const MAX_ALIAS = 28

function entries(file) {
  return fs.readFileSync(file, "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"))
}

// The same two segments the hub's own parser keeps; anything else in the line
// is refused rather than ignored, so the list stays one canonical form.
function repoOf(line) {
  const m = /^https:\/\/github\.com\/([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)$/.exec(line)
  return m ? `${m[1]}/${m[2]}` : null
}

// A failure that says nothing about the theme being checked. It ends the run
// rather than failing the entry: on the daily run a failed entry is taken off
// the site and its preview deleted, which one outage would do to every theme.
class Outage extends Error {}

async function github(url, accept = "application/vnd.github+json") {
  const headers = { accept, "x-github-api-version": "2022-11-28" }
  if (process.env.GITHUB_TOKEN) headers.authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  const unreachable = (e) => {
    throw new Outage(`GitHub unreachable for ${url}: ${e.message}`)
  }
  const res = await fetch(url.startsWith("https://") ? url : `https://api.github.com/${url}`, { headers })
    .catch(unreachable)
  if (res.status === 404) return null
  const limited = res.headers.get("x-ratelimit-remaining") === "0"
  if (res.status >= 500 || res.status === 401 || res.status === 429 || limited) {
    throw new Outage(`GitHub ${res.status} for ${url}`)
  }
  if (!res.ok) throw new Error(`GitHub ${res.status} for ${url}: ${await res.text()}`)
  return (accept.includes("json") ? res.json() : res.arrayBuffer().then((b) => Buffer.from(b))).catch(unreachable)
}

// ---- the hub ----

async function startHub() {
  fs.rmSync(WORK, { recursive: true, force: true })
  fs.mkdirSync(WORK, { recursive: true })
  const db = path.join(WORK, "monitor.db")
  const args = ["--listen", `127.0.0.1:${PORT}`, "--db", db, "--themes", path.join(WORK, "themes")]
  const hub = spawn(hubBinary, args, { stdio: ["ignore", "ignore", "inherit"] })
  // However the run ends, including a failure before the first theme.
  process.on("exit", () => hub.kill())
  for (let i = 0; ; i++) {
    if (await fetch(`${HUB}/api/me`).then((r) => r.ok, () => false)) break
    if (i > 100) throw new Error("hub did not start")
    await new Promise((r) => setTimeout(r, 100))
  }
  // A running hub reads the password hash on every sign-in, so resetting it
  // beside the live process takes effect without a restart.
  const out = execFileSync(hubBinary, ["--db", db, "--reset-password"], { encoding: "utf8" })
  const password = /^Emergency password: (\S+)$/m.exec(out)[1]
  const res = await fetch(`${HUB}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ password }),
  })
  if (!res.ok) throw new Error(`hub sign-in failed: ${await res.text()}`)
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ")
  return { cookie, themes: path.join(WORK, "themes") }
}

// Through the panel's upload route, in the pieces it accepts, so the archive
// meets exactly the checks a user's hub applies. The answer to a refused
// archive is the hub's own sentence, which is what the author needs to read.
async function install(cookie, archive) {
  const PIECE = 8 << 20
  for (let offset = 0; offset < archive.length; offset += PIECE) {
    const res = await fetch(`${HUB}/api/themes?offset=${offset}&total=${archive.length}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/octet-stream" },
      body: archive.subarray(offset, offset + PIECE),
    }).catch((e) => {
      throw new Outage(`hub unreachable: ${e.message}`)
    })
    if (!res.ok) throw new Error(`hub 拒绝安装：${await res.text()}`)
    const body = await res.json()
    if (body.theme) return body.theme
  }
  throw new Error("hub 没有确认安装完成")
}

// ---- one entry ----

async function check(line, cookie, themes) {
  const repo = repoOf(line)
  if (!repo) throw new Error("地址要写成 https://github.com/<owner>/<repo>，不带结尾的 / 和 .git")
  const info = await github(`repos/${repo}`)
  if (!info) throw new Error("仓库不存在或不是公开仓库")
  if (info.full_name !== repo) throw new Error(`仓库地址已变为 https://github.com/${info.full_name}，请更新登记`)

  // Every problem is collected before failing, so an author fixes them in one
  // round. Only a missing package stops the check early: the rest is read from it.
  const problems = []
  // The file rather than GitHub's detection of it: a recognised licence with an
  // added line of attribution is reported as none.
  const files = (await github(`repos/${repo}/contents`)) ?? []
  if (!files.some((f) => f.type === "file" && /^(licen[cs]e|copying)(\.|$)/i.test(f.name))) {
    problems.push("仓库根目录没有许可证文件（LICENSE）")
  }

  const release = await github(`repos/${repo}/releases/latest`)
  if (!release) throw new Error([...problems, "仓库没有正式 release（预发布和草稿不算）"].join("；"))
  let asset = release.assets.find((a) => a.name === "theme.tar.gz")
  if (!asset) {
    const names = release.assets.map((a) => a.name).join("、") || "无"
    problems.push(`release ${release.tag_name} 里没有名为 theme.tar.gz 的文件（现有：${names}）`)
    // A sole archive under another name is most likely the theme: checked
    // anyway, so the rest of what needs fixing is reported in the same round.
    const archives = release.assets.filter((a) => a.name.endsWith(".tar.gz"))
    if (archives.length !== 1) throw new Error(problems.join("；"))
    asset = archives[0]
  }
  const archive = await github(asset.url, "application/octet-stream")
  let theme
  try {
    theme = await install(cookie, archive)
  } catch (e) {
    throw new Error([...problems, e.message].join("；"))
  }

  const dir = path.join(themes, theme.short)
  const url = theme.url.replace(/\/+$/, "").replace(/\.git$/, "")
  if (url.toLowerCase() !== `https://github.com/${repo}`.toLowerCase()) {
    problems.push(`theme.json 的 url 是 ${JSON.stringify(theme.url)}，应为 https://github.com/${repo}`)
  }
  if (release.tag_name.replace(/^v/, "") !== theme.version) {
    problems.push(`theme.json 的 version 是 ${JSON.stringify(theme.version)}，与 tag ${release.tag_name} 不符`)
  }
  if (!fs.existsSync(path.join(dir, "preview.png"))) problems.push("主题包里没有 preview.png")
  const name = alias(theme.short)
  if (name.length > MAX_ALIAS) problems.push(`short 超过 ${MAX_ALIAS} 个字符`)
  if (name === "main") problems.push("short 不能是 main")
  // A DNS label neither starts nor ends with a hyphen.
  if (/^-|-$/.test(name)) problems.push("short 不能以 - 或 _ 开头或结尾")
  if (theme.short === "default" && info.owner.login !== "monitor-probe") {
    problems.push("short 不能是 default，它会顶替 hub 内置的默认主题")
  }
  if (problems.length) throw new Error(problems.join("；"))

  return {
    dir,
    entry: {
      name: theme.name,
      short: theme.short,
      alias: name,
      description: theme.description,
      author: theme.author,
      version: theme.version,
      repo: info.html_url,
      official: info.owner.login === "monitor-probe",
      released: release.published_at,
    },
  }
}

// ---- output ----

// First in <head>, so the stand-in hub is in place before any of the theme's
// scripts runs. Without a <head>, right after the doctype: anything before it
// would switch the page to quirks mode. Comments are blanked for the search, so
// a <head> written inside one is not taken for the element.
function inject(html) {
  const bare = html.replace(/<!--[\s\S]*?-->/g, (c) => " ".repeat(c.length))
  const at = /<head\b[^>]*>/i.exec(bare) ?? /^\s*(<!doctype[^>]*>)?/i.exec(bare)
  const end = at.index + at[0].length
  return html.slice(0, end) + HUB_TAG + html.slice(end)
}

function preview(from, to) {
  fs.cpSync(from, to, { recursive: true })
  for (const name of STRIPPED) fs.rmSync(path.join(to, name), { recursive: true, force: true })
  for (const file of fs.readdirSync(to, { recursive: true })) {
    if (!/\.html?$/i.test(file)) continue
    const full = path.join(to, file)
    // Byte for byte, so a page in an encoding other than UTF-8 is left intact.
    fs.writeFileSync(full, inject(fs.readFileSync(full, "latin1")), "latin1")
  }
  fs.copyFileSync(path.join(ROOT, "preview", "hub.js"), path.join(to, HUB_SCRIPT))
}

// Changes to the stand-in hub, or to how a preview is put together here, reach
// a theme only when its preview is redeployed, so their digest is part of what
// decides whether to redeploy.
function apiDigest() {
  const hash = createHash("sha256")
  for (const file of ["preview/hub.js", "scripts/build.mjs"]) hash.update(fs.readFileSync(path.join(ROOT, file)))
  return hash.digest("hex").slice(0, 16)
}

async function main() {
  const known = base && fs.existsSync(base) ? new Set(entries(base).map((l) => l.toLowerCase())) : null
  const isNew = (line) => !known || !known.has(line.toLowerCase())
  // Entries already listed go first, so that a line a pull request inserts
  // above one of them cannot take its preview address and still pass.
  const lines = entries(path.join(ROOT, "themes.txt")).sort((a, b) => isNew(a) - isNew(b))

  for (const dir of ["site", "themes"]) fs.rmSync(path.join(OUT, dir), { recursive: true, force: true })
  fs.cpSync(path.join(ROOT, "site"), path.join(OUT, "site"), { recursive: true })
  fs.mkdirSync(path.join(OUT, "site", "previews"), { recursive: true })
  fs.mkdirSync(path.join(OUT, "themes"), { recursive: true })

  const { cookie, themes } = await startHub()
  const listed = [], failed = [], seen = new Set()
  for (const line of lines) {
    // The later of two identical lines is always the one being added.
    const duplicate = seen.has(line.toLowerCase())
    seen.add(line.toLowerCase())
    try {
      if (duplicate) throw new Error("重复登记")
      const { dir, entry } = await check(line, cookie, themes)
      const clash = listed.find((t) => t.alias === entry.alias)
      if (clash) throw new Error(`short 与已收录的 ${clash.repo} 冲突（预览地址都是 ${entry.alias}）`)
      preview(path.join(dir, "dist"), path.join(OUT, "themes", entry.alias))
      fs.copyFileSync(path.join(dir, "preview.png"), path.join(OUT, "site", "previews", `${entry.alias}.png`))
      listed.push(entry)
      console.log(`ok    ${line} → ${entry.short} ${entry.version}`)
    } catch (e) {
      if (e instanceof Outage) throw e
      failed.push({ line, reason: e.message, new: duplicate || isNew(line) })
      console.log(`fail  ${line}：${e.message}`)
    }
  }

  listed.sort((a, b) => b.released.localeCompare(a.released))
  const index = { project: PROJECT, api: apiDigest(), built: new Date().toISOString(), themes: listed }
  fs.writeFileSync(path.join(OUT, "site", "themes.json"), JSON.stringify(index, null, 2))

  const summary = [
    `收录 ${listed.length} 个，未通过 ${failed.length} 个`,
    ...failed.map((f) => `- ${f.new ? "" : "（已收录）"}${f.line}：${f.reason}`),
  ].join("\n")
  console.log(`\n${summary}`)
  if (process.env.GITHUB_STEP_SUMMARY) fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary + "\n")
  process.exit(failed.some((f) => f.new) ? 2 : 0)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
