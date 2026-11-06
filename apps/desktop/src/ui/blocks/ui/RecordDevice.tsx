// Camera or microphone choice in the record widget's ready state (F07): a compact Select, shown
// only when more than one device is connected (P25), with a quiet "New camera found" while a
// camera that was just plugged in is the pre-selected one (media-devices.ts).
// Owns: that select. Never: opens streams or stores the choice (recorder.ts and
// media-devices.ts do).

import { Select } from '../../lib/ui.tsx';
import type { CaptureMode, DeviceChoice } from './media-devices.ts';

export function RecordDevice(props: { mode: CaptureMode; choice: DeviceChoice; onChoose: (id: string) => void }) {
  const { devices, selected, added } = props.choice;
  if (devices.length < 2) return null;
  return (
    <span class="w-record-device">
      {added && added === selected && <span class="w-record-device-note" role="status">New camera found</span>}
      <Select class="w-record-select" label={props.mode === 'audio' ? 'Microphone' : 'Camera'} value={selected ?? ''}
        placeholder="System default" options={devices.map((device) => ({ value: device.id, label: device.label }))} onChange={props.onChoose} />
    </span>
  );
}
