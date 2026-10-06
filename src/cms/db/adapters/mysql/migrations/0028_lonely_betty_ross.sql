CREATE TABLE `pm_created_documents` (
	`id` int AUTO_INCREMENT NOT NULL,
	`idempotency_key` varchar(128) NOT NULL,
	`document_id` int,
	`created_at` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `pm_created_documents_id` PRIMARY KEY(`id`),
	CONSTRAINT `uniq_pm_created_documents_key` UNIQUE(`idempotency_key`)
);
--> statement-breakpoint
ALTER TABLE `pm_created_documents` ADD CONSTRAINT `pm_created_documents_document_id_documents_id_fk` FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON DELETE cascade ON UPDATE no action;