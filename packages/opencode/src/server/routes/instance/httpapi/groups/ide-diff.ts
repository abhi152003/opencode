import { Schema } from "effect"
import { HttpApi, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { Authorization } from "../middleware/authorization"
import { InstanceContextMiddleware } from "../middleware/instance-context"
import { WorkspaceRoutingMiddleware, WorkspaceRoutingQuery } from "../middleware/workspace-routing"
import { described } from "./metadata"

const root = "/ide-diff"
const ActivatePayload = Schema.Struct({ workspaceFolder: Schema.String })

export const IdeDiffApi = HttpApi.make("ide-diff")
  .add(
    HttpApiGroup.make("ide-diff")
      .add(
        HttpApiEndpoint.post("activate", `${root}/activate`, {
          query: WorkspaceRoutingQuery,
          payload: ActivatePayload,
          success: described(Schema.Boolean, "IDE diff review activated"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "ide-diff.activate",
            summary: "Activate IDE diff review",
            description:
              "Signal that an IDE diff-review client is connected, so edit tools ask for permission before writing.",
          }),
        ),
        HttpApiEndpoint.post("deactivate", `${root}/deactivate`, {
          query: WorkspaceRoutingQuery,
          success: described(Schema.Boolean, "IDE diff review deactivated"),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "ide-diff.deactivate",
            summary: "Deactivate IDE diff review",
            description: "Signal that the IDE diff-review client disconnected.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "ide-diff",
          description: "IDE diff review activation routes.",
        }),
      )
      .middleware(InstanceContextMiddleware)
      .middleware(WorkspaceRoutingMiddleware)
      .middleware(Authorization),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode experimental HttpApi",
      version: "0.0.1",
      description: "Experimental HttpApi surface for selected instance routes.",
    }),
  )
