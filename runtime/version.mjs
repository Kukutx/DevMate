export const VERSION = '4.0.6';
// Identifies the code a running runtime was started from. A host that ships a
// different build offers to restart the shared runtime instead of talking to old code.
export const BUILD_ID = 'devmate-' + VERSION;
/** Whether version a is later than version b, by their three numbers. */
export function newerVersion(a, b) {
  const parts = value => String(value).split(/[.-]/).slice(0, 3).map(part => Number.parseInt(part, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let index = 0; index < 3; index++) if (x[index] !== y[index]) return x[index] > y[index];
  return false;
}
