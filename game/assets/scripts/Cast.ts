import { ActorId, AttackMode } from './core/Battle';

export type RoleId = 'manager' | 'veteran' | 'rookie';
export const ROLE_IDS: readonly RoleId[] = Object.freeze(['manager', 'veteran', 'rookie'] as RoleId[]);
export interface CastResources {
  readonly manifestPath: string; readonly modelPath: string; readonly portraitPath: string;
}
export interface CastRole extends CastResources {
  readonly roleId: RoleId; readonly assetRevision: number; readonly displayName: string;
  readonly facets: Readonly<{ positive: string; negative: string }>;
  readonly sourceHash: string; readonly prefabUuid: string; readonly portraitTextureUuid: string;
}
export type CastCatalog = Readonly<Record<RoleId, CastRole>>;
export interface RoundActor extends CastRole { readonly actorId: ActorId; }
export interface RoundSelection { readonly playerRoleId: RoleId; readonly opponentRoleId: RoleId; readonly mode: AttackMode; }
export interface RoundSetup { readonly mode: AttackMode; readonly actors: readonly [RoundActor, RoundActor]; }
export interface IntroCard extends CastResources {
  readonly actorId: ActorId; readonly roleId: RoleId; readonly assetRevision: number; readonly displayName: string;
  readonly sourceHash: string; readonly prefabUuid: string; readonly portraitTextureUuid: string;
  readonly facet: 'positive' | 'negative'; readonly text: string; readonly label: string;
}

// Paths are internal constants, never formed from a caller's unchecked role or URI.
const RESOURCES: Readonly<Record<RoleId, CastResources>> = Object.freeze({
  manager: Object.freeze({ manifestPath: 'office-cast/manager/manifest', modelPath: 'office-cast/manager/character', portraitPath: 'office-cast/manager/portrait' }),
  veteran: Object.freeze({ manifestPath: 'office-cast/veteran/manifest', modelPath: 'office-cast/veteran/character', portraitPath: 'office-cast/veteran/portrait' }),
  rookie: Object.freeze({ manifestPath: 'office-cast/rookie/manifest', modelPath: 'office-cast/rookie/character', portraitPath: 'office-cast/rookie/portrait' }),
});
function requireRole(value: unknown): RoleId {
  if (value !== 'manager' && value !== 'veteran' && value !== 'rookie') throw new Error('Unknown cast role');
  return value;
}
export function castResource(roleId: RoleId): CastResources { return RESOURCES[requireRole(roleId)]; }

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid cast manifest object');
  return value as Record<string, unknown>;
}
function text(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid cast manifest ${name}`);
  return value;
}
function uuid(value: unknown): string {
  const result = text(value, 'uuid');
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}(?:@[a-f0-9]+)?$/i.test(result)) throw new Error('Invalid cast manifest uuid');
  return result;
}
function readRole(value: unknown): CastRole {
  const manifest = object(value), source = object(manifest.source), generated = object(manifest.generated);
  if (manifest.schemaVersion !== 1) throw new Error('Unsupported cast manifest version');
  const roleId = requireRole(source.roleId), facets = object(source.facets), imports = object(generated.imports);
  if (!Number.isSafeInteger(source.assetRevision) || (source.assetRevision as number) < 1) throw new Error('Invalid cast asset revision');
  const sourceHash = text(generated.sourceHash, 'hash');
  if (!/^[a-f0-9]{64}$/i.test(sourceHash)) throw new Error('Invalid cast source hash');
  return Object.freeze({
    ...castResource(roleId), roleId, assetRevision: source.assetRevision as number,
    displayName: text(source.displayName, 'name'),
    facets: Object.freeze({ positive: text(facets.positive, 'positive facet'), negative: text(facets.negative, 'negative facet') }),
    sourceHash, prefabUuid: uuid(imports.prefabUuid), portraitTextureUuid: uuid(imports.portraitTextureUuid),
  });
}

/** Validates the three imported manifests and retains only the runtime identity and narrative fields. */
export function createCastCatalog(manifests: readonly unknown[]): CastCatalog {
  if (!Array.isArray(manifests) || manifests.length !== ROLE_IDS.length) throw new Error('Cast catalog requires exactly three role manifests');
  const roles: Partial<Record<RoleId, CastRole>> = {};
  for (const manifest of manifests) {
    const role = readRole(manifest);
    if (roles[role.roleId]) throw new Error('Duplicate cast role manifest');
    roles[role.roleId] = role;
  }
  if (ROLE_IDS.some(roleId => !roles[roleId])) throw new Error('Cast catalog missing role manifest');
  return Object.freeze(roles) as CastCatalog;
}

/** The client owns this snapshot beside its session. Menus and later asset revisions cannot edit a live round. */
export function makeRoundSetup(catalog: CastCatalog, selection: RoundSelection): RoundSetup {
  if (!selection || (selection.mode !== 'tap' && selection.mode !== 'charge')) throw new Error('Unknown attack mode');
  const playerRoleId = requireRole(selection.playerRoleId), opponentRoleId = requireRole(selection.opponentRoleId);
  const actor = (actorId: ActorId, roleId: RoleId): RoundActor => {
    const role = catalog[roleId];
    if (!role || role.roleId !== roleId) throw new Error('Cast catalog missing role');
    return Object.freeze({ ...role, ...castResource(roleId), actorId, facets: Object.freeze({ ...role.facets }) });
  };
  return Object.freeze({ mode: selection.mode, actors: Object.freeze([actor(0, playerRoleId), actor(1, opponentRoleId)] as [RoundActor, RoundActor]) });
}

/** Viewer changes narrative only. Actor order, assets and the single-player control identity stay fixed. */
export function projectIntro(setup: RoundSetup, viewerActorId: ActorId): readonly IntroCard[] {
  if (viewerActorId !== 0 && viewerActorId !== 1) throw new Error('Unknown intro viewer');
  return Object.freeze(setup.actors.map(actor => {
    const own = actor.actorId === viewerActorId, facet = own ? 'positive' : 'negative';
    return Object.freeze({
      ...castResource(actor.roleId), actorId: actor.actorId, roleId: actor.roleId, assetRevision: actor.assetRevision,
      displayName: actor.displayName, sourceHash: actor.sourceHash, prefabUuid: actor.prefabUuid, portraitTextureUuid: actor.portraitTextureUuid,
      facet, text: actor.facets[facet], label: own ? '你眼中的自己' : '这位对手的职场往事',
    });
  }));
}
