import { IdeDiff } from "@/ide-diff"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { InstanceHttpApi } from "../api"

export const ideDiffHandlers = HttpApiBuilder.group(InstanceHttpApi, "ide-diff", (handlers) =>
  Effect.gen(function* () {
    const svc = yield* IdeDiff.Service

    const activate = Effect.fn("IdeDiffHttpApi.activate")(function* (ctx: {
      payload: { workspaceFolder: string }
    }) {
      yield* svc.activate(ctx.payload.workspaceFolder)
      return true
    })

    const deactivate = Effect.fn("IdeDiffHttpApi.deactivate")(function* () {
      yield* svc.deactivate()
      return true
    })

    return handlers.handle("activate", activate).handle("deactivate", deactivate)
  }),
)
