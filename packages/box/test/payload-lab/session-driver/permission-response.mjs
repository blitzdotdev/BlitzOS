const PERMISSION_MODES = new Set(["allow", "deny", "ask"]);

function normalized(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function optionMatches(option, words) {
  const values = [option.kind, option.optionId, option.name].map(normalized);
  return values.some((value) => words.some((word) => value.includes(word)));
}

function selectOptionId(options, permissions) {
  if (permissions === "allow") {
    return options.find((option) => normalized(option.kind) === "allow_once")?.optionId ??
      options.find((option) => normalized(option.kind) === "allow")?.optionId ??
      options.find((option) => optionMatches(option, ["allow once", "approve once"]))?.optionId ??
      options.find((option) =>
        optionMatches(option, ["allow", "approve"]) && !optionMatches(option, ["always"])
      )?.optionId ??
      null;
  }
  return options.find((option) => {
    const kind = normalized(option.kind);
    return kind === "reject_once" || kind === "deny";
  })?.optionId ??
    options.find((option) => optionMatches(option, ["deny", "reject", "refuse"]))?.optionId ??
    null;
}

function toolSummary(item) {
  const command = typeof item.rawInput === "object" && item.rawInput !== null &&
      typeof item.rawInput.command === "string"
    ? item.rawInput.command
    : null;
  const candidate = command ??
    (typeof item.title === "string" ? item.title : null) ??
    (typeof item.toolName === "string" ? item.toolName : null) ??
    (typeof item.kind === "string" ? item.kind : null) ??
    (typeof item.toolCallId === "string" ? item.toolCallId : null) ??
    "tool request";
  const compact = candidate.replace(/\s+/gu, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

export function parsePermissionMode(value, flag = "--permissions") {
  if (!PERMISSION_MODES.has(value)) {
    throw new Error(`${flag} must be allow, deny, or ask`);
  }
  return value;
}

export function pendingPermissionRequests(history) {
  const pending = [];
  const requestIds = new Set();
  for (let entryIndex = history.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const entry = history[entryIndex];
    if (typeof entry !== "object" || entry === null || !Array.isArray(entry.items)) continue;
    for (let itemIndex = entry.items.length - 1; itemIndex >= 0; itemIndex -= 1) {
      const item = entry.items[itemIndex];
      if (typeof item !== "object" || item === null || item.type !== "tool_call") continue;
      const request = item.permissionRequest;
      if (
        typeof request !== "object" || request === null || typeof request.requestId !== "string" ||
        request.requestId === "" || (request.outcome !== undefined && request.outcome !== null) ||
        !Array.isArray(request.options) ||
        requestIds.has(request.requestId)
      ) continue;
      const options = request.options.filter((option) =>
        typeof option === "object" && option !== null && typeof option.optionId === "string" &&
        typeof option.name === "string"
      );
      requestIds.add(request.requestId);
      pending.push({ requestId: request.requestId, options, toolSummary: toolSummary(item) });
    }
  }
  return pending.reverse();
}

export async function answerSessionPermissions(input) {
  if (input.permissions === "ask") return [];
  const responses = [];
  for (const request of pendingPermissionRequests(input.history)) {
    if (input.answeredRequestIds.has(request.requestId)) continue;
    const optionId = selectOptionId(request.options, input.permissions);
    if (optionId === null) {
      throw new Error(`permission ${request.requestId} has no ${input.permissions} option`);
    }
    const response = {
      type: "session/permission_response",
      sessionId: input.sessionId,
      requestId: request.requestId,
      outcome: { outcome: "selected", optionId },
    };
    await input.respond(response);
    input.answeredRequestIds.add(request.requestId);
    input.log(`permission ${request.requestId} -> ${optionId} (${request.toolSummary})`);
    responses.push(response);
  }
  return responses;
}
