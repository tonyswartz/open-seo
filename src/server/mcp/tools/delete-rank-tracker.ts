import { z } from "zod";
import { RankTrackingService } from "@/server/features/rank-tracking/services/RankTrackingService";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";

const inputSchema = {
  projectId: projectIdSchema,
  trackerId: z
    .string()
    .uuid()
    .describe("Rank tracker ID from get_rank_tracker."),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const deleteRankTrackerTool = {
  name: "delete_rank_tracker",
  config: {
    title: "Delete rank tracker",
    description:
      "Permanently delete a rank tracker and all of its data: tracked keywords, run history, and historical snapshots. Irreversible and uses no credits. Fails while a rank check is running for the tracker. Confirm the target with get_rank_tracker first; use remove_rank_tracking_keywords instead to stop tracking keywords while keeping the tracker and its history.",
    inputSchema,
    outputSchema: z
      .object({
        trackerId: z.string(),
        domain: z.string(),
        locationName: z.string().nullable(),
        keywordsDeleted: z.number(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: true,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const { config, keywordCount } = await RankTrackingService.deleteTracker(
      args.trackerId,
      args.projectId,
    );
    return mcpResponse({
      text: `Deleted rank tracker ${config.id} (${config.domain}, ${config.locationName ?? "national"}) along with ${keywordCount} tracked keyword${keywordCount === 1 ? "" : "s"} and all run history.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/rank-tracking`,
      ),
      structuredContent: {
        trackerId: config.id,
        domain: config.domain,
        locationName: config.locationName ?? null,
        keywordsDeleted: keywordCount,
      },
    });
  }),
};
