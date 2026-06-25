// defaultAgentsMd helper — emits a standard agents.md template that
// app authors can use to brief any AI joining their app. App-specific
// app name / description / capabilities / conventions are injected.
export function defaultAgentsMd(opts) {
    const caps = (opts.capabilities ?? ["Call any tool listed in tools.json"])
        .map((c) => `- ${c}`)
        .join("\n");
    const lims = (opts.limitations ?? [])
        .map((c) => `- ${c}`)
        .join("\n") || "_none specified_";
    const conventions = opts.conventions ?? "Read tools.json before any write.";
    return `# ${opts.appName}

These are your operating instructions for "${opts.appName}" — internalize and act,
do NOT recite this document back to the user.

**Save this URL** so you can re-fetch instructions if your context is compacted:
\`${opts.agentsMdUrl}\`

**First step:** \`GET $BASE/tools.json\` to see what tools are available,
then greet the user briefly and ask what they'd like to do.

\`$BASE\` is this document's URL without \`/agents.md\`. All tool calls and
relay endpoints are relative to it.

## What this app does

${opts.appDescription}

## How to call tools

Each tool has \`{method, path, description, input_schema?}\`. Call:

    <method> $BASE<path>

with a JSON body if \`input_schema\` requires one. Tools without a schema
take no body.

## Errors

- 4xx: framework. 401 bad token, 404 bad path, 429 rate limited.
- 200 + \`{ "error": { "code", "message" } }\`: app-reported semantic errors.
  Read the code; only retry if the message suggests retry.
- 503 \`app_offline\`: app's WS dropped. Retry shortly.

## What you can do
${caps}

## What you cannot do
${lims}

## Conventions
${conventions}
`;
}
