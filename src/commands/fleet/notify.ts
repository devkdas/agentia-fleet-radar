import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

function runAgentia(args: string[], cwd?: string, timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], cwd})
}

interface OrgDigest {
  label: string
  reachable: boolean
  pass: number
  fail: number
  failures: string[]
}

function digestDir(label: string, dir: string): OrgDigest {
  try {
    const parsed: any = JSON.parse(runAgentia(['auth', 'get', '--json'], dir))
    const creds: any[] = parsed?.result?.credentials ?? []
    const byType = (t: string) => creds.find((c) => c?.type === t)
    const crt = byType('crt')
    const results: Array<{name: string; ok: boolean}> = [
      {name: 'CICD', ok: Boolean(byType('cicd')?.set)},
      {name: 'CRT', ok: Boolean(crt?.ready)},
      {name: 'AI', ok: Boolean(byType('ai')?.set)},
    ]
    return {
      label,
      reachable: true,
      pass: results.filter((r) => r.ok).length,
      fail: results.filter((r) => !r.ok).length,
      failures: results.filter((r) => !r.ok).map((r) => r.name),
    }
  } catch (error: any) {
    return {
      label,
      reachable: false,
      pass: 0,
      fail: 1,
      failures: [`unreachable: ${(error?.message ?? String(error)).split('\n')[0].slice(0, 120)}`],
    }
  }
}

export default class FleetNotify extends Command {
  static description =
    'Send a formatted fleet status digest to a webhook. Deterministic text, no AI involved.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --dir ./proj-a --dir ./proj-b --webhook https://hooks.slack.com/xxx',
    '<%= config.bin %> <%= command.id %> --dir ./proj-a --webhook https://hooks.slack.com/xxx --json',
  ]

  static flags = {
    dir: Flags.string({char: 'd', description: 'Project directory holding one org context. Repeatable.', multiple: true, required: true}),
    label: Flags.string({char: 'l', description: 'Display label per dir, same order. Repeatable.', multiple: true}),
    webhook: Flags.string({char: 'w', description: 'Webhook URL receiving the digest.', required: true}),
    json: Flags.boolean({description: 'Machine readable JSON output.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(FleetNotify)
    const dirs = (flags.dir as string[] | undefined) ?? []
    const labels = (flags.label as string[] | undefined) ?? []
    const webhook = flags.webhook as string
    const asJson = (flags.json as boolean) ?? false

    const digests: OrgDigest[] = dirs.map((dir, i) => digestDir(labels[i] ?? `org-${i + 1}`, dir))
    const failing = digests.filter((d) => d.fail > 0)
    const headline = failing.length === 0
      ? `Fleet status GREEN: ${digests.length} org contexts, all checks passing.`
      : `Fleet status ATTENTION: ${failing.length} of ${digests.length} org contexts failing: ` +
        failing.map((d) => `${d.label} (${d.failures.join(', ')})`).join('; ') + '.'
    const lines = [headline, `Checked at ${new Date().toISOString()}.`]
    for (const d of digests) {
      lines.push(`- ${d.label}: ${d.reachable ? `${d.pass} pass, ${d.fail} fail` : 'unreachable'}${d.failures.length > 0 ? ` [${d.failures.join(', ')}]` : ''}`)
    }
    const text = lines.join('\n')

    let delivered = false
    let deliveryDetail = ''
    try {
      const res = await fetch(webhook, {
        method: 'POST',
        headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({text}),
      })
      delivered = res.ok
      deliveryDetail = res.ok ? `Delivered, HTTP ${res.status}.` : `Webhook refused with HTTP ${res.status}. Digest above still stands.`
    } catch (error: any) {
      deliveryDetail = `Delivery failed: ${(error?.message ?? String(error)).split('\n')[0]}. Digest above still stands.`
    }

    const payload = {
      status: failing.length === 0 ? 'green' : 'attention',
      orgCount: digests.length,
      failingOrgs: failing.map((d) => d.label),
      delivered,
      text,
    }
    if (asJson) {
      this.log(JSON.stringify({...payload, deliveryDetail}, null, 2))
    } else {
      this.log(text)
      this.log(deliveryDetail)
    }
    if (!delivered) this.exit(1)
  }
}
