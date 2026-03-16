ALTER TABLE `session` ADD `message_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `todo_revision` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `session` ADD `diff_revision` integer DEFAULT 0 NOT NULL;