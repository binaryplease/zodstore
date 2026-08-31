import { z } from "zod";

// Every schema `ref()` hands out, so a collection can tell an identity field
// from an ordinary one without inspecting Zod internals or matching on names.
const referenceSchemas = new WeakSet<z.ZodType>();

/**
 * Whether a schema was produced by `ref` — i.e. whether the field it describes
 * is identity-shaped and therefore exempt from the declared-default rule.
 */
export function isReference(schema: z.ZodType): boolean {
  return referenceSchemas.has(schema);
}

/**
 * Schema helper for a typed foreign-key reference. A reference is the string id
 * of a document in another collection, conventionally prefixed (e.g. a `user`
 * reference looks like `user_a1b2c3`). Declaring foreign keys with `ref` means
 * they are validated at the Zod gate alongside the rest of the document, and a
 * malformed reference fails loudly on the way in rather than dangling silently.
 *
 * The reference is identity-shaped (it points at another row's primary key), so
 * it carries no default and must be supplied at creation.
 *
 * @example
 *   const PostSchema = z.object({
 *     id: ref("post"),
 *     authorId: ref("user"),
 *     title: z.string().default(""),
 *   });
 */
export function ref(prefix: string): z.ZodString {
  if (prefix.length === 0) {
    throw new Error("ref(prefix): prefix must not be empty");
  }
  const schema = z
    .string()
    .startsWith(`${prefix}_`, `must be a "${prefix}" reference (expected "${prefix}_…")`);
  referenceSchemas.add(schema);
  return schema;
}
