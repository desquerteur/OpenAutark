// Composition of the F-51 start path: the team pattern library with its manager tools patterns.find / patterns.load.
// Owns: this wiring. Never: behaviour.

import path from 'node:path';
import type { RuntimeServices } from '../contracts.ts';
import '../contracts/team-start.ts';
import { PatternLibrary } from '../patterns/library.ts';
import { patternTools } from '../patterns/tools.ts';

export function createTeamStart(s: RuntimeServices, services: () => RuntimeServices): void {
  s.patterns = new PatternLibrary({ services, dir: path.join(s.paths.resources, 'patterns') });
  for (const tool of patternTools(s.patterns)) s.tools.register(tool);
}
