import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import ts from 'typescript'
import type { Column, Relation, Schema, Table } from '../shared/types'

const exec = promisify(execFile)

const TABLE_FUNCTION = /^(pg|mysql|sqlite|singlestore|gel)Table$/
const TABLE_FACTORY = /^(pg|mysql|sqlite|singlestore|gel)(TableCreator|Schema)$/
const ENUM_FUNCTION = /^(pg|gel)Enum$/
const DEFAULT_MODIFIERS = new Set([
  'default',
  'defaultNow',
  'defaultRandom',
  '$default',
  '$defaultFn',
  'generatedAlwaysAsIdentity',
  'generatedByDefaultAsIdentity',
  'autoincrement'
])
const SOURCE_GLOBS = ['*.ts', '*.mts', '*.cts', '*.js', '*.mjs']

type ColumnRef = { table: string; column: string }
/** `to` is known already for a table pointing at itself through its extras' parameter */
type PendingRelation = { from: string; columns: string[]; toVariable: string; toColumns: string[]; to?: string }

const calleeName = (call: ts.CallExpression): string | null =>
  ts.isIdentifier(call.expression) ? call.expression.text : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : null

const stringArg = (call: ts.CallExpression): string | null => {
  const first = call.arguments[0]
  return first && ts.isStringLiteralLike(first) ? first.text : null
}

/** `users.id` or `t.id`; also the body of `() => users.id` */
function columnRef(node: ts.Node): ColumnRef | null {
  if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) {
    const body = ts.isArrowFunction(node) && !ts.isBlock(node.body) ? node.body : null
    return body ? columnRef(body) : null
  }
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) return columnRef(node.expression)
  return ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) ? { table: node.expression.text, column: node.name.text } : null
}

const refsIn = (node: ts.Expression | undefined): ColumnRef[] => (node && ts.isArrayLiteralExpression(node) ? node.elements.flatMap((element) => columnRef(element) ?? []) : [])

/** The object literal a columns argument is, or returns: `{ ... }` and `(t) => ({ ... })` */
function objectOf(node: ts.Node | undefined): ts.ObjectLiteralExpression | null {
  if (!node) return null
  if (ts.isObjectLiteralExpression(node)) return node
  if (ts.isParenthesizedExpression(node)) return objectOf(node.expression)
  if (ts.isArrowFunction(node) && !ts.isBlock(node.body)) return objectOf(node.body)
  return null
}

/** Walks `integer('org_id').notNull().references(() => orgs.id)` from the outside in */
function readColumn(key: string, expression: ts.Expression, enums: Map<string, string>): { column: Column; references: ColumnRef | null } | null {
  const column: Column = { key, name: key, type: '', primaryKey: false, notNull: false, unique: false, hasDefault: false }
  let references: ColumnRef | null = null
  let node: ts.Expression = expression
  while (ts.isCallExpression(node)) {
    const callee = node.expression
    const base = ts.isIdentifier(callee) || (ts.isPropertyAccessExpression(callee) && !ts.isCallExpression(callee.expression))
    const name = calleeName(node) ?? ''
    if (base) {
      column.type = enums.get(name) ?? name
      column.name = stringArg(node) ?? key
      break
    }
    if (name === 'primaryKey') column.primaryKey = column.notNull = true
    else if (name === 'notNull') column.notNull = true
    else if (name === 'unique') column.unique = true
    else if (DEFAULT_MODIFIERS.has(name)) column.hasDefault = true
    else if (name === 'references' && node.arguments[0]) references = columnRef(node.arguments[0])
    node = (callee as ts.PropertyAccessExpression).expression
  }
  if (!column.type) return null
  if (/serial$/i.test(column.type)) column.notNull = column.hasDefault = true
  return { column, references }
}

/** The table call inside `pgTable(...)`, `pgTable(...).enableRLS()` or `schema.table(...)` */
function tableCall(node: ts.Expression, factories: Set<string>): ts.CallExpression | null {
  if (!ts.isCallExpression(node)) return null
  const callee = node.expression
  if (ts.isIdentifier(callee) && (TABLE_FUNCTION.test(callee.text) || factories.has(callee.text))) return node
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === 'table' && ts.isIdentifier(callee.expression) && factories.has(callee.expression.text)) return node
    return tableCall(callee.expression, factories)
  }
  return null
}

function declarations(source: ts.SourceFile): ts.VariableDeclaration[] {
  return source.statements.flatMap((statement) =>
    ts.isVariableStatement(statement) ? statement.declarationList.declarations.filter((declaration) => ts.isIdentifier(declaration.name) && declaration.initializer) : []
  )
}

/** Tables and foreign keys in Drizzle schema files, read from source without running them or touching a database */
export function parseSchema(files: { path: string; text: string }[]): Schema {
  const sources = files.map(({ path, text }) => ({ path, source: ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true) }))
  // Factories and enums first: a schema file may use ones declared in another
  const factories = new Set<string>()
  const enums = new Map<string, string>()
  const enumValues: Record<string, string[]> = {}
  for (const { source } of sources)
    for (const declaration of declarations(source)) {
      const init = declaration.initializer
      if (!init || !ts.isCallExpression(init)) continue
      const name = calleeName(init) ?? ''
      const variable = (declaration.name as ts.Identifier).text
      if (TABLE_FACTORY.test(name)) factories.add(variable)
      if (ENUM_FUNCTION.test(name)) {
        const dbName = stringArg(init) ?? variable
        enums.set(variable, dbName)
        const values = init.arguments[1]
        enumValues[dbName] = values && ts.isArrayLiteralExpression(values) ? values.elements.flatMap((element) => (ts.isStringLiteralLike(element) ? element.text : [])) : []
      }
    }

  const tables: Table[] = []
  // ponytail: references resolve by variable name across files, first match wins; follow imports if two files reuse a name
  const byVariable = new Map<string, string>()
  const pending: PendingRelation[] = []
  for (const { path, source } of sources)
    for (const declaration of declarations(source)) {
      const call = tableCall(declaration.initializer as ts.Expression, factories)
      const columnsObject = call && objectOf(call.arguments[1])
      if (!call || !columnsObject) continue
      const variable = (declaration.name as ts.Identifier).text
      const id = `${path}#${variable}`
      const columns: Column[] = []
      for (const property of columnsObject.properties) {
        if (!ts.isPropertyAssignment(property) || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) continue
        const read = readColumn(property.name.text, property.initializer, enums)
        if (!read) continue
        columns.push(read.column)
        if (read.references) pending.push({ from: id, columns: [read.column.key], toVariable: read.references.table, toColumns: [read.references.column] })
      }
      // Composite keys and foreign keys in the third argument; any call inside counts, `.onDelete()` chains included
      const extras = call.arguments[2]
      const self = extras && ts.isArrowFunction(extras) ? extras.parameters[0]?.name.getText(source) : undefined
      const visit = (node: ts.Node): void => {
        if (ts.isCallExpression(node)) {
          const name = calleeName(node)
          const config = node.arguments[0] && ts.isObjectLiteralExpression(node.arguments[0]) ? node.arguments[0] : null
          const field = (key: string): ts.Expression | undefined =>
            config?.properties.find((property): property is ts.PropertyAssignment => ts.isPropertyAssignment(property) && property.name.getText() === key)?.initializer
          if (name === 'primaryKey') {
            const keys = config ? refsIn(field('columns')) : node.arguments.flatMap((argument) => columnRef(argument) ?? [])
            for (const ref of keys) {
              const column = columns.find((candidate) => candidate.key === ref.column)
              if (column) column.primaryKey = column.notNull = true
            }
          }
          if (name === 'foreignKey' && config) {
            const own = refsIn(field('columns'))
            const foreign = refsIn(field('foreignColumns'))
            if (own.length && foreign[0])
              pending.push({
                from: id,
                columns: own.map((ref) => ref.column),
                toVariable: foreign[0].table,
                toColumns: foreign.map((ref) => ref.column),
                to: foreign[0].table === self ? id : undefined
              })
          }
        }
        ts.forEachChild(node, visit)
      }
      if (extras) visit(extras)
      const line = source.getLineAndCharacterOfPosition(declaration.getStart(source)).line + 1
      tables.push({ id, name: stringArg(call) ?? variable, file: path, line, columns })
      if (!byVariable.has(variable)) byVariable.set(variable, id)
    }

  const relations: Relation[] = pending.flatMap(({ toVariable, to = byVariable.get(toVariable), ...relation }) => (to ? [{ ...relation, to }] : []))
  return { tables, relations, enums: enumValues, errors: [] }
}

/** Files git knows or would add that mention Drizzle; `git grep` exits 1 when nothing matches */
async function candidateFiles(worktreePath: string): Promise<string[]> {
  const { stdout } = await exec('git', ['-C', worktreePath, 'grep', '-l', '--untracked', '-E', 'drizzle-orm|Table\\(|Table\\.', '--', ...SOURCE_GLOBS], {
    maxBuffer: 64 << 20
  }).catch((reason: { code?: number }) => {
    if (reason.code === 1) return { stdout: '' }
    throw reason
  })
  return stdout.split('\n').filter(Boolean)
}

export async function scanSchema(worktreePath: string): Promise<Schema> {
  const paths = await candidateFiles(worktreePath)
  const errors: Schema['errors'] = []
  const files = (
    await Promise.all(
      paths.map((path) =>
        readFile(join(worktreePath, path), 'utf8').then(
          (text) => ({ path, text }),
          (reason: unknown) => {
            errors.push({ file: path, message: reason instanceof Error ? reason.message : String(reason) })
            return null
          }
        )
      )
    )
  ).filter((file) => file !== null)
  return { ...parseSchema(files), errors }
}
