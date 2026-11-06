// Tiny chart geometry for the `chart` block (bar, line, area, donut, scatter): pure math that
// turns validated data into SVG primitives. No expression language, no network, no animation
// (web-genui §2.12: own renderer instead of Vega). Colors are --wf-c1..6 tokens.
// Owns: scales, nice ticks, shapes. Never: touches the DOM (Chart.tsx renders the result).

export interface ChartInput {
  kind: 'bar' | 'line' | 'area' | 'donut' | 'scatter';
  data: Array<Record<string, unknown>>;
  x: string;
  y: string[];
  stacked?: boolean;
}

export type Shape =
  | { el: 'rect'; x: number; y: number; w: number; h: number; series: number; title: string }
  | { el: 'path'; d: string; series: number; fill: boolean; title?: string }
  | { el: 'circle'; cx: number; cy: number; r: number; series: number; title: string };

export interface ChartModel {
  width: number;
  height: number;
  shapes: Shape[];
  grid: Array<{ y: number; label: string }>;
  xLabels: Array<{ x: number; label: string }>;
  legend: Array<{ label: string; series: number; value?: string }>;
  plot: { left: number; right: number; top: number; bottom: number };
}

const W = 560;
const H = 220;
const PAD = { left: 44, right: 12, top: 10, bottom: 26 };

/** "Nice" tick step for a range (1, 2, 2.5, 5 × 10^n). */
export function niceStep(range: number, ticks = 4): number {
  if (!(range > 0)) return 1;
  const raw = range / ticks;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const nice = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
  return nice * power;
}

export function formatNumber(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${+(value / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `${+(value / 1e6).toFixed(1)}M`;
  if (abs >= 1e4) return `${+(value / 1e3).toFixed(1)}k`;
  return `${+value.toFixed(abs < 1 && abs > 0 ? 2 : 1)}`;
}

const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

function domain(values: number[]): { min: number; max: number; step: number } {
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) max = min + 1;
  const step = niceStep(max - min);
  min = Math.floor(min / step) * step;
  max = Math.ceil(max / step) * step;
  return { min, max, step };
}

function thin<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  const every = Math.ceil(list.length / max);
  return list.filter((_, i) => i % every === 0);
}

export function buildChart(input: ChartInput, unit = ''): ChartModel {
  const plot = { left: PAD.left, right: W - PAD.right, top: PAD.top, bottom: H - PAD.bottom };
  const model: ChartModel = { width: W, height: H, shapes: [], grid: [], xLabels: [], legend: [], plot };
  const { data, y } = input;
  if (input.kind === 'donut') return donut(input, unit, model);

  const stacked = input.stacked === true && (input.kind === 'bar' || input.kind === 'area');
  const totals = data.map(row => y.reduce((sum, key) => sum + num(row[key]), 0));
  const values = stacked ? totals.concat(0) : data.flatMap(row => y.map(key => num(row[key])));
  const dom = domain(values);
  const yOf = (v: number) => plot.bottom - ((v - dom.min) / (dom.max - dom.min)) * (plot.bottom - plot.top);
  for (let v = dom.min; v <= dom.max + dom.step / 2; v += dom.step) model.grid.push({ y: yOf(v), label: formatNumber(v) + unit });
  model.legend = y.length > 1 ? y.map((label, series) => ({ label, series })) : [];

  if (input.kind === 'scatter') {
    const xs = data.map(row => num(row[input.x]));
    const xd = domain(xs);
    const xOf = (v: number) => plot.left + ((v - xd.min) / (xd.max - xd.min)) * (plot.right - plot.left);
    for (let v = xd.min; v <= xd.max + xd.step / 2; v += xd.step) model.xLabels.push({ x: xOf(v), label: formatNumber(v) });
    data.forEach((row, i) => y.forEach((key, series) => model.shapes.push({
      el: 'circle', cx: xOf(xs[i]), cy: yOf(num(row[key])), r: 3.5, series, title: `${formatNumber(xs[i])}, ${formatNumber(num(row[key]))}${unit}`,
    })));
    return model;
  }

  const n = Math.max(1, data.length);
  const band = (plot.right - plot.left) / n;
  const center = (i: number) => plot.left + band * i + band / 2;
  model.xLabels = thin(data.map((row, i) => ({ x: center(i), label: String(row[input.x] ?? '') })), 8);

  if (input.kind === 'bar') {
    const groupWidth = Math.min(band * 0.72, 64);
    data.forEach((row, i) => {
      let base = 0;
      y.forEach((key, series) => {
        const v = num(row[key]);
        const title = `${String(row[input.x] ?? '')}${y.length > 1 ? ` · ${key}` : ''}: ${formatNumber(v)}${unit}`;
        if (stacked) {
          const top = yOf(base + v);
          model.shapes.push({ el: 'rect', x: center(i) - groupWidth / 2, y: Math.min(top, yOf(base)), w: groupWidth, h: Math.abs(yOf(base) - top), series, title });
          base += v;
        } else {
          const w = groupWidth / y.length;
          const top = yOf(Math.max(v, 0));
          model.shapes.push({ el: 'rect', x: center(i) - groupWidth / 2 + series * w + 1, y: top, w: Math.max(1, w - 2), h: Math.abs(yOf(0) - yOf(v)), series, title });
        }
      });
    });
    return model;
  }

  // line / area
  const baseline = data.map(() => 0);
  y.forEach((key, series) => {
    const tops = data.map((row, i) => (stacked ? baseline[i] + num(row[key]) : num(row[key])));
    const points = tops.map((v, i) => `${center(i).toFixed(1)},${yOf(v).toFixed(1)}`);
    if (input.kind === 'area') {
      const bottoms = data.map((_, i) => `${center(i).toFixed(1)},${yOf(stacked ? baseline[i] : Math.max(dom.min, 0)).toFixed(1)}`).reverse();
      model.shapes.push({ el: 'path', d: `M${points.join('L')}L${bottoms.join('L')}Z`, series, fill: true });
    }
    model.shapes.push({ el: 'path', d: `M${points.join('L')}`, series, fill: false, title: key });
    if (data.length <= 40) {
      tops.forEach((v, i) => model.shapes.push({ el: 'circle', cx: center(i), cy: yOf(v), r: 2.5, series, title: `${String(data[i][input.x] ?? '')}: ${formatNumber(num(data[i][key]))}${unit}` }));
    }
    if (stacked) tops.forEach((v, i) => { baseline[i] = v; });
  });
  return model;
}

function donut(input: ChartInput, unit: string, model: ChartModel): ChartModel {
  const key = input.y[0];
  const values = input.data.map(row => Math.max(0, num(row[key])));
  const total = values.reduce((a, b) => a + b, 0) || 1;
  const cx = 110;
  const cy = model.height / 2;
  const r = 86;
  const inner = 54;
  let angle = -Math.PI / 2;
  const point = (radius: number, a: number) => `${(cx + radius * Math.cos(a)).toFixed(2)},${(cy + radius * Math.sin(a)).toFixed(2)}`;
  values.forEach((v, i) => {
    const slice = (v / total) * Math.PI * 2;
    if (slice <= 0) return;
    const end = angle + Math.min(slice, Math.PI * 2 - 1e-4); // a full circle needs a tiny gap
    const large = slice > Math.PI ? 1 : 0;
    const d = `M${point(r, angle)}A${r},${r} 0 ${large} 1 ${point(r, end)}L${point(inner, end)}A${inner},${inner} 0 ${large} 0 ${point(inner, angle)}Z`;
    const label = String(input.data[i][input.x] ?? '');
    const share = Math.round((v / total) * 100);
    model.shapes.push({ el: 'path', d, series: i, fill: true, title: `${label}: ${formatNumber(v)}${unit} (${share} %)` });
    model.legend.push({ label, series: i, value: `${share} %` });
    angle = end;
  });
  return model;
}
