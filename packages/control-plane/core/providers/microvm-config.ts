import { MICROVM_HOST_NAME_PATTERN } from "./microvm-hosts.js";

const AGENT_VM_ID_PATTERN = /^[A-Za-z0-9-]+$/u;
const PROVIDER_ID_PREFIX = "microvm:v1:";

export interface StaticMicrovmHostConfig {
  name: string;
  url: string;
  tokenVar: string;
}

export interface DynamicMicrovmHostConfig {
  name: string;
  tokenVar: string;
  dynamic: true;
}

export type MicrovmHostConfig =
  | StaticMicrovmHostConfig
  | DynamicMicrovmHostConfig;

export type ResolvedMicrovmHost = MicrovmHostConfig & { token: string };

export interface ActiveMicrovmHost {
  name: string;
  url: string;
  token: string;
}

export interface MicrovmMachineType {
  cpu: number;
  memGb: number;
  hostName: string;
}

export const RECOGNIZED_MICROVM_SIZES = Object.freeze([
  { cpu: 2, memGb: 2, diskGb: 8 },
  { cpu: 2, memGb: 4, diskGb: 8 },
] as const);

export function isDynamicMicrovmHost(
  host: MicrovmHostConfig,
): host is DynamicMicrovmHostConfig {
  return "dynamic" in host && host.dynamic === true;
}

export function parseMicrovmMachineTypeId(value: string): MicrovmMachineType | null {
  const match = /^mv-([1-9]\d*)c([1-9]\d*)g@([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/u.exec(value);
  if (match === null) return null;
  const cpu = Number(match[1]);
  const memGb = Number(match[2]);
  if (!Number.isSafeInteger(cpu) || !Number.isSafeInteger(memGb) || !Number.isSafeInteger(memGb * 1_024)) {
    return null;
  }
  return { cpu, memGb, hostName: match[3] ?? "" };
}

export function recognizedMicrovmSize(cpu: number, memGb: number) {
  return RECOGNIZED_MICROVM_SIZES.find((size) => size.cpu === cpu && size.memGb === memGb);
}

export function microvmProviderId(hostName: string, agentVmId: string): string {
  return `${PROVIDER_ID_PREFIX}${encodeURIComponent(hostName)}:${encodeURIComponent(agentVmId)}`;
}

export function parseMicrovmProviderId(
  value: string,
): { hostName: string; agentVmId: string } | null {
  if (!value.startsWith(PROVIDER_ID_PREFIX)) return null;
  const encoded = value.slice(PROVIDER_ID_PREFIX.length);
  const separator = encoded.indexOf(":");
  if (separator <= 0 || separator === encoded.length - 1) return null;
  try {
    const hostName = decodeURIComponent(encoded.slice(0, separator));
    const agentVmId = decodeURIComponent(encoded.slice(separator + 1));
    if (
      !MICROVM_HOST_NAME_PATTERN.test(hostName)
      || !AGENT_VM_ID_PATTERN.test(agentVmId)
    ) return null;
    return { hostName, agentVmId };
  } catch {
    return null;
  }
}

export function isMicrovmProviderId(value: string): boolean {
  return value.startsWith(PROVIDER_ID_PREFIX);
}

export function validMicrovmAgentVmId(value: string): boolean {
  return AGENT_VM_ID_PATTERN.test(value);
}

