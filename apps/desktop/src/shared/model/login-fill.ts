// "Fill login" for the person in the integrated browser (B-078 D20): the catalog's logins as a page menu lists them
// (the site's registrable domain first – a suggestion, never a restriction) and the one call that hands a login's
// username and password to the owner's own browser (main/workspace-fill.ts) to type into the page. Merged into
// Methods by module augmentation (methods.ts is at its size limit). Handlers: runtime/rpc/handlers/security.ts.
// Owns: these shapes. Never: behaviour, or a value anywhere but the fill answer.

/** One login of the catalog for the menu: its group id, label and the site it was saved from. */
export interface LoginChoice {
  id: string;
  label: string;
  site?: string;
  /** Saved from the page's registrable domain: listed first. */
  suggested?: true;
}

/** What the person's browser types into the page (only the fields the login has). */
export interface LoginFill { username?: string; password?: string }

declare module '../api/methods.ts' {
  interface Methods {
    /** Owner: the catalog's logins for the page at `url` (suggested first, then all by label; no values). */
    'secrets.fillChoices': { params: { url: string }; result: LoginChoice[] };
    /** Owner (the desktop's own browser): login `id`'s username and password for the page at `url`; never logged. */
    'secrets.fillLogin': { params: { id: string; url: string }; result: LoginFill };
  }
}
