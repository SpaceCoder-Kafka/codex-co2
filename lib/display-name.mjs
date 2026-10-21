// Display labels are not authenticated account identities.
export function displayName(value) {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  const name = value.trim();
  return name && [...name].length <= 40 ? name : null;
}
