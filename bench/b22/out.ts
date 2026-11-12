export const out = (...parts: unknown[]): void => {
  process.stdout.write(`${parts.join(' ')}\n`)
}
