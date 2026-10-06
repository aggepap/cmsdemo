CREATE TABLE `analytics_capi_queue` (
	`id` int AUTO_INCREMENT NOT NULL,
	`event_name` varchar(64) NOT NULL,
	`event_id` varchar(128) NOT NULL,
	`payload` json NOT NULL,
	`status` enum('pending','sent','failed') NOT NULL DEFAULT 'pending',
	`attempts` int NOT NULL DEFAULT 0,
	`last_error` varchar(500),
	`next_attempt_at` datetime NOT NULL,
	`sent_at` datetime,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `analytics_capi_queue_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_capi_event` UNIQUE(`event_name`,`event_id`)
);
--> statement-breakpoint
CREATE INDEX `idx_capi_due` ON `analytics_capi_queue` (`status`,`next_attempt_at`);