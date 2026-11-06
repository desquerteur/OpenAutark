// The plans' short names in the rail (B-078, D17 – owner 06.11.2026: "standardmäßig … von der E-Mail-Adresse, wie die vor dem
// @-Zeichen heißt; wenn das erste Wort vor dem @ bei mehreren Plänen gleich ist und nur nach dem Punkt etwas unterschiedlich,
// nehmen wir das nach dem Punkt"). One rule for every plan:
//   a label the person gave the plan wins (not the provider's default name or "<default> 2");
//   else the e-mail's local part ("alex.work@…" → "alex.work");
//   if two or more plans share the local part's first word before the dot, each shows the part after the dot ("work",
//   "private") – or its whole local part when it has no dot;
//   with no e-mail, the label.
// Owns: that rule. Never: reads accounts or settings (accounts/monitor.ts passes them), or shows the domain of an e-mail.

export interface PlanNameInput {
  id: string;
  provider: string;
  label: string;
  email?: string;
}

/** "<default>" or "<default> 2": the label the app gave the plan, not one of the person's own. */
export function isDefaultLabel(label: string, defaultLabel: string | undefined): boolean {
  const value = label.trim();
  if (!value) return true;
  if (!defaultLabel) return false;
  if (value === defaultLabel) return true;
  return value.startsWith(`${defaultLabel} `) && /^\d+$/.test(value.slice(defaultLabel.length + 1));
}

function localPart(email: string | undefined): string | undefined {
  const value = email?.trim();
  if (!value) return undefined;
  const at = value.indexOf('@');
  const local = (at < 0 ? value : value.slice(0, at)).trim();
  return local || undefined;
}

/** The first word of a local part (before its first dot). */
const firstWord = (local: string): string => local.split('.')[0].toLowerCase();

/**
 * Name per plan id. `defaults`: the provider's default label (accounts/service-shape.ts PROVIDER_LABELS), so "Codex 2" counts
 * as the app's and the e-mail names the plan.
 */
export function planNames(plans: readonly PlanNameInput[], defaults: Readonly<Partial<Record<string, string>>> = {}): Map<string, string> {
  const out = new Map<string, string>();
  const byEmail: Array<{ id: string; local: string }> = [];
  for (const plan of plans) {
    if (!isDefaultLabel(plan.label, defaults[plan.provider])) { out.set(plan.id, plan.label.trim()); continue; }
    const local = localPart(plan.email);
    if (local) byEmail.push({ id: plan.id, local });
    else out.set(plan.id, plan.label.trim() || defaults[plan.provider] || plan.provider);
  }
  const counts = new Map<string, number>();
  for (const entry of byEmail) counts.set(firstWord(entry.local), (counts.get(firstWord(entry.local)) ?? 0) + 1);
  for (const entry of byEmail) {
    const shared = (counts.get(firstWord(entry.local)) ?? 0) > 1;
    const dot = entry.local.indexOf('.');
    out.set(entry.id, shared && dot >= 0 && dot < entry.local.length - 1 ? entry.local.slice(dot + 1) : entry.local);
  }
  return out;
}
