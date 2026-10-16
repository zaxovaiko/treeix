import { isJson, isString } from '@treeix/shared/json'
import { isCron } from './cron'
import { MAX_SCORE } from './workflow'

/** What a case's output must pass; a `command` runs in a shell and passes on exit 0, with the output as `$OUTPUT` */
export type EvalCheck =
  | { id: string; kind: 'contains' | 'regex'; value: string }
  | { id: string; kind: 'command'; command: string; folder: string | null }
  | { id: string; kind: 'judge'; agent: string; rubric: string; minScore: number }

/** One input and what its output must pass; `reference` is a known good output a judge compares with */
export type EvalCase = { id: string; name: string; input: string; reference: string | null; checks: EvalCheck[] }

/** Cases for one workflow or agent, run on demand and on `cron` */
export type EvalSuite = { id: string; name: string; target: { kind: 'workflow' | 'agent'; id: string }; cases: EvalCase[]; cron: string | null; updatedAt: number }

/** `runId` is the judge's own run, `score` its score */
export type CheckResult = { check: string; pass: boolean; detail: string; runId?: string; score?: number }

/** A case's outcome in one run of its suite; results of one run share `batch` */
export type EvalResult = { batch: string; at: number; case: string; name: string; runId: string | null; pass: boolean; score: number | null; checks: CheckResult[] }

export const CHECK_LABEL: Record<EvalCheck['kind'], string> = { contains: 'Contains', regex: 'Matches', command: 'Command passes', judge: 'A judge scores it' }

const isCheck = (value: unknown): value is EvalCheck => {
  if (!isJson(value) || !isString(value.id)) return false
  if (value.kind === 'contains' || value.kind === 'regex') return isString(value.value)
  if (value.kind === 'command') return isString(value.command) && (value.folder === null || isString(value.folder))
  return value.kind === 'judge' && isString(value.agent) && isString(value.rubric) && typeof value.minScore === 'number' && value.minScore >= 1 && value.minScore <= MAX_SCORE
}

const isCase = (value: unknown): value is EvalCase =>
  isJson(value) &&
  isString(value.id) &&
  isString(value.name) &&
  isString(value.input) &&
  (value.reference === null || isString(value.reference)) &&
  Array.isArray(value.checks) &&
  value.checks.every(isCheck)

export const isEvalSuite = (value: unknown): value is EvalSuite =>
  isJson(value) &&
  isString(value.id) &&
  isString(value.name) &&
  isJson(value.target) &&
  (value.target.kind === 'workflow' || value.target.kind === 'agent') &&
  isString(value.target.id) &&
  Array.isArray(value.cases) &&
  value.cases.every(isCase) &&
  (value.cron === null || (isString(value.cron) && isCron(value.cron))) &&
  typeof value.updatedAt === 'number'

export const isEvalResult = (value: unknown): value is EvalResult =>
  isJson(value) && isString(value.batch) && typeof value.at === 'number' && isString(value.case) && typeof value.pass === 'boolean' && Array.isArray(value.checks)

/** A suite's runs, newest first, each with how many of its cases passed */
export function batchesOf(results: EvalResult[]): { batch: string; at: number; passed: number; total: number; results: EvalResult[] }[] {
  const batches = new Map<string, EvalResult[]>()
  for (const result of results) batches.set(result.batch, [...(batches.get(result.batch) ?? []), result])
  return [...batches]
    .map(([batch, entries]) => ({ batch, at: entries[0].at, passed: entries.filter((entry) => entry.pass).length, total: entries.length, results: entries }))
    .sort((a, b) => b.at - a.at)
}
