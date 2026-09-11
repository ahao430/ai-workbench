// 体积分析：node scripts/bundle-report.mjs [stats.html] —— 按 chunk × 包名聚合 rendered/gzip
import fs from 'node:fs'

const file = process.argv[2] ?? 'stats.html'
const d = JSON.parse(fs.readFileSync(file, 'utf8'))
const parts = d.nodeParts
const metas = d.nodeMetas

const byChunk = {}
for (const meta of Object.values(metas)) {
  const id = meta.id || ''
  let pkg = 'src'
  const nm = id.split('node_modules/')
  if (nm.length > 1) {
    const seg = nm[nm.length - 1].split('/')
    pkg = seg[0].startsWith('@') ? seg[0] + '/' + seg[1] : seg[0]
  }
  for (const [chunk, partUid] of Object.entries(meta.moduleParts ?? {})) {
    const p = parts[partUid]
    if (!p) continue
    const c = (byChunk[chunk] ??= { total: 0, gz: 0, pkgs: {} })
    c.total += p.renderedLength
    c.gz += p.gzipLength
    c.pkgs[pkg] = (c.pkgs[pkg] ?? 0) + p.renderedLength
  }
}

for (const [name, c] of Object.entries(byChunk).sort((a, b) => b[1].total - a[1].total).slice(0, 10)) {
  console.log(`== ${name.replace('assets/', '')}  rendered=${(c.total / 1048576).toFixed(2)}MB gzip=${(c.gz / 1048576).toFixed(2)}MB`)
  for (const [p, v] of Object.entries(c.pkgs).sort((a, b) => b[1] - a[1]).slice(0, 8))
    console.log(`   ${p.padEnd(34)}${(v / 1048576).toFixed(2)}MB`)
  console.log('')
}
