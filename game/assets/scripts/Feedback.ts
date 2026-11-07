import { BattleEvent, DEFAULT_RULES } from './core/Battle';

/** Only equal-time contacts compete by importance; newer contacts always win. */
export function latestContact(events: readonly BattleEvent[]): BattleEvent | undefined {
    let chosen: BattleEvent | undefined;
    const rank = (kind: BattleEvent['kind']) => kind === 'counter-hit' ? 4 : kind === 'parry' ? 3 : kind === 'block' ? 2 : kind === 'hit' ? 1 : 0;
    for (const event of events) {
        if (!rank(event.kind)) continue;
        if (!chosen || event.atMs > chosen.atMs || (event.atMs === chosen.atMs && rank(event.kind) > rank(chosen.kind))) chosen = event;
    }
    return chosen;
}

export function contactText(event: BattleEvent): string {
    if (event.kind === 'parry') return event.actorId === 0 ? '精准挡住 · 准备反击' : '被挡住 · 反击将至';
    if (event.kind === 'block') return event.actorId === 0 ? '格挡成功' : '被对手格挡';
    const damage = event.damage;
    const hasDamage = typeof damage === 'number' && Number.isFinite(damage) && damage > 0;
    if (event.kind === 'counter-hit') {
        const text = event.actorId === 0 ? '精准反击' : '被对手反击';
        return hasDamage ? `${text} -${damage}` : text;
    }
    const text = event.targetId === 0 ? '没挡住' : hasDamage && damage > DEFAULT_RULES.baseDamage ? '重击命中' : '命中';
    return hasDamage ? `${text} -${damage}` : text;
}
