/** A rollup endpoint. The URL never carries a credential: the TEE token travels in an Authorization header (the real TEE honors Bearer, observed) and is held in a non-enumerable slot,
 *  so printing, JSON.stringify, string interpolation and util.inspect of an endpoint show only the bare URL. Everything that takes a "url" accepts a string or an Endpoint. */
const SLOT_TOKEN = Symbol("tee-token");
export class Endpoint {
  constructor(url, token = null) { this.url = url; Object.defineProperty(this, SLOT_TOKEN, { value: token, enumerable: false }); }
  headers() { const t = this[SLOT_TOKEN]; return t ? { Authorization: `Bearer ${t}` } : {}; }
  toString() { return this.url; } toJSON() { return this.url; } [Symbol.for("nodejs.util.inspect.custom")]() { return `Endpoint(${this.url})`; }
}
