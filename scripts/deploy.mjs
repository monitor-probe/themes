// Publishes out/ (written by build.mjs) to Cloudflare Pages: each theme to the
// branch named by its alias, the gallery to main.
//
//   CLOUDFLARE_API_TOKEN=… CLOUDFLARE_ACCOUNT_ID=… node scripts/deploy.mjs
//
// A theme is redeployed only when it is new, its version changed, or the
// stand-in API changed, judged against the themes.json currently live. The
// gallery goes last, so it never links a preview that is not yet up and a
// failed run leaves the live index stating what is actually deployed.
//
// Then every deployment but the newest successful one of each listed branch is
// deleted. Each stays reachable at its own address with whatever theme version,
// stand-in hub and server code it was built with, so a delisted theme or a
// superseded release would otherwise remain served under this project's name.

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

  // Listed in full before deleting, since each deletion shifts later pages.
  const all = []
  for (const env of ["production", "preview"]) {
    for (let page = 1; ; page++) {
      const { result } = await cloudflare(`${API}/deployments?env=${env}&per_page=25&page=${page}`)
      if (!result.length) break
      all.push(...result)
    }
  }
  for (const d of superseded(all, new Set(["main", ...index.themes.map((t) => t.alias)]))) {
    console.log(`deleting ${branch(d)} deployment ${d.id}`)
    await cloudflare(`${API}/deployments/${d.id}?force=true`, { method: "DELETE" })
  }
}

const branch = (d) => d.deployment_trigger?.metadata?.branch

// Everything but the deployments of each branch in `served` its alias may point
// at: the newest successful one, and the newest of all, which the API can list
// before reporting its success.
function superseded(deployments, served) {
  const kept = new Set()
  const newest = new Set(), succeeded = new Set()
  for (const d of [...deployments].sort((a, b) => b.created_on.localeCompare(a.created_on))) {
    const b = branch(d)
    if (!served.has(b)) continue
    const ok = d.latest_stage?.status === "success"
    if (!newest.has(b) || (ok && !succeeded.has(b))) kept.add(d.id)
    newest.add(b)
    if (ok) succeeded.add(b)
  }
  return deployments.filter((d) => !kept.has(d.id))
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
