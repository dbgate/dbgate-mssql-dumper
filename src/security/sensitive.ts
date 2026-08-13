/**
 * Option-name fragments that mark a connection/configuration value as
 * sensitive (case-insensitive substring match), used to keep secrets out of
 * diagnostics, logs, and thrown errors.
 */
const SENSITIVE_NAME_FRAGMENTS = [
  'password',
  'pwd',
  'secret',
  'token',
  'apikey',
  'api_key',
  'accesskey',
  'access_key',
  'connectionstring',
  'connection_string',
  'credential',
];

export function isSensitiveOptionName(name: string): boolean {
  const lower = name.toLowerCase();
  return SENSITIVE_NAME_FRAGMENTS.some(fragment => lower.includes(fragment));
}

/** Replaces `value` with a fixed-width placeholder, never revealing its length. */
export function redactSensitiveText(_value: string, placeholder = '***REDACTED***'): string {
  return placeholder;
}

/**
 * Redacts `value` in-place within free-form text such as an error message,
 * by literal substring replacement. Intended for values already known to be
 * sensitive (e.g. a password pulled from a connection options object), not
 * for scanning arbitrary text for secret-shaped substrings.
 */
export function redactSensitiveSubstring(
  text: string,
  value: string,
  placeholder = '***REDACTED***',
): string {
  if (value.length === 0) {
    return text;
  }
  return text.split(value).join(placeholder);
}
