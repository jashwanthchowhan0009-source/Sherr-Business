/** Errors that are safe to show a user. Everything else surfaces as a generic message. */
export class AppError extends Error {
  constructor(
    message: string,
    readonly code:
      | 'unauthenticated'
      | 'no_organization'
      | 'mfa_required'
      | 'forbidden'
      | 'not_found'
      | 'invalid_input'
      | 'rate_limited'
      | 'conflict'
      | 'screen_locked',
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const unauthenticated = () =>
  new AppError('You are not signed in.', 'unauthenticated');
export const noOrganization = () =>
  new AppError('Select a company to continue.', 'no_organization');
export const mfaRequired = () =>
  new AppError('Two-factor authentication is required.', 'mfa_required');
export const forbidden = (what: string) =>
  new AppError(`You do not have permission to ${what}.`, 'forbidden');
export const notFound = (what: string) => new AppError(`${what} not found.`, 'not_found');
export const rateLimited = () =>
  new AppError('Too many requests. Try again shortly.', 'rate_limited');
export const conflict = (message: string) => new AppError(message, 'conflict');

export const invalidInput = (message: string) => new AppError(message, 'invalid_input');

/** The six-digit screen lock is on. The caller must enter it again. */
export const screenLocked = () =>
  new AppError('Enter your PIN to continue.', 'screen_locked');
