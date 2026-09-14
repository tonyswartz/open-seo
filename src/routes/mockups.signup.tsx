import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { SignupPreview } from "@/client/features/onboarding/SignupPreview";

export const Route = createFileRoute("/mockups/signup")({
  ssr: false,
  validateSearch: z.object({
    design: z
      .enum(["quiet", "split", "compact", "editorial", "workspace"])
      .catch("quiet"),
    screen: z.enum(["goal", "agent", "prompt", "done"]).catch("prompt"),
    treatment: z.enum(["panel", "simple", "preview"]).catch("panel"),
  }),
  component: SignupPreviewRoute,
});

function SignupPreviewRoute() {
  const { design, screen, treatment } = Route.useSearch();
  const navigate = Route.useNavigate();
  return (
    <SignupPreview
      design={design}
      screen={screen}
      treatment={treatment}
      onChange={(search) => void navigate({ search })}
    />
  );
}
