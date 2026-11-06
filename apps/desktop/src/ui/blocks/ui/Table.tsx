// `table` block: tabular data. Shows 20 rows, "Show all N" for the rest (≤ 200 after parse).
// Below 480 px the CSS turns rows into stacked label/value cards (container query).
// Owns: table rendering. Never: internal scrolling on phones (no nested scroll traps).

import { useState } from 'preact/hooks';
import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import { Inline } from '../markdown.tsx';
import { items, s } from './util.ts';

const FIRST_PAGE = 20;

export function Table(props: { block: UiBlock }) {
  const [all, setAll] = useState(false);
  const columns = items(props.block.columns);
  const rows = Array.isArray(props.block.rows) ? (props.block.rows as unknown[][]) : [];
  const shown = all ? rows : rows.slice(0, FIRST_PAGE);
  const truncated = typeof props.block.truncated === 'number' ? props.block.truncated : undefined;
  const hasHeader = columns.some(col => s(col.label));
  return (
    <div class="b-table">
      {props.block.title && <div class="b-title">{props.block.title}</div>}
      <table>
        {props.block.caption !== undefined && <caption>{s(props.block.caption)}</caption>}
        {hasHeader && (
          <thead>
            <tr>{columns.map((col, i) => <th key={i} scope="col" class={col.align ? `align-${s(col.align)}` : undefined}>{s(col.label)}</th>)}</tr>
          </thead>
        )}
        <tbody>
          {shown.map((row, r) => (
            <tr key={r}>
              {columns.map((col, c) => (
                <td key={c} data-label={s(col.label)} class={col.align ? `align-${s(col.align)}` : isNumeric(row[c]) ? 'align-right' : undefined}>
                  <Inline text={s(row[c])} />
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {(rows.length > FIRST_PAGE || truncated) && (
        <div class="b-table-foot">
          {rows.length > FIRST_PAGE && (
            <button type="button" class="text-button" onClick={() => setAll(!all)}>
              {all ? 'Show less' : `Show all ${rows.length}`}
            </button>
          )}
          {truncated && <span class="muted"> {rows.length} of {truncated} rows</span>}
        </div>
      )}
    </div>
  );
}

function isNumeric(value: unknown): boolean {
  return typeof value === 'string' && /^[+-]?[\d.,\s]+%?$/.test(value.trim()) && /\d/.test(value);
}
