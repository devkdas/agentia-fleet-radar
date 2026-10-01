import {Command, Flags} from '@oclif/core'
import {execFileSync} from 'node:child_process'

const AI_TIMEOUT_MS = 120_000

function runAgentia(args: string[], cwd?: string, timeoutMs = 60_000): string {
  return execFileSync('agentia', args, {encoding: 'utf8', timeout: timeoutMs, stdio: ['ignore', 'pipe', 'pipe'], cwd})
}

function findStatus(node: unknown, depth = 0): string | null {
  if (node == null || depth > 4) return null
  if (typeof node === 'string') {
    const v = node.trim()
    if (/^(completed|complete|success|succeeded|successful|passed|pass|failed|failure|error|errored|cancelled|canceled|aborted|timeout|timed.?out)/i.test(v)) return v
    if (/(progress|running|queued|pending|started|executing|in.?progress|waiting)/i.test(v)) return v
    return null
  }
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findStatus(item, depth + 1)
      if (hit) return hit
    }
    return null
  }
  if (typeof node === 'object') {
    const obj = node as Record<string, unknown>
    for (const [key, value] of Object.entries(obj)) {
      if (/^(status|state|testresult)$/i.test(key) && typeof value === 'string' && value.trim() !== '') return value.trim()
    }
    for (const value of Object.values(obj)) {
      const hit = findStatus(value, depth + 1)
      if (hit) return hit
    }
  }
  return null
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

interface CheckState {
  name: string
  status: 'pass' | 'fail'
  detail: string
}

function checkDir(label: string, dir: string): {label: string; dir: string; reachable: boolean; checks: CheckState[]} {
  try {
    const parsed: any = JSON.parse(runAgentia(['auth', 'get', '--json'], dir))
    const creds: any[] = parsed?.result?.credentials ?? []
    const byType = (t: string) => creds.find((c) => c?.type === t)
    const crt = byType('crt')
    return {
      label,
      dir,
      reachable: true,
      checks: [
        byType('cicd')?.set
          ? {name: 'auth-cicd', status: 'pass', detail: 'CICD credentials stored.'}
          : {name: 'auth-cicd', status: 'fail', detail: 'CICD credentials missing.'},
        crt?.ready
          ? {name: 'auth-crt', status: 'pass', detail: 'CRT reports ready:true.'}
          : {name: 'auth-crt', status: 'fail', detail: `CRT not ready. Missing: ${Array.isArray(crt?.missing) ? crt.missing.join(', ') : 'unknown'}.`},
        byType('ai')?.set
          ? {name: 'auth-ai', status: 'pass', detail: 'AI credentials stored.'}
          : {name: 'auth-ai', status: 'fail', detail: 'AI credentials missing.'},
      ],
    }
  } catch (error: any) {
    return {
      label,
      dir,
      reachable: false,
      checks: [{name: 'org-reachable', status: 'fail', detail: `Could not read auth state: ${(error?.message ?? String(error)).split('\n')[0]}`}],
    }
  }
}

export default class FleetIncident extends Command {
  static description =
    'Triage a production incident across orgs: correlate readiness, test evidence, blast radius and an AI root cause.'

  static examples = [
    '<%= config.bin %> <%= command.id %> --dir ./proj-a --dir ./proj-b --story US-0000024',
    '<%= config.bin %> <%= command.id %> --dir ./proj-a --story US-0000024 --job 120561 --crt-project 76303 --json',
    '<%= config.bin %> <%= command.id %> --dir ./proj-a --ai-diagnose --json',
  ]

  static flags = {
    dir: Flags.string({char: 'd', description: 'Project directory holding one org context. Repeatable.', multiple: true, required: true}),
    label: Flags.string({char: 'l', description: 'Display label per dir, same order. Repeatable.', multiple: true}),
    story: Flags.string({char: 's', description: 'User story under incident for state context.'}),
    job: Flags.string({char: 'j', description: 'CRT job ID for latest test evidence. Repeatable.', multiple: true}),
    'crt-project': Flags.string({description: 'CRT project ID used with job IDs.'}),
    'graph-type': Flags.string({description: 'Metadata type for blast radius, for example ApexClass.'}),
    'graph-name': Flags.string({description: 'Metadata API name for blast radius.'}),
    'graph-credential-id': Flags.string({description: 'Credential ID for the blast lookup.'}),
    'graph-org-id': Flags.string({description: 'Org ID for the blast lookup.'}),
    'graph-pipeline-id': Flags.string({description: 'Pipeline ID for the blast lookup.'}),
    'ai-diagnose': Flags.boolean({description: 'Ask the operate agent for a root cause. Off by default.', default: false}),
    json: Flags.boolean({description: 'Machine readable JSON triage document.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(FleetIncident)
    const dirs = (flags.dir as string[] | undefined) ?? []
    const labels = (flags.label as string[] | undefined) ?? []
    const story = (flags.story as string | undefined) ?? null
    const jobs = (flags.job as string[] | undefined) ?? []
    const crtProject = (flags['crt-project'] as string | undefined) ?? null
    const graphType = (flags['graph-type'] as string | undefined) ?? null
    const graphName = (flags['graph-name'] as string | undefined) ?? null
    const graphCred = (flags['graph-credential-id'] as string | undefined) ?? null
    const graphOrg = (flags['graph-org-id'] as string | undefined) ?? null
    const graphPipeline = (flags['graph-pipeline-id'] as string | undefined) ?? null
    const aiDiagnose = (flags['ai-diagnose'] as boolean) ?? false
    const asJson = (flags.json as boolean) ?? false

    const orgs = dirs.map((dir, i) => checkDir(labels[i] ?? `org-${i + 1}`, dir))

    const failIndex = new Map<string, string[]>()
    for (const r of orgs) {
      for (const c of r.checks) {
        if (c.status === 'fail') {
          if (!failIndex.has(c.name)) failIndex.set(c.name, [])
          failIndex.get(c.name)?.push(r.label)
        }
      }
    }
    const fleetWide = [...failIndex.entries()]
      .filter(([, o]) => o.length >= 2)
      .map(([check, orgsList]) => ({check, orgs: orgsList}))

    let storyState: {found: boolean; name: string | null; status: string} = {found: false, name: story, status: 'unknown'}
    if (story) {
      try {
        const parsed: any = JSON.parse(runAgentia(['cicd', 'work', 'get', story, '--json']))
        const rec = parsed?.result ?? parsed
        storyState = {found: true, name: str(rec?.name) || story, status: str(rec?.status) || 'unknown'}
      } catch {
        storyState = {found: false, name: story, status: 'unreadable'}
      }
    }

    const tests: Array<{job: string; status: string; buildId: string | null}> = []
    if (jobs.length > 0 && crtProject) {
      for (const job of jobs) {
        try {
          const rows = rowsOf(JSON.parse(runAgentia(['testing', 'build', 'search', '-p', crtProject, '-j', job, '--page-size', '1', '--json'])))
          const latest = rows[0] ?? null
          const idRaw = latest?.id ?? latest?.buildId ?? latest?.build_id ?? null
          tests.push({job, status: (latest && findStatus(latest)) || 'unknown', buildId: idRaw == null ? null : String(idRaw)})
        } catch {
          tests.push({job, status: 'unreadable', buildId: null})
        }
      }
    }

    let blast: {center: string; upstreamCount: number; downstreamCount: number; status: string} | null = null
    if (graphType && graphName && graphCred && graphOrg && graphPipeline) {
      try {
        const out = runAgentia(['cicd', 'metadata', 'dependency', 'list', '--metadata-type', graphType,
          '--metadata-name', graphName, '--source-credential-id', graphCred, '--source-org-id', graphOrg,
          '--pipeline-id', graphPipeline, '--json'])
        const parsed: any = JSON.parse(out)
        const r = parsed?.result ?? parsed
        const deps: any[] = Array.isArray(r?.dependencies) ? r.dependencies : []
        let up = 0
        let down = 0
        for (const d of deps) {
          if (typeof d === 'object' && d !== null) {
            if (Array.isArray(d.u)) up += d.u.length
            if (Array.isArray(d.d)) down += d.d.length
          }
        }
        blast = {center: `${graphType}:${graphName}`, upstreamCount: up, downstreamCount: down, status: 'mapped'}
      } catch {
        blast = {center: `${graphType}:${graphName}`, upstreamCount: 0, downstreamCount: 0, status: 'unreadable'}
      }
    }

    const nextSteps: string[] = []
    if (fleetWide.length > 0) nextSteps.push('Treat as systemic: fix the shared cause once, not per org.')
    else if (failIndex.size > 0) nextSteps.push('Treat as isolated: fix the failing org locally.')
    if (tests.some((t) => /^(failed|failure|error)/i.test(t.status))) {
      nextSteps.push('Rerun the failing job with test auto, then ask the test agent for a failure summary.')
    }
    if (story) nextSteps.push('Gate the story with gov check before any promotion, and snapshot data with vault snapshot first.')
    if (blast && blast.downstreamCount > 0) nextSteps.push(`Review the ${blast.downstreamCount} downstream dependents before changing ${blast.center}.`)

    let aiDiagnosis: string | null = null
    if (aiDiagnose) {
      const prompt =
        `Triage this production incident in 3 sentences with one likely root cause plus the first fix step. ` +
        `Failures: ${[...failIndex.entries()].map(([c, o]) => `${c} on ${o.join(', ')}`).join('; ') || 'none'}. ` +
        `Story: ${storyState.name ?? 'none'} (${storyState.status}). ` +
        `Tests: ${tests.map((t) => `${t.job}=${t.status}`).join(', ') || 'none'}. ` +
        `Blast: ${blast ? `${blast.center} downstream ${blast.downstreamCount}` : 'none'}.`
      try {
        const out = runAgentia(['ai', 'agent', 'ask', '-p', prompt, '--agent', 'operate', '--json'], undefined, AI_TIMEOUT_MS)
        let parsed: unknown
        try {
          parsed = JSON.parse(out)
        } catch {
          parsed = out
        }
        aiDiagnosis = findAgentText(parsed)
      } catch {
        aiDiagnosis = null
      }
    }

    const out = {
      status: fleetWide.length > 0 ? 'fleet-wide' : failIndex.size > 0 ? 'isolated' : 'healthy',
      orgs: orgs.map((r) => ({label: r.label, reachable: r.reachable, checks: r.checks})),
      fleetWide,
      story: storyState,
      tests,
      blast,
      aiDiagnoseEnabled: aiDiagnose,
      aiDiagnosis,
      nextSteps,
    }

    if (asJson) {
      this.log(JSON.stringify(out, null, 2))
    } else {
      if (fleetWide.length === 0 && failIndex.size === 0) this.log(`Incident triage: fleet healthy across ${orgs.length} org contexts.`)
      else {
        for (const f of fleetWide) this.log(`[FLEET-WIDE] ${f.check} fails on ${f.orgs.join(', ')}. Escalate.`)
        for (const [check, orgsList] of failIndex) {
          if (orgsList.length === 1) this.log(`[ISOLATED] ${check} fails only on ${orgsList[0]}. Fix locally.`)
        }
      }
      if (story) this.log(`Story ${storyState.name ?? story}: ${storyState.status}.`)
      for (const t of tests) this.log(`Test job ${t.job}: ${t.status}${t.buildId ? ` (build ${t.buildId})` : ''}.`)
      if (blast) this.log(`Blast ${blast.center}: upstream ${blast.upstreamCount}, downstream ${blast.downstreamCount} (${blast.status}).`)
      if (aiDiagnosis) this.log(`AI diagnosis: ${aiDiagnosis}`)
      if (nextSteps.length > 0) {
        this.log('Next steps:')
        for (const n of nextSteps) this.log(`- ${n}`)
      }
    }
  }
}
