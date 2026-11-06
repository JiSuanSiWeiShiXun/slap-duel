import { ActionKind, AttackMode } from './core/Battle';

/** Device-independent touch ownership. Cocos callbacks supply the pointer ID. */
export class InputBridge {
    private readonly held = new Map<number, 'guard' | 'tap' | 'charge'>();
    private attackPointer: number | null = null;

    constructor(private readonly emit: (action: ActionKind) => void) {}

    downAttack(pointerId: number, mode: AttackMode): void {
        if (!Number.isInteger(pointerId) || this.held.has(pointerId) || this.attackPointer !== null) return;
        this.attackPointer = pointerId;
        this.held.set(pointerId, mode);
        this.emit(mode === 'charge' ? 'charge-start' : 'attack');
    }

    downGuard(pointerId: number): void {
        if (!Number.isInteger(pointerId) || this.held.has(pointerId)) return;
        this.held.set(pointerId, 'guard');
        this.emit('guard');
    }

    up(pointerId: number): void {
        const kind = this.forget(pointerId);
        if (kind === 'charge') this.emit('charge-release');
    }

    cancel(pointerId: number): void {
        const kind = this.forget(pointerId);
        if (kind === 'charge') this.emit('charge-cancel');
    }

    cancelAll(): void {
        const hadCharge = Array.from(this.held.values()).includes('charge');
        this.held.clear();
        this.attackPointer = null;
        if (hadCharge) this.emit('charge-cancel');
    }

    private forget(pointerId: number): 'guard' | 'tap' | 'charge' | undefined {
        const kind = this.held.get(pointerId);
        this.held.delete(pointerId);
        if (this.attackPointer === pointerId) this.attackPointer = null;
        return kind;
    }
}
