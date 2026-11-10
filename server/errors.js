// Action errors shared by the reducers (browser-safe).
export class ActionError extends Error {
  constructor(code, msg) {
    super(msg);
    this.code = code;
  }
}

export const bad = (msg) => new ActionError('bad_request', msg);
export const notFound = (msg) => new ActionError('not_found', msg);
export const forbidden = (msg) => new ActionError('forbidden', msg);
