#!/usr/bin/env node
// Recomputes every progress bar in TASKS.md from its checkboxes, so a bar can never disagree with
// the boxes beneath it.
//
//   node scripts/tasks-progress.mjs           rewrite TASKS.md in place
//   node scripts/tasks-progress.mjs --check   exit 1 if any bar is stale (nothing written)
//
// A bar is the text between `<!-- bar -->` and `<!-- /bar -->`. Its scope is the section of the
// heading it sits on (or the heading just above it): every `- [x]` / `- [ ]` line until the next
// heading of the same or a higher level. `<!-- bar:overall -->` counts the whole file. A line
// `<!-- updated -->…<!-- /updated -->` receives today's date.
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const file = join(dirname(fileURLToPath(import.meta.url)), '..', 'TASKS.md')
const check = process.argv.includes('--check')

const raw = readFileSync(file, 'utf8')
const eol = raw.includes('\r\n') ? '\r\n' : '\n'
const lines = raw.split(/\r?\n/)

const BOX = /^\s*- \[( |x|X)\] /
const HEADING = /^(#{1,6}) /
const BAR = /<!-- bar(:overall)? -->.*?<!-- \/bar -->/

function headingLevel(line) {
  const m = HEADING.exec(line)
  return m ? m[1].length : 0
}

function count(from, to) {
  let done = 0
  let total = 0
  for (let i = from; i < to; i++) {
    const m = BOX.exec(lines[i])
    if (!m) continue
    total++
    if (m[1] !== ' ') done++
  }
  return { done, total }
}

function render({ done, total }, width) {
  const pct = total === 0 ? 0 : Math.floor((done / total) * 100)
  const filled = total === 0 ? 0 : Math.round((done / total) * width)
  const icon = total > 0 && done === total ? '✅' : done > 0 ? '🟡' : '⬜'
  return `${icon} \`${'█'.repeat(filled)}${'░'.repeat(width - filled)}\` **${pct}%** · ${done}/${total}`
}

const out = lines.map((line, i) => {
  const m = BAR.exec(line)
  if (!m) return line
  if (m[1]) {
    return line.replace(BAR, `<!-- bar:overall -->${render(count(0, lines.length), 30)}<!-- /bar -->`)
  }
  // Scope = the heading on this line, else the nearest heading above it.
  let h = i
  while (h >= 0 && headingLevel(lines[h]) === 0) h--
  const level = h >= 0 ? headingLevel(lines[h]) : 1
  let end = h + 1
  while (end < lines.length && !(headingLevel(lines[end]) > 0 && headingLevel(lines[end]) <= level)) end++
  const width = level <= 2 ? 20 : 10
  return line.replace(BAR, `<!-- bar -->${render(count(h + 1, end), width)}<!-- /bar -->`)
})

const today = new Date().toISOString().slice(0, 10)
const result = out
  .map((l) => l.replace(/<!-- updated -->.*?<!-- \/updated -->/, `<!-- updated -->${today}<!-- /updated -->`))
  .join(eol)

// --check compares bars only; the date is allowed to differ.
const strip = (s) => s.replace(/<!-- updated -->.*?<!-- \/updated -->/, '')
if (check) {
  if (strip(result) !== strip(raw)) {
    console.error('TASKS.md progress bars are stale — run: node scripts/tasks-progress.mjs')
    process.exit(1)
  }
  console.log('TASKS.md progress bars match the checkboxes')
} else {
  writeFileSync(file, result)
  const total = count(0, lines.length)
  console.log(`TASKS.md updated — ${total.done}/${total.total} subtasks verified`)
}
