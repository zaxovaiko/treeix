import { expect, test } from 'bun:test'
import { parseSchema } from './drizzle'

const enums = `
import { pgEnum } from 'drizzle-orm/pg-core'
export const role = pgEnum('user_role', ['admin', 'member'])
`

const pg = `
import { foreignKey, integer, pgTable, primaryKey, serial, text, uuid, varchar } from 'drizzle-orm/pg-core'
import { role } from './enums'

export const orgs = pgTable('organizations', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text().notNull()
})

export const users = pgTable(
  'users',
  {
    id: serial('id').primaryKey(),
    email: varchar('email', { length: 255 }).notNull().unique(),
    orgId: uuid('org_id').references(() => orgs.id, { onDelete: 'cascade' }),
    role: role('role').default('member'),
    managerId: integer('manager_id')
  },
  (table) => [foreignKey({ columns: [table.managerId], foreignColumns: [table.id] }).onDelete('set null')]
)

export const memberships = pgTable('memberships', { userId: integer('user_id').notNull(), orgId: uuid('org_id').notNull() }, (t) => ({
  pk: primaryKey({ columns: [t.userId, t.orgId] }),
  user: foreignKey({ columns: [t.userId], foreignColumns: [users.id] })
}))
`

const sqlite = `
import { sqliteTable } from 'drizzle-orm/sqlite-core'
export const posts = sqliteTable('posts', (d) => ({ id: d.integer().primaryKey(), authorId: d.integer('author_id').references(() => users.id) })).enableRLS()
const notATable = someOther('x', { a: b() })
`

test('parseSchema reads tables, columns, enums and every kind of foreign key', () => {
  const schema = parseSchema([
    { path: 'db/enums.ts', text: enums },
    { path: 'db/schema.ts', text: pg },
    { path: 'db/posts.ts', text: sqlite }
  ])
  expect(schema.tables.map((table) => table.name)).toEqual(['organizations', 'users', 'memberships', 'posts'])
  expect(schema.enums).toEqual({ user_role: ['admin', 'member'] })

  const users = schema.tables.find((table) => table.name === 'users')
  expect(users?.line).toBe(10)
  expect(users?.columns.find((column) => column.key === 'role')).toMatchObject({ name: 'role', type: 'user_role', hasDefault: true })
  expect(users?.columns.find((column) => column.key === 'email')).toMatchObject({ type: 'varchar', notNull: true, unique: true })
  expect(users?.columns.find((column) => column.key === 'id')).toMatchObject({ primaryKey: true, notNull: true, hasDefault: true })
  const orgs = schema.tables.find((table) => table.name === 'organizations')
  expect(orgs?.columns.find((column) => column.key === 'name')).toMatchObject({ name: 'name', type: 'text', notNull: true })

  const memberships = schema.tables.find((table) => table.name === 'memberships')
  expect(memberships?.columns.every((column) => column.primaryKey)).toBe(true)

  const relations = schema.relations.map(({ from, columns, to, toColumns }) => `${from}.${columns.join()} -> ${to}.${toColumns.join()}`)
  expect(relations.sort()).toEqual(
    [
      'db/schema.ts#users.orgId -> db/schema.ts#orgs.id',
      'db/schema.ts#users.managerId -> db/schema.ts#users.id',
      'db/schema.ts#memberships.userId -> db/schema.ts#users.id',
      'db/posts.ts#posts.authorId -> db/schema.ts#users.id'
    ].sort()
  )
})
