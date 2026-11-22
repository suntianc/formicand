/** A protocol outcome a caller may branch on instead of matching prose. */
export class ManagementClientError extends Error {
  constructor(message, { code, status, network = false, stale = false, operationId } = {}) {
    super(message);
    this.name = "ManagementClientError";
    this.code = code;
    this.status = status;
    this.network = network;
    this.stale = stale;
    if (operationId) this.operationId = operationId;
  }
}
