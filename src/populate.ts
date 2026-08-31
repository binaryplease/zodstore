/**
 * The slice of a collection that `populate` needs: a way to resolve many ids in
 * one batch and the name of the field carrying each target's id. `Collection`
 * satisfies this, so any collection can be a populate target.
 */
export interface ReferenceResolver<TTarget> {
  readonly idField: string;
  findByIds(ids: readonly string[]): TTarget[];
}

/** A parent extended with its resolved reference under key `TAs`. */
export type Populated<TParent, TTarget, TAs extends string> = TParent & {
  [Key in TAs]: TTarget | null;
};

function readReferenceId(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Batched join. For each parent, read the foreign-key field, resolve all distinct
 * referenced ids in a single `findByIds` query (so each target document is
 * fetched and parsed exactly once), and attach the resolved document under `as`.
 * A missing or absent reference yields an explicit `null`, never a dropped key:
 * nullish properties are emitted, so a caller always sees the full shape.
 *
 * @example
 *   const posts = postCollection.find();
 *   const withAuthors = populate(posts, "authorId", userCollection, "author");
 *   // withAuthors[0].author is a user document or null
 */
export function populate<TParent, TTarget, TAs extends string>(
  parents: TParent[],
  foreignKey: keyof TParent,
  target: ReferenceResolver<TTarget>,
  as: TAs,
): Populated<TParent, TTarget, TAs>[] {
  const referencedIds: string[] = [];
  for (const parent of parents) {
    const id = readReferenceId((parent as Record<string, unknown>)[foreignKey as string]);
    if (id !== null) referencedIds.push(id);
  }

  const resolved = target.findByIds(referencedIds);
  const byId = new Map<string, TTarget>();
  for (const document of resolved) {
    const id = (document as Record<string, unknown>)[target.idField];
    if (typeof id === "string") byId.set(id, document);
  }

  return parents.map((parent) => {
    const id = readReferenceId((parent as Record<string, unknown>)[foreignKey as string]);
    const reference = id === null ? null : byId.get(id) ?? null;
    return { ...parent, [as]: reference } as Populated<TParent, TTarget, TAs>;
  });
}
