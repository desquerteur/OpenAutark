// Owns: honoring a selected capture device, with one fallback if it is missing or unsupported.
// Never: retries permission denials or device-in-use errors; the caller arms and opens devices.

export async function openMediaStream<T>(open: (constraints: MediaStreamConstraints) => Promise<T>, constraints: MediaStreamConstraints): Promise<T> {
  try { return await open(constraints); } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name !== 'OverconstrainedError' && name !== 'NotFoundError') throw error;
    let selected = false;
    const defaults = (value: boolean | MediaTrackConstraints | undefined) => {
      if (!value || typeof value !== 'object' || !value.deviceId) return value;
      selected = true;
      const { deviceId: _id, ...rest } = value;
      return rest;
    };
    const fallback = { ...constraints, audio: defaults(constraints.audio), video: defaults(constraints.video) };
    if (!selected) throw error;
    return open(fallback);
  }
}
