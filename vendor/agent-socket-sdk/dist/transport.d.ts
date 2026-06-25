export interface MinWS {
    send(data: string): void;
    close(code?: number, reason?: string): void;
    /** "open" | "message" | "close" | "error" */
    addListener(event: string, fn: (...args: unknown[]) => void): void;
    removeListener(event: string, fn: (...args: unknown[]) => void): void;
    readonly readyState: number;
}
export declare function openWs(url: string, opts?: {
    headers?: Record<string, string>;
}): Promise<MinWS>;
export declare const READY_STATE_OPEN = 1;
