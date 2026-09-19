import { sqliteTable, text, integer, index } from 'drizzle-orm/sqlite-core';
export const wordCategories = sqliteTable('word_categories', {
  word: text('word').primaryKey(),
  taxonomyVersion: text('taxonomy_version').notNull(),
  assignmentJson: text('assignment_json').notNull(),
  updatedAt: integer('updated_at').notNull(),
});
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
export const categorySessions = sqliteTable('category_sessions', {
  id: text('id').primaryKey(),
  taxonomyVersion: text('taxonomy_version').notNull(),
  sourceSha256: text('source_sha256').notNull(),
  createdAt: integer('created_at').notNull(),
  origin: text('origin').notNull(),
});
export const categoryResults = sqliteTable(
  'category_results',
  {
    id: text('id').primaryKey(),
    sessionId: text('session_id').notNull(),
    word: text('word').notNull(),
    assignmentJson: text('assignment_json').notNull(),
    scannedCount: integer('scanned_count').notNull(),
    complete: integer('complete').notNull(),
  },
  (table) => [
    index('idx_category_results_session_word').on(table.sessionId, table.word),
  ],
);
