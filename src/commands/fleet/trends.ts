import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

function runAgentia(args: string[], cwd?: string, timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], cwd})
}

function rowsOf(parsed: any): any[] {
  if (!parsed || typeof parsed !== 'object') return []
  const r = parsed?.result ?? parsed
  if (Array.isArray(r)) return r
  for (const key of ['data', 'builds', 'jobs', 'runs']) {
    if (Array.isArray((r as Record<string, unknown>)?.[key])) return (r as Record<string, unknown>)[key] as any[]
  }
  return []
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : ''
}

export default class FleetTrends extends Command {
  static description =
    'Fleet failure trends from a local ledger. Record runs with fleet check --record first.'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --weeks 8 --json',
  ]

  static flags = {
    ledger: Flags.string({char: 'l', description: 'Ledger file recording fleet check runs.'}),
    weeks: Flags.integer({char: 'w', description: 'Weeks of history to summarize.', default: 4}),
    json: Flags.boolean({description: 'Machine readable JSON output.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(FleetTrends)
    const asJson = (flags.json as boolean) ?? false
    const weeks = Math.max(1, Math.min(26, (flags.weeks as number) ?? 4))

    let entries: any[] = []
    try {
      const out = runAgentia(['fleet', 'ledger', 'read', '--json'])
      const parsed = JSON.parse(out)
      entries = Array.isArray(parsed) ? parsed : rowsOf(parsed)
    } catch (error: any) {
      const detail = `Ledger unreadable. Record runs first with fleet check --record. ${(error?.message ?? String(error)).split('\n')[0].slice(0, 100)}`
      if (asJson) this.log(JSON.stringify({status: 'error', detail}, null, 2))
      else this.log(detail)
      this.exit(1)
    }

    const cutoff = Date.now() - weeks * 7 * 24 * 60 * 60 * 1000
    const recent = entries.filter((e) => Date.parse(str(e?.at) || '') >= cutoff)
    const byWeek = new Map<string, {runs: number; failures: number}>()
    for (const e of recent) {
      const week = str(e?.week) || new Date(Date.parse(str(e?.at))).toISOString().slice(0, 10)
      const row = byWeek.get(week) ?? {runs: 0, failures: 0}
      row.runs += 1
      row.failures += typeof e?.failures === 'number' ? e.failures : 0
      byWeek.set(week, row)
    }
    const series = [...byWeek.entries()].sort().map(([week, v]) => ({week, ...v}))
    let direction = 'flat'
    if (series.length >= 2) {
      const first = series[0].failures / Math.max(1, series[0].runs)
      const last = series[series.length - 1].failures / Math.max(1, series[series.length - 1].runs)
      direction = last < first ? 'improving' : last > first ? 'worsening' : 'flat'
    }
    const payload = {
      status: 'complete',
      weeks,
      runs: recent.length,
      direction,
      note: direction === 'flat' && recent.length === 0
        ? 'Ledger empty. Record runs with fleet check --record to start history.'
        : 'Direction compares failure rates first week versus last week in range.',
      series,
    }
    if (asJson) {
      this.log(JSON.stringify(payload, null, 2))
    } else if (recent.length === 0) {
      this.log('Ledger empty. Record runs with fleet check --record to start history.')
    } else {
      this.log(`Fleet trends over ${weeks} weeks: ${direction}, ${recent.length} recorded runs.`)
      for (const s of series) this.log(`  ${s.week}: ${s.failures} failures across ${s.runs} runs.`)
    }
  }
}
