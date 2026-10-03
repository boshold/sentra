export function boom(input: number): number {
  const doubled = input * 2;
  throw new Error("nitro boom " + doubled);
}
