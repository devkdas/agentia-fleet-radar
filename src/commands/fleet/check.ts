import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

const AI_TIMEOUT_MS = 120_000

function runAgentia(args: string[], cwd?: string, timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], cwd})
}

interface OrgResult {
  label: string
  dir: string
  reachable: boolean
  checks: Array<{name: string; status: 'pass' | 'fail'; detail: string}>
}

function checkOrg(label: string, dir: string): OrgResult {
  const checks: OrgResult['checks'] = []
  try {
    const out = runAgentia(['auth', 'get', '--json'], dir)
    const parsed: any = JSON.parse(out)
    const creds: any[] = parsed?.result?.credentials ?? []
    const byType = (t: string) => creds.find((c) => c?.type === t)
    const cicd = Boolean(byType('cicd')?.set)
    const crt = byType('crt')
    const ai = Boolean(byType('ai')?.set)
    checks.push(cicd
      ? {name: 'auth-cicd', status: 'pass', detail: 'CICD credentials stored.'}
      : {name: 'auth-cicd', status: 'fail', detail: 'CICD credentials missing.'})
    checks.push(crt?.ready
      ? {name: 'auth-crt', status: 'pass', detail: 'CRT reports ready:true.'}
      : {name: 'auth-crt', status: 'fail', detail: `CRT not ready. Missing: ${Array.isArray(crt?.missing) ? crt.missing.join(', ') : 'unknown'}.`})
    checks.push(ai
      ? {name: 'auth-ai', status: 'pass', detail: 'AI credentials stored.'}
      : {name: 'auth-ai', status: 'fail', detail: 'AI credentials missing.'})
    return {label, dir, reachable: true, checks}
  } catch (error: any) {
    return {
      label,
      dir,
      reachable: false,
      checks: [{name: 'org-reachable', status: 'fail', detail: `Could not read auth state: ${(error?.message ?? String(error)).split('\n')[0]}`}],
    }
  }
}

function findAgentText(node: unknown, depth = 0): string | null {
  if (node == null || depth > 3) return null
  if (typeof node === 'string') return node.trim() !== '' ? node.trim().slice(0, 2000) : null
  if (typeof node === 'object' && !Array.isArray(node)) {
    const obj = node as Record<string, unknown>
    for (const key of ['response', 'text', 'answer', 'message', 'content', 'output', 'summary']) {
      const v = obj[key]
      if (typeof v === 'string' && v.trim() !== '') return v.trim().slice(0, 2000)
    }
    if ('result' in obj) return findAgentText(obj['result'], depth + 1)
  }
  return null
}

export default class FleetCheck extends Command {
  static description =
    'Check readiness across org contexts and correlate fleet-wide versus isolated failures.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --dir ./proj-a --dir ./proj-b',
    '<%= config.bin %> <%= command.id %> --dir ./proj-a --dir ./proj-b --slack-webhook https://hooks.slack.com/xxx --json',
    '<%= config.bin %> <%= command.id %> --dir ./proj-a --dir ./proj-b --ai-suggest --json',
  ]

  static flags = {
    dir: Flags.string({char: 'd', description: 'Project directory holding one org context. Repeatable.', multiple: true, required: true}),
    label: Flags.string({char: 'l', description: 'Display label per dir, same order. Repeatable.', multiple: true}),
    'slack-webhook': Flags.string({description: 'Webhook URL for fleet-wide alerts. Optional.'}),
    'ai-suggest': Flags.boolean({description: 'Ask the plan agent for a fix on correlated failures. Off by default.', default: false}),
    json: Flags.boolean({char: 'j', description: 'Machine readable JSON summary.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(FleetCheck)
    const dirs = (flags.dir as string[] | undefined) ?? []
    const labels = (flags.label as string[] | undefined) ?? []
    const webhook = (flags['slack-webhook'] as string | undefined) ?? null
    const aiSuggest = (flags['ai-suggest'] as boolean) ?? false
    const asJson = (flags.json as boolean) ?? false

    const results: OrgResult[] = dirs.map((dir, i) => checkOrg(labels[i] ?? `org-${i + 1}`, dir))

    const failIndex = new Map<string, string[]>()
    for (const r of results) {
      for (const c of r.checks) {
        if (c.status === 'fail') {
          if (!failIndex.has(c.name)) failIndex.set(c.name, [])
          failIndex.get(c.name)?.push(r.label)
        }
      }
    }
    const fleetWide = [...failIndex.entries()]
      .filter(([, orgs]) => orgs.length >= 2)
      .map(([check, orgs]) => ({check, orgs}))
    const isolated = [...failIndex.entries()]
      .filter(([, orgs]) => orgs.length === 1)
      .map(([check, orgs]) => ({check, org: orgs[0]}))

    let aiSuggestion: string | null = null
    if (fleetWide.length > 0 && aiSuggest) {
      const prompt =
        `Correlated fleet failures need one fix suggestion in 3 sentences. ` +
        fleetWide.map((f) => `Check ${f.check} fails on ${f.orgs.join(', ')}.`).join(' ')
      try {
        const out = runAgentia(['ai', 'agent', 'ask', '-p', prompt, '--agent', 'plan', '--json'], undefined, AI_TIMEOUT_MS)
        let parsed: unknown
        try {
          parsed = JSON.parse(out)
        } catch {
          parsed = out
        }
        aiSuggestion = findAgentText(parsed)
      } catch {
        aiSuggestion = null
      }
    }

    const payload = {
      status: fleetWide.length > 0 ? 'fleet-wide' : failIndex.size > 0 ? 'isolated' : 'healthy',
      orgs: results,
      fleetWide,
      isolated,
      aiSuggestEnabled: aiSuggest,
      aiSuggestion,
    }

    if (webhook && fleetWide.length > 0) {
      try {
        let text =
          `Fleet alert: ${fleetWide.length} fleet-wide failure(s): ` +
          fleetWide.map((f) => `${f.check} on ${f.orgs.join(', ')}`).join('; ') + '.'
        if (aiSuggestion) text += `\nAI suggestion: ${aiSuggestion}`
        await fetch(webhook, {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({text}),
        })
      } catch {
        if (!asJson) this.log('Slack notification failed. Terminal verdict above still stands.');
      }
    }

    if (asJson) {
      this.log(JSON.stringify(payload, null, 2))
    } else if (fleetWide.length === 0 && failIndex.size === 0) {
      this.log(`Fleet healthy: ${results.length} org contexts, zero failing checks.`)
    } else {
      for (const f of fleetWide) this.log(`[FLEET-WIDE] ${f.check} fails on ${f.orgs.join(', ')}. Escalate, do not debug per org.`)
      for (const f of isolated) this.log(`[ISOLATED] ${f.check} fails only on ${f.org}. Fix locally.`)
      if (aiSuggestion) this.log(`AI suggestion: ${aiSuggestion}`)
    }
  }
}
