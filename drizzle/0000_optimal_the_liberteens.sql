CREATE TABLE `experiments` (
	`id` text PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`kind` text NOT NULL,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`status` text NOT NULL,
	`question` text NOT NULL,
	`answer` text NOT NULL,
	`reason` text NOT NULL,
	`app_version` text NOT NULL,
	`requests` integer NOT NULL,
	`input_tokens` integer NOT NULL,
	`snapshot_json` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_experiments_updated_at` ON `experiments` (`updated_at`);