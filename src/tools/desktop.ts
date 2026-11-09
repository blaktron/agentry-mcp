import { z } from "zod";

/**
 * The run tools' `desktop` argument: the person's agreement to what a
 * release uses on their own computer through Agentry Desktop.
 */
export const desktopArg = z
  .object({
    applications: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/))
      .max(16)
      .optional()
      .describe(
        "The ids of the applications the release uses on the person's computer, through their MCP server or " +
          "their windows, each one the person agreed to: every id the preview names, and nothing else. An id is any " +
          "application's (`blender`, `my-cad`): Agentry Desktop resolves it to an application the person added and " +
          "approved in its Settings → Your computer.",
      ),
    choose: z
      .boolean()
      .optional()
      .describe(
        "true once the person agreed that the release uses an application they choose when the run starts " +
          "(the preview says when it asks for one); Agentry Desktop asks them which.",
      ),
    computerUse: z
      .boolean()
      .optional()
      .describe(
        "true once the person agreed to the release's computer use (the windows of its applications, or the screen).",
      ),
    allowScreen: z
      .boolean()
      .optional()
      .describe(
        "Let a computer use that asks for the whole screen see and use it for this run (`--allow-screen`).",
      ),
  })
  .optional()
  .describe(
    "For a release that uses applications on the person's computer: the run uses them through Agentry Desktop, " +
      "which must be running there, on this computer or, with `on`, on the computer that follows the run. Agentry " +
      "Desktop asks the person before code runs inside an application, logs each call, and its Stop ends the run's " +
      "use of the computer. The preview names what the release uses; pass what the person agreed to. Adding and " +
      "approving applications (Settings → Your computer), the system's permissions and starting an application " +
      "stay in Agentry Desktop.",
  );
