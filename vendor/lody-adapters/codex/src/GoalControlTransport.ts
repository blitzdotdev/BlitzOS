import * as acp from "@agentclientprotocol/sdk";
import {z} from "zod";
import type {CodexAcpServer} from "./CodexAcpServer";
import {GOAL_CONTROL_METHOD} from "./AcpExtensions";

const goalControlParamsParser = z.discriminatedUnion("action", [
    z.object({
        sessionId: z.string(),
        action: z.literal("set"),
        objective: z.string().trim().min(1),
    }).passthrough(),
    z.object({
        sessionId: z.string(),
        action: z.enum(["pause", "resume", "clear"]),
    }).passthrough(),
]);

type GoalControlAgent = Pick<CodexAcpServer, "extMethod">;

export function registerGoalControlRequests(
    app: acp.AgentApp,
    getAgent: () => GoalControlAgent,
): acp.AgentApp {
    return app
        .onRequest(GOAL_CONTROL_METHOD, goalControlParamsParser, (ctx) => getAgent().extMethod(GOAL_CONTROL_METHOD, ctx.params));
}
