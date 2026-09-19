CREATE TABLE `category_results` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`word` text NOT NULL,
	`assignment_json` text NOT NULL,
	`scanned_count` integer NOT NULL,
	`complete` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_category_results_session_word` ON `category_results` (`session_id`,`word`);--> statement-breakpoint
CREATE TABLE `category_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`taxonomy_version` text NOT NULL,
	`source_sha256` text NOT NULL,
	`created_at` integer NOT NULL,
	`origin` text NOT NULL
);
