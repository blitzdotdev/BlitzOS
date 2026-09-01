import { CliType, SUPPORTED_CLI_TYPES } from '@lody/shared';

export type CliAvailability = Record<CliType, string | false>;

export type ResolveCliTypesSelectionParams = {
  requestedCliTypes?: CliType[];
  availability: CliAvailability;
};

export function resolveCliTypesSelection(params: ResolveCliTypesSelectionParams): {
  configuredCliTypes: CliType[];
  cliTypes: CliType[];
  missing: CliType[];
  invalid: string[];
  isDefaultSelection: boolean;
} {
  const hasRequestedCliTypes = !!params.requestedCliTypes && params.requestedCliTypes.length > 0;
  const requestedCliTypes = [...(params.requestedCliTypes ?? [])] as string[];
  const invalid = hasRequestedCliTypes
    ? requestedCliTypes.filter((type) => !isSupportedCliType(type))
    : [];
  const configuredCliTypes: CliType[] = hasRequestedCliTypes
    ? requestedCliTypes.filter(isSupportedCliType)
    : getDefaultCliTypes(params.availability);
  const missing = configuredCliTypes.filter((type) => !params.availability[type]);
  const cliTypes = configuredCliTypes.filter((type) => !!params.availability[type]);
  return {
    configuredCliTypes,
    cliTypes,
    missing,
    invalid,
    isDefaultSelection: !hasRequestedCliTypes,
  };
}

function getDefaultCliTypes(availability: CliAvailability): CliType[] {
  const installedCliTypes = SUPPORTED_CLI_TYPES.filter((type) => !!availability[type]);
  return installedCliTypes;
}

function isSupportedCliType(value: string): value is CliType {
  return SUPPORTED_CLI_TYPES.includes(value as CliType);
}
