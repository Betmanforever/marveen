import { describe, it, expect, beforeEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, appendFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'

// Regression for kanban cab2c7e3: a Telegram message that arrives MID-TURN
// (async injection while a tool call is running) never passed through the
// UserPromptSubmit-only ledger-capture.py, so it was invisible to the
// live-drain and the SessionStart replay. ledger-midturn-scan.py is the second
// capture path: it scans the session transcript incrementally on PostToolUse
// and Stop. These tests run the real script end-to-end against a temp ledger.

const SCRIPT = join(process.cwd(), 'scripts', 'hooks', 'ledger-midturn-scan.py')
const CAPTURE = join(process.cwd(), 'scripts', 'hooks', 'ledger-capture.py')

let dir: string
let db: string
let transcript: string

function runScan(cwd = '/home/user/marveen/agents/neo') {
  execFileSync('python3', [SCRIPT], {
    input: JSON.stringify({ transcript_path: transcript, cwd }),
    env: { ...process.env, LEDGER_DB_PATH: db },
  })
}

function channelBlock(chatId: string, messageId: string, ts: string, text: string) {
  return `<channel source="plugin:telegram:telegram" chat_id="${chatId}" message_id="${messageId}" user="Owner" ts="${ts}">${text}</channel>`
}

function userLine(text: string) {
  return JSON.stringify({ type: 'user', message: { role: 'user', content: text } }) + '\n'
}

function rows() {
  const d = new Database(db)
  const r = d.prepare(
    'SELECT agent_id, chat_id, direction, message_id, text, created_at FROM conversation_log ORDER BY created_at, id'
  ).all() as any[]
  d.close()
  return r
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ledger-midturn-'))
  db = join(dir, 'ledger.db')
  transcript = join(dir, 'session.jsonl')
  // fresh offset state: the script keys offsets by transcript path, and each
  // test gets a unique temp path, so no cross-test bleed.
})

describe('ledger-midturn-scan.py', () => {
  it('captures a mid-turn channel message from the transcript (the lost-message bug)', () => {
    writeFileSync(
      transcript,
      JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'working...' } }) + '\n' +
      userLine('mid-turn: ' + channelBlock('42', '1600', '2026-07-11T06:15:00Z', 'M1 after Charlie...'))
    )
    runScan()
    const r = rows()
    expect(r).toHaveLength(1)
    expect(r[0]).toMatchObject({ agent_id: 'neo', chat_id: '42', direction: 'in', message_id: '1600' })
    expect(r[0].text).toBe('M1 after Charlie...')
    // created_at is the message's TRUE arrival time (ts attr), not scan time
    expect(r[0].created_at).toBe(Math.floor(Date.parse('2026-07-11T06:15:00Z') / 1000))
  })

  it('is idempotent across re-scans and offset resets', () => {
    writeFileSync(transcript, userLine(channelBlock('42', '1605', '2026-07-11T06:20:00Z', 'M1 full speed.')))
    runScan()
    runScan()
    runScan()
    expect(rows()).toHaveLength(1)
  })

  it('dedups against the UserPromptSubmit capture path (same message_id)', () => {
    const block = channelBlock('42', '1700', '2026-07-11T07:00:00Z', 'hello')
    execFileSync('python3', [CAPTURE], {
      input: JSON.stringify({ prompt: block, cwd: '/home/user/marveen/agents/neo' }),
      env: { ...process.env, LEDGER_DB_PATH: db },
    })
    writeFileSync(transcript, userLine(block))
    runScan()
    expect(rows()).toHaveLength(1)
  })

  it('scans incrementally: a later append is picked up by the next run', () => {
    writeFileSync(transcript, userLine(channelBlock('42', '1', '2026-07-11T07:01:00Z', 'first')))
    runScan()
    appendFileSync(transcript, userLine(channelBlock('42', '2', '2026-07-11T07:02:00Z', 'second')))
    runScan()
    const r = rows()
    expect(r.map((x) => x.message_id)).toEqual(['1', '2'])
  })

  it('does not create a phantom open question when the scan runs AFTER the reply was logged', () => {
    // Scenario: message arrives mid-turn at T, agent answers it, ledger-outbound
    // logs the reply, and only THEN does the scan capture the inbound. Because
    // created_at comes from the channel ts, the inbound still sorts BEFORE the
    // outbound -- so the open-question query must see it as answered.
    const arrivalTs = '2026-07-11T06:15:00Z'
    const d = new Database(db)
    d.exec(`CREATE TABLE IF NOT EXISTS conversation_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT, agent_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('in','out')), message_id TEXT, text TEXT, ts TEXT,
      created_at INTEGER NOT NULL, UNIQUE(agent_id, chat_id, direction, message_id))`)
    d.prepare(
      "INSERT INTO conversation_log (agent_id, chat_id, direction, message_id, text, ts, created_at) VALUES ('neo','42','out',NULL,'the reply','2026-07-11T06:16:00Z',?)"
    ).run(Math.floor(Date.parse('2026-07-11T06:16:00Z') / 1000))
    d.close()

    writeFileSync(transcript, userLine(channelBlock('42', '1600', arrivalTs, 'the question')))
    runScan()

    const openQuestion = execFileSync('python3', ['-c', [
      'import sys, os',
      "sys.path.insert(0, os.path.join(os.getcwd(), 'scripts', 'hooks'))",
      'import ledger_lib',
      "print(ledger_lib.open_question('neo'))",
    ].join('\n')], { env: { ...process.env, LEDGER_DB_PATH: db } }).toString().trim()
    expect(openQuestion).toBe('None') // answered -- no phantom re-injection
  })

  it('ignores partial (still-being-written) last lines, then reads them once complete', () => {
    const full = userLine(channelBlock('42', '9', '2026-07-11T08:00:00Z', 'complete'))
    const partial = JSON.stringify({ type: 'user', message: { role: 'user', content: channelBlock('42', '10', '2026-07-11T08:01:00Z', 'partial') } })
    writeFileSync(transcript, full + partial.slice(0, 40))
    runScan()
    expect(rows().map((x) => x.message_id)).toEqual(['9'])
    appendFileSync(transcript, partial.slice(40) + '\n')
    runScan()
    expect(rows().map((x) => x.message_id)).toEqual(['9', '10'])
  })

  it('handles content as an array of text blocks', () => {
    writeFileSync(transcript, JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: channelBlock('42', '11', '2026-07-11T08:05:00Z', 'block form') }] },
    }) + '\n')
    runScan()
    expect(rows().map((x) => x.message_id)).toEqual(['11'])
  })

  it('exits 0 and writes nothing on a missing transcript', () => {
    transcript = join(dir, 'nonexistent.jsonl')
    runScan()
    expect(existsSync(db)).toBe(false)
  })
})

describe('hook registration', () => {
  it('the scan hook is wired on PostToolUse and Stop in the shipped settings', () => {
    const settings = JSON.parse(
      execFileSync('cat', [join(process.cwd(), '.claude', 'settings.json')]).toString()
    )
    expect(JSON.stringify(settings.hooks.PostToolUse)).toContain('ledger-midturn-scan.py')
    expect(JSON.stringify(settings.hooks.Stop)).toContain('ledger-midturn-scan.py')
  })
})
