// Types for worker-first-routes.mjs, hand-written because the repo does not
// build its .mjs tooling. Only the members TypeScript consumers use are
// declared; packages/webapp/vite.config.ts is the one so far.
export declare const CORE_DIR: string;
export declare const ROOT_ROUTE_PATH: string;
export declare const FRAMEWORK_ROUTE_PATHS: readonly string[];
export declare const ROUTE_REGISTRATION: RegExp;
export declare const LITERAL_ROUTE_PATH: RegExp;

export interface SegmentShape {
  readonly segment: string;
  readonly exact: boolean;
  readonly subtree: boolean;
}
export interface RouteShape {
  readonly root: boolean;
  readonly segments: readonly SegmentShape[];
}
export interface SourceFile {
  readonly path: string;
  readonly source: string;
}
export interface NonLiteralRegistration {
  readonly path: string;
  readonly registrations: number;
  readonly literals: number;
}

export declare function firstSegment(routePath: string): string;
export declare function routeShape(routePaths: readonly string[]): RouteShape;
export declare function runWorkerFirstEntries(routePaths: readonly string[]): string[];
export declare function managedApiExactPaths(routePaths: readonly string[]): string[];
export declare function managedApiPrefixes(routePaths: readonly string[]): string[];
export declare function devProxyPatterns(routePaths: readonly string[]): string[];
export declare function coreRoutePaths(sources: readonly SourceFile[]): {
  paths: string[];
  nonLiteral: NonLiteralRegistration[];
};
export declare function readCoreSources(coreDir?: string): SourceFile[];
export declare function deriveCoreRoutePaths(coreDir?: string): string[];
export declare function deriveRunWorkerFirst(coreDir?: string): string[];
