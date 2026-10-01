import {Command, Flags} from '@oclif/core'
import {appendFileSync, existsSync, mkdirSync, readFileSync} from 'node:fs'
import {homedir} from 'node:os'
import {join} from 'node:path'

export function ledgerPath(): string {
  return join(homedir(), '.agentia-fleet-radar', 'history.jsonl')
}

export default class FleetLedger extends Command {
  static description =
    'Read the local fleet check history ledger. Entries are appended by fleet check --record.'

  static examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ]

  static flags = {
    json: Flags.boolean({char: 'j', description: 'Machine readable JSON lines array.', default: false}),
  }

  public async run(): Promise<void> {
    const {flags} = await this.parse(FleetLedger)
    const asJson = (flags.json as boolean) ?? false
    const path = ledgerPath()
    if (!existsSync(path)) {
      if (asJson) this.log(JSON.stringify([], null, 2))
      else this.log('Ledger empty. Record runs with fleet check --record to start history.')
      return
    }
    const entries: any[] = []
    for (const line of readFileSync(path, 'utf8').split('\n')) {
      const trimmed = line.trim()
      if (trimmed === '') continue
      try {
        entries.push(JSON.parse(trimmed))
      } catch {
        continue
      }
    }
    if (asJson) this.log(JSON.stringify(entries, null, 2))
    else this.log(`${entries.length} recorded fleet runs in the ledger.`)
  }
}

export function appendLedger(entry: Record<string, unknown>): void {
  mkdirSync(join(homedir(), '.agentia-fleet-radar'), {recursive: true})
  appendFileSync(ledgerPath(), JSON.stringify({at: new Date().toISOString(), ...entry}) + '\n', 'utf8')
}
