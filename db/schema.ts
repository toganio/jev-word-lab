import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const experiments = sqliteTable(
  'experiments',
  {
    id: text('id').primaryKey(),
    revision: integer('revision').notNull(),
    kind: text('kind').notNull(),
    startedAt: integer('started_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    status: text('status').notNull(),
    question: text('question').notNull(),
    answer: text('answer').notNull(),
    reason: text('reason').notNull(),
    appVersion: text('app_version').notNull(),
    requests: integer('requests').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    snapshotJson: text('snapshot_json').notNull(),
  },
  (table) => [index('idx_experiments_updated_at').on(table.updatedAt)],
);
