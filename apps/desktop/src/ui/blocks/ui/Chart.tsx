// `chart` block: renders the geometry from chart-svg.ts as inline SVG with token colors,
// gridlines, thinned x labels and a legend. Hover shows native <title> tooltips.
// Owns: chart markup. Never: animation, external fonts or a charting library.

import type { UiBlock } from '../../../shared/blocks/catalog.ts';
import { buildChart } from './chart-svg.ts';
import type { ChartInput } from './chart-svg.ts';
import { s } from './util.ts';

const color = (series: number) => `var(--wf-c${(series % 6) + 1})`;

export function Chart(props: { block: UiBlock }) {
  const b = props.block;
  const input: ChartInput = {
    kind: (s(b.kind) || 'bar') as ChartInput['kind'],
    data: Array.isArray(b.data) ? (b.data as Array<Record<string, unknown>>) : [],
    x: s(b.x),
    y: Array.isArray(b.y) ? (b.y as string[]) : [s(b.y)],
    stacked: b.stacked === true,
  };
  const unit = s(b.unit);
  const shortUnit = unit.length <= 3 ? unit : '';
  const model = buildChart(input, shortUnit);
  const donut = input.kind === 'donut';
  const label = `${s(b.title) || 'Chart'} (${input.kind})`;
  return (
    <figure class={`b-chart kind-${input.kind}`}>
      {b.title && <div class="b-title">{b.title}</div>}
      <div class={donut ? 'b-chart-donut' : 'b-chart-plot'}>
        <svg viewBox={`0 0 ${donut ? 220 : model.width} ${model.height}`} role="img" aria-label={label} preserveAspectRatio="xMidYMid meet">
          {!donut && model.grid.map((g, i) => (
            <g key={`g${i}`}>
              <line x1={model.plot.left} x2={model.plot.right} y1={g.y} y2={g.y} class="b-chart-grid" />
              <text x={model.plot.left - 6} y={g.y + 3.5} text-anchor="end" class="b-chart-tick">{g.label}</text>
            </g>
          ))}
          {model.shapes.map((shape, i) => {
            if (shape.el === 'rect') {
              return <rect key={i} x={shape.x} y={shape.y} width={shape.w} height={Math.max(0, shape.h)} rx={2} fill={color(shape.series)}><title>{shape.title}</title></rect>;
            }
            if (shape.el === 'circle') {
              return <circle key={i} cx={shape.cx} cy={shape.cy} r={shape.r} fill={color(shape.series)}><title>{shape.title}</title></circle>;
            }
            if (shape.fill) {
              return (
                <path key={i} d={shape.d} fill={color(shape.series)} fill-opacity={donut ? 1 : 0.16}
                  stroke={donut ? 'var(--wf-bg)' : 'none'} stroke-width={donut ? 1.5 : 0}>
                  {shape.title && <title>{shape.title}</title>}
                </path>
              );
            }
            return <path key={i} d={shape.d} fill="none" stroke={color(shape.series)} stroke-width={2} stroke-linejoin="round" stroke-linecap="round" />;
          })}
          {!donut && model.xLabels.map((x, i) => (
            <text key={`x${i}`} x={x.x} y={model.height - 8} text-anchor="middle" class="b-chart-tick">
              {x.label.length > 12 ? `${x.label.slice(0, 11)}…` : x.label}
            </text>
          ))}
        </svg>
        {model.legend.length > 0 && (
          <ul class="b-chart-legend">
            {model.legend.map(entry => (
              <li key={entry.series}>
                <span class="b-swatch" style={{ background: color(entry.series) }} />
                <span>{entry.label}</span>
                {entry.value && <span class="muted tabular">{entry.value}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>
      {unit && !shortUnit && <figcaption class="muted">{unit}</figcaption>}
    </figure>
  );
}
