import { sql } from "drizzle-orm";
import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { projects } from "./app.schema";

export const googleIntegrationHealth = sqliteTable(
  "google_integration_health",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    integration: text("integration", {
      enum: ["google_ads", "gsc", "ga4"],
    }).notNull(),
    providerId: text("provider_id").notNull(),
    connectedByUserId: text("connected_by_user_id").notNull(),
    accountId: text("account_id"),
    lastSuccessfulRefreshAt: text("last_successful_refresh_at"),
    lastRefreshErrorAt: text("last_refresh_error_at"),
    lastRefreshErrorClass: text("last_refresh_error_class"),
    lastRefreshErrorCode: text("last_refresh_error_code"),
    lastRefreshErrorSuberror: text("last_refresh_error_suberror"),
    lastRefreshErrorMessage: text("last_refresh_error_message"),
    consecutiveRefreshFailures: integer("consecutive_refresh_failures")
      .notNull()
      .default(0),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(current_timestamp)`),
    updatedAt: text("updated_at")
      .notNull()
      .default(sql`(current_timestamp)`),
  },
  (table) => [
    uniqueIndex("google_integration_health_project_integration_idx").on(
      table.projectId,
      table.integration,
    ),
    index("google_integration_health_integration_failures_idx").on(
      table.integration,
      table.consecutiveRefreshFailures,
      table.updatedAt,
    ),
  ],
);
