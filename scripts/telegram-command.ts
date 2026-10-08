export function parseTelegramCommand(text: string): { name: string; arg: string } {
  const [rawName, ...rest] = text.trim().split(/\s+/);
  return {
    name: (rawName ?? '').split('@', 1)[0]!.toLowerCase(),
    arg: rest.join(' '),
  };
}
