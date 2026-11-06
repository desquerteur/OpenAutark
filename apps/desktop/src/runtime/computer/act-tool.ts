// computer.act: an agent operates one UI element by its ref (or a name / automation id lookup),
// or brings a window to the front – on this PC or a linked one (computer/tools.ts has the other
// computer.* tools; computer/seen.ts the facts this PC's outputs showed).
// Owns: computer.act's schema and description, how a step is summarised and its output. Never: acts without the observed name and role of its ref (the helper's precondition,
// computer/service.ts), or hides that a step may have failed.
// B-055: the step names its caller (lease.ts callerOf: the pointer lease, the agent's own refs, the
// window memory), a click travels with `motion`, and a note says when another agent worked in the
// same window lately.

import type { ToolDef } from '../tools/types.ts';
import { WorkforceError } from '../../shared/errors.ts';
import { json } from '../tools/types.ts';
import { defineTool } from '../tools/builtin/util.ts';
import type { ActExpectation, ComputerService, ElementAction } from './service.ts';
import { deviceAction, onThisPc, type RefLabels, type WindowApps } from './seen.ts';
import { judgeTyped, typedText } from '../secrets/handles.ts';
import { callerOf } from './lease.ts';
import { MOTION_ARG } from './tool-notes.ts';
import type { MotionStyle } from '../../shared/model/pointer-motion.ts';

const INT = { type: 'integer' };
/** Steps that can bring another window to the front. */
const ACTIVATING: ReadonlySet<string> = new Set(['invoke', 'click', 'double_click', 'right_click', 'select', 'toggle']);

const ELEMENT_ACTIONS: ElementAction[] = [
  'invoke', 'set_value', 'toggle', 'expand', 'collapse', 'select', 'scroll_into_view', 'scroll', 'focus',
  'click', 'double_click', 'right_click', 'window_close', 'window_minimize', 'window_maximize', 'window_restore',
];

type ActArgs = { ref?: string; window?: number; name?: string; automationId?: string; role?: string; action: ElementAction | 'focus_window'; value?: string; expect?: ActExpectation; motion?: MotionStyle };

/** computer.act over the facts it shares with the other computer tools (tools.ts computerTools). */
export function actTool(computer: ComputerService, refLabels: RefLabels, apps: WindowApps): ToolDef {
  return defineTool<ActArgs>({
    name: 'computer.act',
    description: 'Act on a UI element by its ref from computer.ui_tree (semantic, verified): invoke a button, set_value of a field, toggle, expand/collapse, select, scroll, focus, or click it. Prefer pattern actions (invoke, toggle, select, set_value): they need no mouse, so they also run while the person or another agent uses it. It acts when the element still matches what I observed. Add expect to verify the result. action focus_window brings window (id) to the front.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', maxLength: 20 },
        window: { ...INT, description: 'window id (needed for focus_window or when using name/automationId)' },
        name: { type: 'string', maxLength: 200 },
        automationId: { type: 'string', maxLength: 200 },
        role: { type: 'string', maxLength: 40 },
        action: { type: 'string', enum: [...ELEMENT_ACTIONS, 'focus_window'] },
        value: { type: 'string', maxLength: 10_000, description: "set_value text; toggle 'on'/'off'; scroll up/down/left/right/page_up/page_down" },
        expect: {
          type: 'object',
          description: 'postcondition checked after the action',
          properties: {
            value: { type: 'string' }, toggle: { type: 'string', enum: ['on', 'off'] }, expanded: { type: 'boolean' },
            selected: { type: 'boolean' }, gone: { type: 'boolean' }, window: { type: 'string', description: 'a window whose title contains this is open' },
          },
          additionalProperties: false,
        },
        motion: MOTION_ARG,
      },
      required: ['action'],
      additionalProperties: false,
    },
    category: 'device', remote: true, requires: 'device',
    describe: (args, ctx) => {
      const step = `${args.action.replace(/_/g, ' ')} ${args.ref ? `element ${args.ref}` : args.name ? `"${args.name}"` : args.window !== undefined ? `window ${args.window}` : 'element'}`;
      const here = onThisPc(ctx);
      const label = args.ref && here ? refLabels.get(args.ref) : undefined;
      // A ref belongs to the window it was shown in; never guess the front window for it.
      const app = here ? apps.app(args.ref ? refLabels.window(args.ref) : args.window ?? apps.front) : undefined;
      const action = deviceAction(`${step}${label ? ` (${label})` : ''}`, ctx, false, app);
      return judgeTyped(ctx, action, args.action === 'set_value' ? args.value : undefined);
    },
    async run(args, ctx) {
      if (args.action === 'focus_window') {
        if (args.window === undefined) throw new WorkforceError('bad_request', 'focus_window needs window (an id from computer.windows).');
        ctx.status('bringing a window to the front');
        const result = await computer.focusWindow(args.window, ctx.signal, callerOf(ctx));
        if (onThisPc(ctx)) apps.front = result.focused ? args.window : undefined;
        return json({ focused: result.focused, note: result.focused ? undefined : 'Windows did not bring it to the front; the person may need to click it.', shared: result.shared });
      }
      ctx.status(`${args.action.replace(/_/g, ' ')} ${args.ref ?? args.name ?? ''}`.trim());
      const hwnd = args.ref ? refLabels.window(args.ref) : args.window;
      // A step that can bring another window to the front forgets the front window (tools.ts "Resource").
      if (ACTIVATING.has(args.action) || args.action.startsWith('window_')) apps.front = undefined;
      const typed = args.action === 'set_value' && args.value !== undefined ? await typedText(ctx, args.value) : undefined;
      const result = await computer.act({ ...args, ...(typed ? { value: typed.text } : {}), action: args.action, signal: ctx.signal, caller: callerOf(ctx) });
      refLabels.learn(result.after, hwnd);
      const lines = [`${result.action} → ${result.target}: done.`];
      if (result.note) lines.push(result.note);
      if (result.shared) lines.push(result.shared);
      lines.push(result.exists ? `Now: ${result.after ?? '(state unreadable)'}` : 'The element is gone now.');
      if (result.foreground) lines.push(`Window in front: "${result.foreground}"`);
      if (result.checks.length) lines.push(`Verification: ${result.verified ? 'passed' : 'FAILED'}\n${result.checks.join('\n')}`);
      else lines.push('Not verified – I check the result (computer.ui_tree) before the next step.');
      // A typed secret: what the step reads back is masked, and the raw element state is not passed on (secrets/handles.ts).
      return typed
        ? { content: [{ type: 'text', text: typed.mask(lines.join('\n')) }], isError: result.verified === false ? true : undefined }
        : { content: [{ type: 'text', text: lines.join('\n') }], isError: result.verified === false ? true : undefined, structured: result };
    },
  });
}
