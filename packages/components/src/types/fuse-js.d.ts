declare module 'fuse.js' {
  export type FuseResult<T> = {
    item: T;
    score?: number;
  };

  export type FuseOptions<T> = {
    keys?: Array<keyof T | string>;
    includeScore?: boolean;
    threshold?: number;
    ignoreLocation?: boolean;
    minMatchCharLength?: number;
    shouldSort?: boolean;
    useExtendedSearch?: boolean;
  };

  export default class Fuse<T> {
    constructor(list: T[], options?: FuseOptions<T>);
    search(pattern: string, options?: { limit?: number }): Array<FuseResult<T>>;
  }
}

