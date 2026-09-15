import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import {
  parseSeoHistoryPayload,
  type GetSeoHistoryInput,
  type RecordSeoHistoryInput,
} from "@/types/schemas/seo-history";
import { SeoHistoryRepository } from "../repositories/SeoHistoryRepository";

function cutoffTimestamp(sinceDays: number): string {
  return new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000)
    .toISOString()
    .replace("T", " ")
    .slice(0, 19);
}

async function requireProject(projectId: string) {
  const project = await ProjectRepository.getProjectById(projectId);
  if (!project) {
    throw new AppError("NOT_FOUND", "Project not found");
  }
  return project;
}

async function record(input: RecordSeoHistoryInput) {
  await requireProject(input.projectId);
  let payload: ReturnType<typeof parseSeoHistoryPayload>;
  try {
    payload = parseSeoHistoryPayload(input.kind, input.payload);
  } catch (error) {
    if (error instanceof z.ZodError) {
      const first = error.issues[0];
      throw new AppError(
        "VALIDATION_ERROR",
        first
          ? `${first.path.join(".") || "payload"}: ${first.message}`
          : "Invalid payload",
      );
    }
    throw error;
  }
  const periodStart = input.periodStart?.trim() || null;
  const periodEnd = input.periodEnd?.trim() || null;

  const { row, inserted } = await SeoHistoryRepository.insert({
    projectId: input.projectId,
    kind: input.kind,
    periodStart,
    periodEnd,
    source: input.source?.trim() || "mcp",
    payload: JSON.stringify(payload),
  });

  return { snapshot: decodeRow(row), inserted };
}

async function list(input: GetSeoHistoryInput) {
  await requireProject(input.projectId);
  const limit = input.limit ?? 50;
  const capturedSince =
    input.sinceDays != null ? cutoffTimestamp(input.sinceDays) : undefined;
  const rows = await SeoHistoryRepository.listForProject({
    projectId: input.projectId,
    kind: input.kind,
    capturedSince,
    limit,
  });
  return rows.map(decodeRow);
}

function decodeRow(
  row: Awaited<ReturnType<typeof SeoHistoryRepository.listForProject>>[number],
) {
  let payload: unknown = row.payload;
  try {
    payload = JSON.parse(row.payload) as unknown;
  } catch {
    // Keep the raw string if a legacy/corrupt row is not valid JSON.
  }
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    source: row.source,
    capturedAt: row.capturedAt,
    payload,
  };
}

export const SeoHistoryService = {
  record,
  list,
};
