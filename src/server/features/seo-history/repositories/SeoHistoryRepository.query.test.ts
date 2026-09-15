import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type * as SeoHistoryRepositoryModule from "./SeoHistoryRepository";

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

// Dynamic import after doMock("@/db"): the repository binds `db` at module
// load, so the in-memory client has to be in place first.
let client: Client;
let SeoHistoryRepository: typeof SeoHistoryRepositoryModule.SeoHistoryRepository;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));

  await client.executeMultiple(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      name TEXT NOT NULL,
      domain TEXT,
      location_code INTEGER NOT NULL DEFAULT 2840,
      language_code TEXT NOT NULL DEFAULT 'en',
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      archived_at TEXT
    );
    CREATE TABLE seo_history_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      period_start TEXT,
      period_end TEXT,
      source TEXT NOT NULL DEFAULT 'mcp',
      payload TEXT NOT NULL,
      captured_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX seo_history_snapshots_project_kind_period_idx
      ON seo_history_snapshots (project_id, kind, period_start)
      WHERE period_start IS NOT NULL;
  `);

  ({ SeoHistoryRepository } = await import("./SeoHistoryRepository"));
});

beforeEach(async () => {
  await client.execute("DELETE FROM seo_history_snapshots");
  await client.execute("DELETE FROM projects");
  await client.execute(
    "INSERT INTO projects (id, organization_id, name) VALUES ('proj_1', 'org_1', 'Firm')",
  );
});

describe("SeoHistoryRepository", () => {
  it("inserts a snapshot and no-ops a repeat of the same period", async () => {
    const values = {
      projectId: "proj_1",
      kind: "gsc_totals" as const,
      periodStart: "2026-09-08",
      periodEnd: "2026-09-14",
      source: "mcp",
      payload: '{"clicks":10,"impressions":100}',
    };

    const first = await SeoHistoryRepository.insert(values);
    expect(first.inserted).toBe(true);
    expect(first.row.id).toBe(1);

    const second = await SeoHistoryRepository.insert({
      ...values,
      payload: '{"clicks":99,"impressions":999}',
    });
    expect(second.inserted).toBe(false);
    expect(second.row.id).toBe(1);
    expect(second.row.payload).toContain('"clicks":10');
  });

  it("allows multiple ad-hoc snapshots without a period", async () => {
    const values = {
      projectId: "proj_1",
      kind: "weekly_digest" as const,
      periodStart: null,
      periodEnd: null,
      source: "mcp",
      payload: '{"summary":"week a"}',
    };
    const first = await SeoHistoryRepository.insert(values);
    const second = await SeoHistoryRepository.insert({
      ...values,
      payload: '{"summary":"week b"}',
    });
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(true);
    expect(second.row.id).not.toBe(first.row.id);
  });
});
