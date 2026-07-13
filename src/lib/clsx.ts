type ClassValue = string | number | boolean | null | undefined;

/**
 * Minimal className joiner. Filters out falsy values.
 * Avoids pulling in a dependency for something this small.
 */
export function clsx(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(" ");
}
