/**
 * Who may see and do what in the panel.
 *
 * Every login has a ROLE:
 *   owner  — every screen, plus Team: makes logins and sets what others see.
 *   editor — the screens the owner gives them, and may act on them: make
 *            pendants, download production files, reset a customer's tries.
 *   viewer — the screens the owner gives them, to look at only. Never the
 *            pendant tool, which spends money on every sketch.
 *
 * and, for editors and viewers, a list of SCREENS. Account is everyone's.
 * The pendant tool (../lib/signed-in.ts at the repo root) applies the same
 * rule for Create a pendant.
 */

export type Role = 'owner' | 'editor' | 'viewer';
export type Screen = 'generate' | 'designs' | 'overview' | 'customers' | 'revenue';

export const ROLES: { value: Role; label: string; hint: string }[] = [
  { value: 'owner', label: 'Owner', hint: 'Every screen, and manages the team' },
  { value: 'editor', label: 'Editor', hint: 'Chosen screens; can make pendants and change things' },
  { value: 'viewer', label: 'Viewer', hint: 'Chosen screens, to look at only' },
];

/** In the order the menu shows them. */
export const SCREENS: { key: Screen; href: string; label: string }[] = [
  { key: 'generate', href: '/generate', label: 'Create a pendant' },
  { key: 'designs', href: '/generations', label: 'Designs' },
  { key: 'overview', href: '/', label: 'Dashboard' },
  { key: 'customers', href: '/customers', label: 'Customers and tries' },
  { key: 'revenue', href: '/revenue', label: 'Revenue' },
];

export interface Member {
  id: string;
  email: string;
  name: string;
  role: Role;
  screens: Screen[];
  mustChangePassword: boolean;
}

export function toRole(value: unknown): Role {
  return value === 'owner' || value === 'editor' ? value : 'viewer';
}

/** Screens as stored: a comma-separated list. Unknown names are dropped. */
export function toScreens(value: unknown): Screen[] {
  const known = new Set(SCREENS.map((s) => s.key));
  return (typeof value === 'string' ? value.split(',') : []).map((s) => s.trim()).filter((s): s is Screen => known.has(s as Screen));
}

export function canSee(member: Pick<Member, 'role' | 'screens'>, screen: Screen): boolean {
  if (member.role === 'owner') return true;
  if (screen === 'generate' && member.role === 'viewer') return false;
  return member.screens.includes(screen);
}

export function canEdit(member: Pick<Member, 'role'>): boolean {
  return member.role !== 'viewer';
}

/** Where a login lands: its first screen, or Account when it has none. */
export function homeOf(member: Pick<Member, 'role' | 'screens'>): string {
  return SCREENS.find((s) => canSee(member, s.key))?.href ?? '/account';
}
