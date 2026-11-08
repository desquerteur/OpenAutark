// The one vocabulary of B-041 (My day · Work · Chats · Projects · Team): the names of the main destinations, in
// rail and phone-tab order, My day's group names and Work's two regions (B-078), so every view says the same thing
// ("Needs you" means waiting on the person, everywhere). Labels only: route keys and identifiers stay as
// they are (the workspace tab 'foryou', `.for-you`, forYouCount).
// Owns: these UI words. Never: logic, routes or anything a view decides with them.

/** The main destinations' keys. 'home' is only a route alias of My day (no rail entry or tab of its own). */
export type NavKey = 'home' | 'day' | 'tasks' | 'chats' | 'projects' | 'team';

/** The main destinations by nav key, in the order of the desktop rail and the phone tabs (My day · Work · Chats · Projects · Team). */
export const DESTINATIONS: Readonly<Record<NavKey, string>> = {
  home: 'My day',
  day: 'My day',
  tasks: 'Work',
  chats: 'Chats',
  projects: 'Projects', // AF-018: the folders the person codes in
  team: 'Team',
};

/** My day's groups, top to bottom. */
export const DAY_GROUPS = {
  needsYou: 'Needs you',
  today: 'Today',
  unplanned: 'Unplanned',
  handedOff: 'Handed off',
  later: 'Later',
} as const;
export type DayGroupKey = keyof typeof DAY_GROUPS;

/** Work's two regions (B-078 D10), told apart by shape: accent cards for what needs the person, a quiet report. */
export const WORK_REGIONS = {
  forYou: 'For you',
  report: 'Report',
} as const;
