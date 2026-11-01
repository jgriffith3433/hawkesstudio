// When this Studio last answered a request that came from outside (server.ts notes each one). The lease's heartbeat
// carries it (cloudlease.ts): a holder Cloud Run stopped sending requests to keeps running, and this is how the next
// instance can tell. Its own module, so server.ts doesn't load the lease's Cloud Storage code to note a request.
let at = Date.now();
export const noteServed = (when = Date.now()) => { at = when; };
export const lastServed = () => at;
