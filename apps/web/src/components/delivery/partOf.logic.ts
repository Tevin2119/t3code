import type { DeliveryCard } from "../../lib/delivery";

type PartOf = NonNullable<DeliveryCard["partOf"]>;

/**
 * The whole a part belongs to, by what the engine knows of it. A part that came from another
 * engine without its parent may know neither its number nor its title: then it is named by none.
 */
export function wholeName(partOf: PartOf): string | null {
  const number = partOf.number === null ? null : `#${partOf.number}`;
  const title = partOf.title?.trim() || null;
  return number && title ? `${number} ${title}` : (number ?? title);
}

/**
 * A part is reviewed as a part only while its whole is on this engine (`partOf.here`, which the
 * engine works out). Elsewhere it is decided as a task of its own.
 */
export const reviewedAsPart = (card: Pick<DeliveryCard, "partOf"> | null) =>
  card?.partOf?.here === true;
