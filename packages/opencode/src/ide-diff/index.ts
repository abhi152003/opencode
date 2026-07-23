import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { InstanceState } from "@/effect/instance-state"
import { Context, Effect, Layer } from "effect"

// When an IDE diff-review client is connected, edit tools are forced to ask
// for permission (even when the agent ruleset allows them) so the proposed
// change can be shown in the IDE before it lands on disk. This service tracks
// whether such a client is connected for the current instance.

export interface Interface {
  readonly active: () => Effect.Effect<boolean>
  readonly activate: (workspaceFolder: string) => Effect.Effect<void>
  readonly deactivate: () => Effect.Effect<void>
}

interface State {
  active: boolean
  workspaceFolder: string | undefined
}

export class Service extends Context.Service<Service, Interface>()("@opencode/IdeDiff") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const state = yield* InstanceState.make<State>(
      Effect.fn("IdeDiff.state")(function* () {
        const state: State = { active: false, workspaceFolder: undefined }
        return state
      }),
    )

    const active = Effect.fn("IdeDiff.active")(function* () {
      return (yield* InstanceState.get(state)).active
    })

    const activate = Effect.fn("IdeDiff.activate")(function* (workspaceFolder: string) {
      const current = yield* InstanceState.get(state)
      current.active = true
      current.workspaceFolder = workspaceFolder
    })

    const deactivate = Effect.fn("IdeDiff.deactivate")(function* () {
      const current = yield* InstanceState.get(state)
      current.active = false
      current.workspaceFolder = undefined
    })

    return Service.of({ active, activate, deactivate })
  }),
)

export const node = LayerNode.make({ service: Service, layer, deps: [] })

export * as IdeDiff from "."
