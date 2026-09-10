export class BrokerError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code }
}
