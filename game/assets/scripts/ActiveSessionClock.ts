/** Maps active monotonic wall time to integer simulation time, independently of render dt. */
export class ActiveSessionClock {
    private running = false;
    private anchorWallMs = 0;
    private anchorSimulationMs = 0;
    private sampledMs = 0;

    // The host supplies performance.now; tests supply their own clock without a game input API.
    constructor(private readonly readWallMs: () => number) {}

    start(atMs = 0): void { this.reanchor(atMs); }
    resume(atMs: number): void { this.reanchor(atMs); }

    /** Freeze at the last resolved snapshot, without settling an unseen gap during pause/cancel. */
    freezeAt(atMs: number): void {
        this.validateSimulationTime(atMs);
        this.anchorSimulationMs = this.sampledMs = atMs;
        this.running = false;
    }

    nowMs(): number {
        if (!this.running) return this.sampledMs;
        const wallMs = this.wallMs();
        const elapsedMs = Math.max(0, wallMs - this.anchorWallMs);
        // Keep integer monotonic commands even if a faulty host temporarily regresses its clock.
        this.sampledMs = Math.max(this.sampledMs,
            Math.min(Number.MAX_SAFE_INTEGER, Math.floor(this.anchorSimulationMs + elapsedMs)));
        return this.sampledMs;
    }

    private reanchor(atMs: number): void {
        this.validateSimulationTime(atMs);
        const wallMs = this.wallMs();
        this.anchorWallMs = wallMs;
        this.anchorSimulationMs = this.sampledMs = atMs;
        this.running = true;
    }

    private wallMs(): number {
        const value = this.readWallMs();
        if (!Number.isFinite(value)) throw new RangeError('Active clock requires finite monotonic wall time');
        return value;
    }

    private validateSimulationTime(value: number): void {
        if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('Active clock requires nonnegative integer simulation time');
    }
}
