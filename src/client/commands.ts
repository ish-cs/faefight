/**
 * Chat commands: a line starting with "/" is handled locally and never sent as chat.
 * Pure parsing; main.ts / the lobby decide what each command does for this player.
 */

export type CommandName = 'spectate' | 'help' | 'money';

export type Command =
  | { kind: 'spectate' }
  | { kind: 'help' }
  /** amount null: missing or invalid argument (show MONEY_USAGE). */
  | { kind: 'money'; amount: number | null }
  | { kind: 'unknown'; name: string };

/** Most cash one /money can grant. */
export const MONEY_MAX = 100_000;

export const COMMANDS: readonly { name: CommandName; help: string }[] = [
  { name: 'help', help: 'list commands' },
  { name: 'spectate', help: 'host only: watch instead of playing (toggle)' },
  { name: 'money', help: 'host only: give yourself cash in a match' },
];

/** "500" → 500; anything but a whole number in 1..MONEY_MAX → null. */
export function parseMoney(arg: string | undefined): number | null {
  if (!arg || !/^\d+$/.test(arg)) return null;
  const n = Number(arg);
  return n >= 1 && n <= MONEY_MAX ? n : null;
}

/** "/spectate" → { kind: 'spectate' }; "/nope" → unknown; plain chat (or a lone "/") → null. Case-insensitive; only /money reads an argument. */
export function parseCommand(text: string): Command | null {
  const m = /^\/(\S+)(?:\s+(.*))?$/.exec(text.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  if (name === 'money') return { kind: 'money', amount: m[2]?.includes(' ') ? null : parseMoney(m[2]) };
  const known = COMMANDS.find((c) => c.name === name);
  return known ? ({ kind: known.name } as Command) : { kind: 'unknown', name };
}

export const HELP_TEXT = `Commands: ${COMMANDS.map((c) => `/${c.name} — ${c.help}`).join(' · ')}`;
export const HOST_ONLY = 'Only the host can use /spectate';
export const MONEY_HOST_ONLY = 'Only the host can use /money';
export const MONEY_USAGE = `Usage: /money <amount> (whole number, 1 to ${MONEY_MAX})`;
export const MONEY_NOT_IN_MATCH = '/money only works during a match';
export const moneyGiven = (amount: number) => `+$${amount} (host command)`;
export const unknownCommand = (name: string) => `Unknown command /${name}. Type /help for commands.`;
