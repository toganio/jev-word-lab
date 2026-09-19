CREATE TABLE `word_categories` (
	`word` text PRIMARY KEY NOT NULL,
	`taxonomy_version` text NOT NULL,
	`assignment_json` text NOT NULL,
	`updated_at` integer NOT NULL
);
