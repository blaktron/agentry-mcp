/**
 * The catalog fallback: two tools that reach the rest of the API.
 *
 * The hand-written tools above cover account and repository automation. This
 * pair covers everything else the contract defines — review queues, policy
 * overlays, SSO and SCIM, webhooks, domain claims, advisories, audit exports,
 * platform trust-and-safety — without paying a tool schema each for endpoints
 * most sessions never touch.
 */

import { z } from "zod";

import { findAction } from "../catalog.generated.js";
import {
  ALL_TAGS,
  describeAction,
  missingParams,
  searchActions,
  summariseHit,
} from "../catalog.js";
import { registerTool } from "../toolargs.js";
import { guard, render, textResult, errorResult, type ToolModule } from "./common.js";

export const catalogTools: ToolModule = (server, ctx) => {
  registerTool(
    server,
    "agentry_search_actions",
    {
      title: "Find an Agentry API operation",
      description:
        "Search every operation in the Agentry API contract by intent, and get back operation ids " +
        "to run with agentry_execute_action. Use this for anything the dedicated agentry_* tools " +
        `do not cover. Tags: ${ALL_TAGS.join(", ")}.`,
      inputSchema: {
        query: z
          .string()
          .describe('What you are trying to do, e.g. "add a webhook" or "review queue decisions".'),
        tag: z
          .string()
          .optional()
          .describe(`Restrict to one tag. One of: ${ALL_TAGS.join(", ")}.`),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE"])
          .optional()
          .describe("Restrict to one HTTP method."),
        readOnly: z.boolean().optional().describe("Only operations that read nothing changes."),
        detail: z
          .boolean()
          .default(false)
          .describe("Return full parameter and body schemas rather than one-line summaries."),
        limit: z.number().int().min(1).max(25).default(8).describe("How many results to return."),
      },
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ query, tag, method, readOnly, detail, limit }) =>
      guard(async () => {
        const filters = {
          ...(tag ? { tag } : {}),
          ...(method ? { method } : {}),
          ...(readOnly !== undefined ? { readOnly } : {}),
        };
        const hits = searchActions(query, limit, filters);
        if (hits.length === 0) {
          return textResult(
            `No API operation matched "${query}"${tag ? ` in tag "${tag}"` : ""}. ` +
              `Try fewer or different words, or drop the filters. Tags: ${ALL_TAGS.join(", ")}.`,
          );
        }
        const body = hits.map((h) => (detail ? describeAction(h.action) : summariseHit(h.action)));
        return textResult(
          `${hits.length} matching operation${hits.length === 1 ? "" : "s"}. ` +
            `Run one with agentry_execute_action, using its id.` +
            `${detail ? "" : " Re-run with detail: true for full parameter schemas."}\n\n` +
            JSON.stringify(body, null, 2),
        );
      }),
  );

  registerTool(
    server,
    "agentry_execute_action",
    {
      title: "Run an Agentry API operation",
      description:
        "Run one operation from the API contract by its id, as found with agentry_search_actions. " +
        "Path and query parameters and the JSON body are passed through as given and validated " +
        "against the contract before the call goes out. Prefer a dedicated agentry_* tool when one " +
        "exists — they carry checked schemas and clearer results.",
      inputSchema: {
        actionId: z
          .string()
          .describe('Operation id from agentry_search_actions, e.g. "listWebhooks".'),
        pathParams: z
          .record(z.string(), z.union([z.string(), z.number()]))
          .optional()
          .describe('Values for the {…} placeholders in the path, e.g. {"org": "acme"}.'),
        queryParams: z
          .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
          .optional()
          .describe("Query string parameters."),
        body: z.unknown().optional().describe("JSON request body, for operations that take one."),
        idempotencyKey: z
          .string()
          .max(255)
          .optional()
          .describe("Retry key for the mutating POSTs that honour it."),
        dryRun: z
          .boolean()
          .default(false)
          .describe("Validate the call and show what would be sent, without sending it."),
      },
      annotations: {
        readOnlyHint: false,
        // The catalog reaches write and delete operations across the whole API,
        // so the conservative hint is the honest one for the tool as a whole.
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ actionId, pathParams, queryParams, body, idempotencyKey, dryRun }) =>
      guard(async () => {
        const action = findAction(actionId);
        if (!action) {
          const near = searchActions(actionId, 5).map((h) => h.action.id);
          return errorResult(
            `No operation with id "${actionId}".` +
              (near.length ? ` Did you mean: ${near.join(", ")}?` : "") +
              ` Use agentry_search_actions to find one.`,
          );
        }

        const missing = missingParams(action, {
          ...(pathParams ? { path: pathParams } : {}),
          ...(queryParams ? { query: queryParams } : {}),
          ...(body !== undefined ? { body } : {}),
        });
        const problems = [
          ...missing.path.map((p) => `pathParams.${p}`),
          ...missing.query.map((p) => `queryParams.${p}`),
          ...(missing.body ? ["body"] : []),
        ];
        if (problems.length) {
          return errorResult(
            `${actionId} (${action.method} ${action.path}) is missing required input: ` +
              `${problems.join(", ")}.\n\n${JSON.stringify(describeAction(action), null, 2)}`,
          );
        }

        if (dryRun) {
          return textResult(
            `Dry run — nothing was sent.\n\n` +
              JSON.stringify(
                {
                  request: `${action.method} ${ctx.config.apiBase}${action.path}`,
                  pathParams: pathParams ?? {},
                  queryParams: queryParams ?? {},
                  hasBody: body !== undefined,
                  sessionOnly: action.sessionOnly,
                  wouldBeRefused: action.sessionOnly && !ctx.config.sessionCookie,
                },
                null,
                2,
              ),
          );
        }

        return render(
          ctx,
          await ctx.client.callAction(action, {
            ...(pathParams ? { path: pathParams } : {}),
            ...(queryParams ? { query: queryParams } : {}),
            ...(body !== undefined ? { body } : {}),
            ...(idempotencyKey ? { idempotencyKey } : {}),
          }),
          { note: `${action.method} ${action.path} — ${action.summary}` },
        );
      }),
  );
};
