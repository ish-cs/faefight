/**
 * Chat commands: a line starting with "/" is handled locally and never sent as chat.
 * Pure parsing; main.ts / the lobby decide what each command does for this player.
 */

export type CommandName = 'spectate' | 'help';

export type Command =
  | { kind: 'spectate' }
  | { kind: 'help' }
  | { kind: 'unknown'; name: string };

export const COMMANDS: readonly { name: CommandName; help: string }[] = [
  { name: 'help', help: 'list commands' },
  { name: 'spectate', help: 'host only: watch instead of playing (toggle)' },
];

/** "/spectate" → { kind: 'spectate' }; "/nope" → unknown; plain chat (or a lone "/") → null. Case-insensitive, args ignored. */
export function parseCommand(text: string): Command | null {
  const m = /^\/(\S+)/.exec(text.trim());
  if (!m) return null;
  const name = m[1].toLowerCase();
  const known = COMMANDS.find((c) => c.name === name);
  return known ? ({ kind: known.name } as Command) : { kind: 'unknown', name };
}

export const HELP_TEXT = `Commands: ${COMMANDS.map((c) => `/${c.name} — ${c.help}`).join(' · ')}`;
export const HOST_ONLY = 'Only the host can use /spectate';
export const unknownCommand = (name: string) => `Unknown command /${name}. Type /help for commands.`;
