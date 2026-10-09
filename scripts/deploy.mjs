// Publishes out/ (written by build.mjs) to Cloudflare Pages: each theme to the
// branch named by its alias, the gallery to main.
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/deploy.mjs
//
// A theme is redeployed only when it is new, its version changed, or the
// stand-in API changed, judged against the themes.json currently live. The
// gallery goes last, so it never links a preview that is not yet up and a
// failed run leaves the live index stating what is actually deployed. A theme
// no longer listed has its preview deleted: a delisted theme would otherwise
// remain served under this project's name.

import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "..")
const OUT = path.join(ROOT, "out")
const { CLOUDFLARE_API_TOKEN: TOKEN, CLOUDFLARE_ACCOUNT_ID: ACCOUNT } = process.env
if (!TOKEN || !ACCOUNT) throw new Error("CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are required")

const index = JSON.parse(fs.readFileSync(path.join(OUT, "site", "themes.json"), "utf8"))
const project = index.project
const API = `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT}/pages/projects/${project}`

async function cloudflare(url, init = {}) {
  const res = await fetch(url, { ...init, headers: { authorization: `Bearer ${TOKEN}` } })
  const body = await res.json()
  if (!body.success) throw new Error(`${init.method ?? "GET"} ${url}: ${JSON.stringify(body.errors)}`)
  return body
}

function deploy(dir, branch) {
  execFileSync("npx", ["--yes", "wrangler@4", "pages", "deploy", dir, "--project-name", project,
    "--branch", branch, "--commit-dirty=true"], { cwd: ROOT, stdio: "inherit" })
}

async function main() {
  const live = await fetch(`https://${project}.pages.dev/themes.json`, { cache: "no-store" })
    .then((r) => (r.ok ? r.json() : null), () => null)
  const before = new Map((live?.themes ?? []).map((t) => [t.alias, t]))

  for (const t of index.themes) {
    const prior = before.get(t.alias)
    if (live?.api === index.api && prior?.version === t.version && prior?.repo === t.repo) continue
    console.log(`deploying ${t.alias} ${t.version}`)
    deploy(path.join("out", "themes", t.alias), t.alias)
  }
  deploy(path.join("out", "site"), "main")

  const listed = new Set(index.themes.map((t) => t.alias))
  const gone = [...before.keys()].filter((a) => !listed.has(a))
  if (!gone.length) return
  // Listed in full before deleting, since each deletion shifts later pages.
  const doomed = []
  for (let page = 1; ; page++) {
    const { result } = await cloudflare(`${API}/deployments?env=preview&per_page=25&page=${page}`)
    if (!result.length) break
    doomed.push(...result.filter((d) => gone.includes(d.deployment_trigger?.metadata?.branch)))
  }
  for (const d of doomed) {
    console.log(`deleting ${d.deployment_trigger.metadata.branch} deployment ${d.id}`)
    await cloudflare(`${API}/deployments/${d.id}?force=true`, { method: "DELETE" })
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
