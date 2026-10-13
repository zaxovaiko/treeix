export type Column = {
  /** The property name in the table's columns object; relations point at it */
  key: string
  /** The name in the database */
  name: string
  /** The column builder, `varchar` or `integer`, or the enum's database name */
  type: string
  primaryKey: boolean
  notNull: boolean
  unique: boolean
  hasDefault: boolean
}

export type Table = {
  /** `file#variable`, unique across the worktree */
  id: string
  name: string
  /** Worktree-relative file and 1-based line of the declaration */
  file: string
  line: number
  columns: Column[]
}

/** A foreign key: `columns` of `from` point at `toColumns` of `to`, by column key */
export type Relation = { from: string; columns: string[]; to: string; toColumns: string[] }

export type Schema = {
  tables: Table[]
  relations: Relation[]
  /** Enum values by the enum's database name */
  enums: Record<string, string[]>
  /** Files that matched but couldn't be read */
  errors: { file: string; message: string }[]
}
