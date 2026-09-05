import * as acp from "@agentclientprotocol/sdk";
import {z} from "zod";
import type {CodexAcpServer} from "./CodexAcpServer";
import {
    LEGACY_SET_SESSION_MODEL_METHOD,
    LODY_RATE_LIMITS_GET_METHOD,
    LODY_READ_SESSION_HISTORY_METHOD,
    SESSION_STEERING_METHOD,
} from "./AcpExtensions";
import {registerGoalControlRequests} from "./GoalControlTransport";

const emptyExtensionParamsParser = z.preprocess(
    (params) => params ?? {},
    z.object({}).passthrough()
);

const legacySetSessionModelParamsParser = z.object({
    sessionId: z.string(),
    modelId: z.string(),
}).passthrough();

const sessionSteerParamsParser = z.object({
    sessionId: z.string(),
    prompt: z.array(z.any()),
    steerId: z.string().min(1),
}).passthrough();

const lodyReadSessionHistoryParamsParser = z.object({
    sessionId: z.string().min(1),
}).passthrough();

const lodyRateLimitsGetParamsParser = z.object({
    sessionId: z.string().optional(),
    accountId: z.string().optional(),
    modelId: z.string().optional(),
}).passthrough();

export interface CodexAcpAppOptions {
    name: string;
    createAgent: (connection: acp.AgentContext) => CodexAcpServer;
}

export function createCodexAcpApp(options: CodexAcpAppOptions): acp.AgentApp {
    let codexAcpServer: CodexAcpServer | null = null;
    const getAgent = (): CodexAcpServer => {
        if (!codexAcpServer) {
            throw acp.RequestError.internalError("ACP agent is not connected");
        }
        return codexAcpServer;
    };

    const agentApp = acp.agent({name: options.name})
        .onConnect((connection) => {
            const agent = options.createAgent(connection.client);
            codexAcpServer = agent;
            connection.signal.addEventListener("abort", () => {
                if (codexAcpServer === agent) {
                    codexAcpServer = null;
                }
            });
        })
        .onRequest(acp.methods.agent.initialize, (ctx) => getAgent().initialize(ctx.params))
        .onRequest(acp.methods.agent.session.new, (ctx) => getAgent().newSession(ctx.params))
        .onRequest(acp.methods.agent.session.load, (ctx) => getAgent().loadSession(ctx.params))
        .onRequest(acp.methods.agent.session.fork, (ctx) => getAgent().unstable_forkSession(ctx.params))
        .onRequest(acp.methods.agent.session.list, (ctx) => getAgent().listSessions(ctx.params))
        .onRequest(acp.methods.agent.session.delete, (ctx) => getAgent().deleteSession(ctx.params))
        .onRequest(acp.methods.agent.session.resume, (ctx) => getAgent().resumeSession(ctx.params))
        .onRequest(acp.methods.agent.session.close, (ctx) => getAgent().closeSession(ctx.params))
        .onRequest(acp.methods.agent.session.setMode, (ctx) => getAgent().setSessionMode(ctx.params))
        .onRequest(acp.methods.agent.session.setConfigOption, (ctx) => getAgent().setSessionConfigOption(ctx.params))
        .onRequest(acp.methods.agent.authenticate, (ctx) => getAgent().authenticate(ctx.params, ctx.requestId))
        .onRequest(acp.methods.agent.logout, (ctx) => getAgent().logout(ctx.params))
        .onRequest(acp.methods.agent.providers.list, (ctx) => getAgent().listProviders(ctx.params))
        .onRequest(acp.methods.agent.providers.set, (ctx) => getAgent().setProvider(ctx.params))
        .onRequest(acp.methods.agent.providers.disable, (ctx) => getAgent().disableProvider(ctx.params))
        .onRequest(acp.methods.agent.session.prompt, (ctx) => getAgent().prompt(ctx.params, ctx.signal))
        .onNotification(acp.methods.agent.session.cancel, (ctx) => getAgent().cancel(ctx.params))
        .onRequest("authentication/status", emptyExtensionParamsParser, (ctx) => getAgent().extMethod("authentication/status", ctx.params))
        .onRequest("authentication/logout", emptyExtensionParamsParser, (ctx) => getAgent().extMethod("authentication/logout", ctx.params))
        .onRequest(LEGACY_SET_SESSION_MODEL_METHOD, legacySetSessionModelParamsParser, (ctx) => getAgent().extMethod(LEGACY_SET_SESSION_MODEL_METHOD, ctx.params))
        .onRequest(LODY_RATE_LIMITS_GET_METHOD, lodyRateLimitsGetParamsParser, () => getAgent().readRateLimits())
        .onRequest(LODY_READ_SESSION_HISTORY_METHOD, lodyReadSessionHistoryParamsParser, (ctx) => getAgent().readSessionHistory(ctx.params))
        .onRequest(SESSION_STEERING_METHOD, sessionSteerParamsParser, (ctx) => getAgent().extMethod(SESSION_STEERING_METHOD, ctx.params));

    return registerGoalControlRequests(agentApp, getAgent);
}
